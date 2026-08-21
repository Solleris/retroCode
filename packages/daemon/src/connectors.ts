import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { kvGet, kvSet, type Db } from "./db.ts";

/**
 * Linear/Notion connectors with NO credentials in the IDE.
 *
 * The trick: the user's claude already has those MCP servers authenticated
 * (Linear and Notion show up as Connected in `claude mcp list`). A headless
 * `claude -p` with `--allowedTools` scoped to the exact tool fetches the data
 * using THAT authentication. Measured: ~15s and ~$0.04 per fetch — hence the
 * TTL cache and the "answer from cache now, refresh behind" pattern.
 *
 * It runs in ~/.retro/fetch so the fetch's own transcript does not pollute any
 * project's lens, and with CLAUDE* stripped from the env (same lesson as the
 * pty: inheriting the launcher's session poisons everything).
 */

const FETCH_CWD = join(homedir(), ".retro", "fetch");
const TTL = 10 * 60_000;

export interface LinearIssue { id: string; title: string; state: string; url: string }
export interface NotionPage { title: string; url: string }

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^CLAUDE/i.test(k)) env[k] = v;
  }
  return env;
}

export function headless(prompt: string, allowedTool: string, model = "haiku"): Promise<string> {
  mkdirSync(FETCH_CWD, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = execFile(
      join(homedir(), ".local", "bin", "claude"),
      ["-p", "--model", model, "--output-format", "json", "--max-turns", "6",
       ...(allowedTool ? ["--allowedTools", allowedTool] : [])],
      { cwd: FETCH_CWD, env: cleanEnv(), timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) { reject(new Error(String(err).slice(0, 200))); return; }
        try {
          const j = JSON.parse(stdout) as { is_error: boolean; result: string };
          if (j.is_error) { reject(new Error(String(j.result).slice(0, 200))); return; }
          resolve(j.result);
        } catch { reject(new Error("unreadable headless response")); }
      },
    );
    child.stdin?.end(prompt);
  });
}

/** Extrai o array JSON da resposta, tolerando cerca de markdown. */
function parseArray<T>(text: string): T[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { return JSON.parse(m[0]) as T[]; } catch { return []; }
}

export interface ConnectorResult<T> { items: T[]; fresh: boolean; error?: string }

async function cached<T>(
  db: Db, key: string, force: boolean, fetcher: () => Promise<T[]>,
  onRefresh: (items: T[]) => void,
): Promise<ConnectorResult<T>> {
  const hit = kvGet(db, key);
  const stale = !hit || Date.now() - hit.updatedAt > TTL;

  // Cache first, always: 15 seconds of waiting on a click is unacceptable.
  // If it is stale, the refresh runs behind and arrives as a second event.
  if (hit && (!stale || !force)) {
    if (stale || force) {
      void fetcher().then((items) => {
        kvSet(db, key, JSON.stringify(items));
        onRefresh(items);
      }).catch(() => { /* rede/MCP falhou: o cache continua valendo */ });
    }
    return { items: JSON.parse(hit.v) as T[], fresh: !stale };
  }

  try {
    const items = await fetcher();
    kvSet(db, key, JSON.stringify(items));
    return { items, fresh: true };
  } catch (e) {
    return { items: [], fresh: false, error: String(e).slice(0, 160) };
  }
}

export function fetchLinear(db: Db, force: boolean, onRefresh: (i: LinearIssue[]) => void): Promise<ConnectorResult<LinearIssue>> {
  return cached(db, "linear.assigned", force, async () => {
    const out = await headless(
      'Use the Linear MCP tool list_issues with assignee="me", orderBy=updatedAt, limit=12, '
      + 'fields=["id","title","status","statusType","url"]. Filter out anything whose statusType is completed or canceled. '
      + 'Reply with ONLY a valid JSON array, no markdown: '
      + '[{"id":"ABC-123","title":"...","state":"<status>","url":"..."}]',
      "mcp__claude_ai_Linear__list_issues",
    );
    return parseArray<LinearIssue>(out).slice(0, 12);
  }, onRefresh);
}

/**
 * The content of ONE page, as markdown, to paste into claude's composer.
 * Cached by URL: a reference page gets read several times, and each headless
 * fetch costs ~15s/$0.04.
 */
export async function fetchNotionPage(
  db: Db, url: string, title: string,
): Promise<{ markdown: string; error?: string }> {
  const key = `notion.page.${url}`;
  const hit = kvGet(db, key);
  if (hit && Date.now() - hit.updatedAt < 30 * 60_000) return { markdown: hit.v };
  try {
    const out = await headless(
      `Use the Notion MCP tool notion-fetch to read the page "${title}" (${url}). `
      + "Reply with ONLY the page content as plain markdown, no commentary of your own, no code fence around it.",
      "mcp__claude_ai_Notion__notion-fetch",
    );
    // Paste cap: a huge page would turn into a paste of hundreds of KB.
    const markdown = out.length > 16_000 ? out.slice(0, 16_000) + "\n\n[… truncated by the IDE]" : out;
    kvSet(db, key, markdown);
    return { markdown };
  } catch (e) {
    return { markdown: "", error: String(e).slice(0, 160) };
  }
}

/**
 * The content of ONE issue: description + comments, as markdown, to paste into
 * the composer. Same rationale as the Notion page: claude COULD fetch it
 * itself over MCP, but you want to READ it before sending — the content in the
 * composer lets you judge and edit the instruction before pressing enter.
 */
export async function fetchLinearIssue(
  db: Db, id: string,
): Promise<{ markdown: string; error?: string }> {
  const key = `linear.issue.${id}`;
  const hit = kvGet(db, key);
  if (hit && Date.now() - hit.updatedAt < 15 * 60_000) return { markdown: hit.v };
  try {
    const out = await headless(
      `Use the Linear MCP tools: get_issue for issue ${id} (with description) and `
      + `list_comments for it. Reply with ONLY plain markdown in this format, no commentary of your own:\n`
      + `# ${id}: <title>\n<description>\n\n## Comments\n- <author>: <text>`,
      "mcp__claude_ai_Linear__get_issue mcp__claude_ai_Linear__list_comments",
    );
    const markdown = out.length > 16_000 ? out.slice(0, 16_000) + "\n\n[… truncated by the IDE]" : out;
    kvSet(db, key, markdown);
    return { markdown };
  } catch (e) {
    return { markdown: "", error: String(e).slice(0, 160) };
  }
}

export function fetchNotion(db: Db, force: boolean, onRefresh: (p: NotionPage[]) => void): Promise<ConnectorResult<NotionPage>> {
  return cached(db, "notion.recent", force, async () => {
    const out = await headless(
      "Use the Notion MCP tool notion-list-recent-pages to list my recent pages. "
      + 'Reply with ONLY a valid JSON array, no markdown, with at most 12 items: '
      + '[{"title":"...","url":"..."}]',
      "mcp__claude_ai_Notion__notion-list-recent-pages",
    );
    return parseArray<NotionPage>(out).slice(0, 12);
  }, onRefresh);
}

import { readdirSync, statSync, openSync, readSync, closeSync, existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * THE LENS: watches this project's claude CLI sessions.
 *
 * Claude Code writes a JSONL transcript into ~/.claude/projects/<cwd-munged>/,
 * line by line, WHILE the session runs. Watching that file yields everything
 * the UI needs — files touched, todos, title, when the session is waiting on
 * you — without touching the CLI, parsing a TUI, or asking for hook setup.
 *
 * This is the product's central decision: the user's claude remains THE agent;
 * the IDE only gives structure to what it already emits.
 */

export interface ClaudeTodo { content: string; status: string }
export interface ClaudeFile { path: string; edits: number; lastAt: number }
/*
 * The session type comes from the PROTOCOL, not from here.
 *
 * There used to be a local interface with the same fields, and when the usage
 * ones (ctxTokens, costUsd, model…) entered the schema, the local copy fell
 * behind — so tsc complained about "property does not exist" on an object that
 * was correct. Re-exported because the rest of the daemon refers to this name.
 */
export type { ClaudeSession } from "@retro/protocol";
import type { ClaudeSession } from "@retro/protocol";

/** The munge rule observed in ~/.claude/projects: every non-alphanumeric becomes "-". */
export function mungeCwd(root: string): string {
  return root.replace(/[^a-zA-Z0-9]/g, "-");
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Price per million tokens, [input, output].
 *
 * The transcript does NOT carry cost — only token counts — so the figure shown
 * is estimated here and labelled with "≈" in the UI. Cache follows the standard
 * rule: reads at 0.1× input, creation at 1.25× (5min) or 2× (1h).
 * This table ages: it is the only place to correct.
 */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-fable-5": [10, 50],
  "claude-sonnet-5": [3, 15],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

function priceFor(model: string): [number, number] {
  const exact = PRICES[model.replace(/-\d{8}$/, "")];
  if (exact) return exact;
  if (/haiku/.test(model)) return [1, 5];
  if (/sonnet/.test(model)) return [3, 15];
  if (/fable|mythos/.test(model)) return [10, 50];
  return [5, 25];   // default: opus tier
}
const MAX_INITIAL_BYTES = 4 * 1024 * 1024;   // huge old sessions: tail only
const SESSION_TTL = 7 * 24 * 3600_000;       // only list the past week
const MAX_SESSIONS = 8;

interface Tracked {
  offset: number;
  session: SessionAccum;
}

class SessionAccum {
  id: string;
  title = "";
  branch = "";
  startedAt = 0;
  lastAt = 0;
  turns = 0;
  lastText = "";
  ctxTokens = 0;
  model = "";
  outTokens = 0;
  inTokens = 0;
  cacheReadTokens = 0;
  cacheCreateTokens = 0;
  costUsd = 0;
  files = new Map<string, ClaudeFile>();
  todos: ClaudeTodo[] = [];
  /** For the state heuristic: the shape of the last relevant line. */
  lastShape: "user" | "assistant-end" | "assistant-tool" | "other" = "other";

  constructor(id: string) { this.id = id; }

  ingest(line: string): void {
    let j: Record<string, unknown>;
    try { j = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const type = j["type"] as string;

    if (type === "ai-title" && typeof j["aiTitle"] === "string") { this.title = j["aiTitle"]; return; }

    // Sidechains are subagents: noise for the main lens.
    if (j["isSidechain"] === true) return;

    const ts = typeof j["timestamp"] === "string" ? Date.parse(j["timestamp"]) : 0;
    if (ts) {
      if (!this.startedAt) this.startedAt = ts;
      if (ts > this.lastAt) this.lastAt = ts;
    }
    if (typeof j["gitBranch"] === "string" && j["gitBranch"]) this.branch = j["gitBranch"];

    if (type === "user") {
      const msg = j["message"] as { content?: unknown } | undefined;
      // Only a real prompt counts as "claude's turn" — meta/caveat does not.
      if (j["isMeta"] !== true) {
        this.lastShape = "user";
        if (typeof msg?.content === "string" && !msg.content.startsWith("<")) this.turns++;
      }
      return;
    }

    if (type !== "assistant") return;
    const msg = j["message"] as {
      content?: unknown[]; stop_reason?: string; model?: string;
      usage?: {
        input_tokens?: number; output_tokens?: number;
        cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
        cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
      };
    } | undefined;

    // Context = the entire prompt of the last turn (input + cache read + cache
    // created). It is the number that decides when the session will compact —
    // and the one nobody sees until it is late.
    if (msg?.usage) {
      const u = msg.usage;
      const inT = u.input_tokens ?? 0;
      const read = u.cache_read_input_tokens ?? 0;
      const create = u.cache_creation_input_tokens ?? 0;
      const out = u.output_tokens ?? 0;

      this.ctxTokens = inT + read + create;
      this.inTokens += inT;
      this.outTokens += out;
      this.cacheReadTokens += read;
      this.cacheCreateTokens += create;

      // Synthetic models (the CLI's own local messages) are not billed.
      if (msg.model && msg.model !== "<synthetic>") {
        const [pin, pout] = priceFor(msg.model);
        const h1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        const m5 = create - h1;
        this.costUsd += (inT * pin + out * pout
          + read * pin * 0.1 + m5 * pin * 1.25 + h1 * pin * 2) / 1_000_000;
      }
    }
    if (msg?.model && msg.model !== "<synthetic>") this.model = msg.model;
    let sawTool = false;

    for (const raw of msg?.content ?? []) {
      const b = raw as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string" && (b["text"] as string).trim()) {
        this.lastText = (b["text"] as string).trim().slice(0, 240);
      }
      if (b["type"] !== "tool_use") continue;
      sawTool = true;
      const name = String(b["name"] ?? "");
      const input = (b["input"] ?? {}) as Record<string, unknown>;

      if (EDIT_TOOLS.has(name) && typeof input["file_path"] === "string") {
        const path = input["file_path"] as string;
        const f = this.files.get(path) ?? { path, edits: 0, lastAt: 0 };
        f.edits++; f.lastAt = ts || Date.now();
        this.files.set(path, f);
      }
      if (name === "TodoWrite" && Array.isArray(input["todos"])) {
        this.todos = (input["todos"] as Record<string, unknown>[]).map((t) => ({
          content: String(t["content"] ?? ""), status: String(t["status"] ?? ""),
        }));
      }
    }

    this.lastShape = sawTool ? "assistant-tool"
      : msg?.stop_reason === "end_turn" ? "assistant-end" : "other";
  }

  snapshot(now: number): ClaudeSession {
    const age = now - this.lastAt;
    /**
     * The heuristic that makes the lens worth having:
     *   user last                    → claude is working
     *   assistant end_turn           → YOUR TURN
     *   tool_use with no result >8s  → probably a permission gate
     * An age over 10min demotes everything to "idle" — a sleeping session is
     * not asking for attention.
     */
    let state: ClaudeSession["state"];
    if (age > 10 * 60_000) state = "idle";
    else if (this.lastShape === "assistant-end") state = "yourTurn";
    else if (this.lastShape === "assistant-tool" && age > 8_000) state = "maybeGate";
    else state = "working";

    /**
     * The window inferred from the model name. Imprecise by nature (the CLI may
     * run 200k on a model that supports 1M), but the error leans safe: warning
     * too early beats compacting with no warning.
     */
    const window = /haiku|-3-|4-5/.test(this.model) ? 200_000 : 1_000_000;

    return {
      id: this.id, title: this.title || "untitled session", branch: this.branch,
      state, startedAt: this.startedAt, lastAt: this.lastAt,
      ctxTokens: this.ctxTokens, ctxWindow: window, model: this.model,
      outTokens: this.outTokens, inTokens: this.inTokens,
      cacheReadTokens: this.cacheReadTokens, cacheCreateTokens: this.cacheCreateTokens,
      costUsd: this.costUsd,
      files: [...this.files.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 30),
      todos: this.todos, lastText: this.lastText, turns: this.turns,
    };
  }
}

export class ClaudeWatcher {
  #dir: string;
  #tracked = new Map<string, Tracked>();
  #watcher: FSWatcher | null = null;
  #timer: NodeJS.Timeout | null = null;
  #emit: (sessions: ClaudeSession[]) => void;
  #lastPayload = "";
  #lastSessions: ClaudeSession[] = [];

  constructor(projectRoot: string, emit: (sessions: ClaudeSession[]) => void) {
    this.#dir = join(homedir(), ".claude", "projects", mungeCwd(projectRoot));
    this.#emit = emit;
  }

  start(): void {
    this.stop();
    if (!existsSync(this.#dir)) {
      // The directory is born with the first session; watching the parent is
      // expensive, so poll lightly until it exists.
      this.#timer = setInterval(() => {
        if (existsSync(this.#dir)) this.start();
      }, 3000);
      return;
    }
    this.#scan();
    try {
      this.#watcher = watch(this.#dir, () => this.#scan());
    } catch { /* fs.watch is fragile; the poll below covers it */ }
    // A safety poll AND a re-evaluation of state by age (working→gate happens
    // with no write to the file at all — only time passing).
    this.#timer = setInterval(() => this.#scan(), 2000);
  }

  /** The current snapshot without waiting for a change — focusing a terminal
   *  in this repo needs the picture now; "nothing changed" must not mean an
   *  empty lens. */
  current(): ClaudeSession[] { return this.#lastSessions; }

  stop(): void {
    this.#watcher?.close(); this.#watcher = null;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #scan(): void {
    let names: string[];
    try { names = readdirSync(this.#dir).filter((n) => n.endsWith(".jsonl")); } catch { return; }
    const now = Date.now();

    for (const name of names) {
      const full = join(this.#dir, name);
      let size: number, mtime: number;
      try { const st = statSync(full); size = st.size; mtime = st.mtimeMs; } catch { continue; }
      if (now - mtime > SESSION_TTL) continue;

      let t = this.#tracked.get(name);
      if (!t) {
        t = { offset: size > MAX_INITIAL_BYTES ? size - MAX_INITIAL_BYTES : 0,
              session: new SessionAccum(name.replace(/\.jsonl$/, "")) };
        this.#tracked.set(name, t);
      }
      if (size <= t.offset) continue;

      const buf = Buffer.allocUnsafe(size - t.offset);
      let fd: number;
      try { fd = openSync(full, "r"); } catch { continue; }
      try { readSync(fd, buf, 0, buf.length, t.offset); } finally { closeSync(fd); }

      let text = buf.toString("utf8");
      // Tail of a large file: the first line may be cut off.
      if (t.offset > 0 && t.session.lastAt === 0) text = text.slice(text.indexOf("\n") + 1);
      const lastNl = text.lastIndexOf("\n");
      if (lastNl < 0) return;                       // line still incomplete
      t.offset += Buffer.byteLength(text.slice(0, lastNl + 1), "utf8") + (t.offset > 0 && t.session.lastAt === 0 ? buf.length - Buffer.byteLength(text, "utf8") : 0);

      for (const line of text.slice(0, lastNl).split("\n")) {
        if (line) t.session.ingest(line);
      }
    }

    const sessions = [...this.#tracked.values()]
      .map((t) => t.session.snapshot(now))
      .filter((s) => s.lastAt > 0)
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, MAX_SESSIONS);

    // Only emits when something changed — a 2s poll must not become socket spam.
    const payload = JSON.stringify(sessions);
    this.#lastSessions = sessions;
    if (payload !== this.#lastPayload) {
      this.#lastPayload = payload;
      this.#emit(sessions);
    }
  }
}

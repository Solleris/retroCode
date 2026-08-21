import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { rm, mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { RETRO_HOME } from "./paths.ts";

export function git(cwd: string, args: string[], timeout = 30_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 128 * 1024 * 1024, timeout },
      (err, stdout, stderr) => resolve({ ok: !err, out: err ? String(stderr || err) : stdout }));
  });
}

export async function isGitRepo(root: string): Promise<boolean> {
  return (await git(root, ["rev-parse", "--is-inside-work-tree"])).ok;
}

export async function headSha(root: string): Promise<string | null> {
  const r = await git(root, ["rev-parse", "HEAD"]);
  return r.ok ? r.out.trim() : null;
}

/**
 * Worktrees live in ~/.retro/wt/, OUTSIDE the repository, and always with a
 * detached HEAD (`--detach`).
 *
 * Both choices are deliberate: inside the repo they would show up in your
 * `git status` and in your editor; with a branch, every run would leave refs
 * for you to clean up later. Detached and outside, the only footprint is
 * metadata in `.git/worktrees`, which `git worktree remove` erases. Verified:
 * the repo is bit-for-bit identical before and after.
 */
export function worktreeDir(root: string, taskId: string, variantId: string): string {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return join(RETRO_HOME, "wt", key, `${taskId}-${variantId}`);
}

export async function createWorktree(root: string, dir: string): Promise<boolean> {
  await mkdir(join(RETRO_HOME, "wt"), { recursive: true });

  /**
   * The prune runs ALWAYS, not only when the directory exists.
   *
   * Git keeps the worktree's registration in `.git/worktrees/`, independent of
   * the directory. If the directory disappears from underneath (an `rm -rf`, a
   * full disk, a reboot mid-run), the registration is orphaned and the next
   * `add` fails with "already registered" — pointing at a path that no longer
   * exists. Checking `existsSync` was looking at the wrong side of that
   * relationship.
   */
  await git(root, ["worktree", "prune"]);
  if (existsSync(dir)) await removeWorktree(root, dir);

  const r = await git(root, ["worktree", "add", "--detach", dir, "HEAD"], 60_000);
  if (r.ok) return true;

  // Second attempt after clearing the registration by path — covers the case
  // where the prune was not enough because it points somewhere else.
  await git(root, ["worktree", "remove", "--force", dir], 15_000);
  await git(root, ["worktree", "prune"]);
  return (await git(root, ["worktree", "add", "--detach", dir, "HEAD"], 60_000)).ok;
}

export async function removeWorktree(root: string, dir: string): Promise<void> {
  await git(root, ["worktree", "remove", "--force", dir], 30_000);
  // `worktree remove` fails if the directory is already gone; the prune clears the metadata.
  await rm(dir, { recursive: true, force: true });
  await git(root, ["worktree", "prune"]);
}

export interface FileChange {
  path: string;
  status: "A" | "M" | "D" | "R" | "?";
  /** Why the patch is empty or cut short. The wording is chosen in the UI. */
  note?: { kind: "binary" | "truncated" | "oversize"; kb?: number };
  /** Hash of the final CONTENT. This is what lets us say "all N produced the same file". */
  hash: string;
  patch: string;
  added: number;
  removed: number;
}

/**
 * What one variant changed relative to the base HEAD.
 *
 * Includes untracked files (`--others`): an agent that creates a brand new
 * `auth/service.py` does not show up in `git diff`, and that is precisely the
 * most important file in the change.
 */
/**
 * Per-patch cap. This is not about saving memory: 15MB of binary noise is not
 * a diff — nobody reviews that, and the cost of carrying it to the screen is
 * real.
 */
const MAX_PATCH = 192 * 1024;

/** Git's own heuristic: a NUL in the first 8000 bytes means binary. */
function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/**
 * Cuts, and SAYS that it cut — a silent truncation would make the screen lie.
 *
 * Returns an object ready to spread. Under `exactOptionalPropertyTypes`,
 * `note?: X` and `note: X | undefined` are different types: a key present
 * holding undefined does NOT satisfy an optional one. So the key only exists
 * when there is a note, instead of existing and holding undefined.
 */
function clampPatch(patch: string): { patch: string } | { patch: string; note: NonNullable<FileChange["note"]> } {
  if (patch.length <= MAX_PATCH) return { patch };
  return {
    patch: patch.slice(0, MAX_PATCH),
    note: { kind: "truncated", kb: MAX_PATCH / 1024 },
  };
}

export async function diffAgainstBase(wt: string, base: string): Promise<FileChange[]> {
  const changes = new Map<string, FileChange>();

  const nameStatus = await git(wt, ["diff", "--name-status", "-M", base]);
  const numstat = await git(wt, ["diff", "--numstat", base]);

  const counts = new Map<string, { added: number; removed: number }>();
  for (const line of numstat.out.split("\n")) {
    const [a, r, p] = line.split("\t");
    if (p) counts.set(p, { added: Number(a) || 0, removed: Number(r) || 0 });
  }

  for (const line of nameStatus.out.split("\n")) {
    const parts = line.split("\t");
    const st = parts[0]?.[0];
    const p = parts[parts.length - 1];
    if (!st || !p) continue;
    const patch = (await git(wt, ["diff", base, "--", p])).out;
    changes.set(p, {
      path: p,
      status: (["A", "M", "D", "R"].includes(st) ? st : "?") as FileChange["status"],
      hash: await contentHash(join(wt, p)),
      ...clampPatch(patch),
      added: counts.get(p)?.added ?? 0,
      removed: counts.get(p)?.removed ?? 0,
    });
  }

  /*
   * Untracked files have no git patch — git only diffs what it tracks. So this
   * branch FABRICATES one, prefixing every line with "+".
   *
   * Fabricating without looking at the content was the bug: in a repo with a
   * 15MB .zip and a pile of untracked PDFs, those "patches" added up to a 73MB
   * frame against the protocol's 64MB cap — and the parser on the app side
   * threw inside a socket handler, which means the main process crashed.
   *
   * Binary never becomes a text patch, and what remains is capped. It is what
   * git itself does: "Binary files differ" and nothing more.
   */
  const untracked = await git(wt, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const p of untracked.out.split("\0").filter(Boolean)) {
    if (changes.has(p)) continue;
    const raw = await safeReadBuf(join(wt, p));
    const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);

    if (isBinary(raw)) {
      changes.set(p, {
        path: p, status: "A", hash, patch: "",
        note: { kind: "binary", kb: Math.round(raw.length / 1024) },
        added: 0, removed: 0,
      });
      continue;
    }

    const body = raw.toString("utf8");
    const lines = body ? body.split("\n") : [];
    changes.set(p, {
      path: p, status: "A", hash,
      ...clampPatch(lines.map((l) => `+${l}`).join("\n")),
      added: lines.length, removed: 0,
    });
  }

  return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function contentHash(abs: string): Promise<string> {
  try {
    return createHash("sha256").update(await readFile(abs)).digest("hex").slice(0, 16);
  } catch {
    return "absent";   // deleted by the variant
  }
}

async function safeRead(abs: string): Promise<string> {
  try { return await readFile(abs, "utf8"); } catch { return ""; }
}

/** Raw bytes: the only way to decide if it is binary before treating it as text. */
async function safeReadBuf(abs: string): Promise<Buffer> {
  try { return await readFile(abs); } catch { return Buffer.alloc(0); }
}

/** Adopts one variant's file into the main repository. */
export async function adoptFile(wtDir: string, root: string, relPath: string): Promise<boolean> {
  const src = join(wtDir, relPath);
  const dst = join(root, relPath);
  try {
    if (!existsSync(src)) { await rm(dst, { force: true }); return true; }
    await mkdir(join(dst, ".."), { recursive: true });
    await copyFile(src, dst);
    return true;
  } catch { return false; }
}

export { writeFile };


/**
 * The web URL for a branch, derived from the git remote.
 *
 * Converts both remote forms (ssh and https) into a browsable address, and
 * handles both path schemes (GitHub uses `/tree/`, GitLab `/-/tree/`).
 * Returns null when there is no remote or the branch is a detached HEAD — a
 * link that leads nowhere is worse than no link.
 */
export async function branchWebUrl(root: string, branch: string): Promise<string | null> {
  if (!branch || branch === "HEAD") return null;
  const r = await git(root, ["remote", "get-url", "origin"], 5000);
  if (!r.ok) return null;

  const raw = r.out.trim();
  let base: string | null = null;

  const ssh = raw.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/);
  if (ssh) base = `https://${ssh[1]}/${ssh[2]}`;
  else {
    const http = raw.match(/^https?:\/\/(?:[^@]+@)?(.+?)(?:\.git)?$/);
    if (http) base = `https://${http[1]}`;
  }
  if (!base) return null;

  const seg = /gitlab/i.test(base) ? "/-/tree/" : "/tree/";
  return base + seg + encodeURIComponent(branch);
}

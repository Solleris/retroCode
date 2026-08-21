import { readdir, readFile as read, writeFile as write, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Directories that never matter in a project index. This is not a real
 * .gitignore — it is the list that covers 99% of the cost in ~10 lines. A
 * .gitignore parser lands when someone complains, not before.
 */
const SKIP = new Set([
  "node_modules", ".git", "dist", "out", "build", ".next", "target",
  "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache",
  ".turbo", "coverage", ".DS_Store", ".retro",
  // Tool directories that grow without bound. They only matter in the
  // git-less fallback; in a repo the .gitignore already handles them.
  ".claude", ".cache", ".gradle", ".idea", ".tox", "vendor", ".terraform",
]);

/** Index cap. Past this, a fuzzy finder is no longer the right tool. */
const MAX_FILES = 20_000;

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
  ".node", ".dylib", ".so", ".wasm", ".woff", ".woff2", ".ttf", ".sqlite", ".db",
]);

export interface IndexResult { files: string[]; truncated: boolean }

/**
 * `git ls-files` as the index's primary source.
 *
 * This is not an optimisation — it is the CORRECT definition of "the project's
 * files". Git already knows what is code and what is junk, because the
 * .gitignore says so. Keeping a hand-written list of directories to skip is
 * reimplementing .gitignore, badly: in a real repo here, `.claude` held 24k
 * files and `.venv` 42k, and the walk took over 30 seconds to produce a
 * truncated, useless list. Git returns the 501 files that matter in 25ms.
 *
 * `--cached --others --exclude-standard` = tracked + new but not yet added,
 * minus the ignored ones. That is exactly what you want to see in a finder.
 * `-z` because filenames containing newlines exist.
 */
function gitLsFiles(root: string): Promise<string[] | null> {
  if (!existsSync(join(root, ".git"))) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        resolve(stdout.split("\0").filter(Boolean));
      },
    );
  });
}

export async function indexProject(root: string): Promise<IndexResult> {
  const tracked = await gitLsFiles(root);
  if (tracked) {
    const truncated = tracked.length > MAX_FILES;
    return { files: sortForFinder(truncated ? tracked.slice(0, MAX_FILES) : tracked), truncated };
  }

  // Fallback for a folder with no git.
  const files: string[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      // Check INSIDE the loop: previously the `return` only left the current
      // frame and the walk carried on through thousands more directories.
      if (truncated) return;
      if (SKIP.has(e.name) || e.name.startsWith(".DS")) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        if (files.length >= MAX_FILES) { truncated = true; return; }
        files.push(relative(root, abs));
      }
    }
  }

  await walk(root);
  return { files: sortForFinder(files), truncated };
}

function sortForFinder(files: string[]): string[] {
  // Depth then alphabetical: root files first in the finder, which is where
  // the hand goes most of the time.
  return [...files].sort((a, b) => {
    const da = a.split("/").length, dbb = b.split("/").length;
    return da !== dbb ? da - dbb : a.localeCompare(b);
  });
}

/** Read cap: a 5MB file in the editor is not a use case, it is an accident. */
const MAX_READ = 5 * 1024 * 1024;

export async function readFile(path: string): Promise<{ text: string; binary: boolean }> {
  if (BINARY_EXT.has(extname(path).toLowerCase())) return { text: "", binary: true };
  const s = await stat(path);
  if (s.size > MAX_READ) return { text: `// ${(s.size / 1e6).toFixed(1)}MB file — too large for the editor`, binary: true };
  const buf = await read(path);
  // A NUL in the first 8KB is the heuristic git itself uses. Cheap and accurate.
  if (buf.subarray(0, 8192).includes(0)) return { text: "", binary: true };
  return { text: buf.toString("utf8"), binary: false };
}

export async function writeFile(path: string, text: string): Promise<void> {
  await write(path, text, "utf8");
}

export interface DirEntry { name: string; dir: boolean }

/**
 * Batched `git check-ignore` for one directory.
 *
 * The tree has to respect .gitignore for the SAME reason the index does — and
 * above all by the same DEFINITION. Previously the finder used `git ls-files`
 * (clean, 497 files) while the tree used a fixed exclusion list, so it showed
 * `.ruff_cache` and friends. Two sources of truth for "what the project is" is
 * worse than two identically wrong ones: you cannot tell which to trust.
 */
function checkIgnored(root: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length || !existsSync(join(root, ".git"))) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const child = execFile("git", ["-C", root, "check-ignore", "--stdin", "-z"],
      { maxBuffer: 8 * 1024 * 1024, timeout: 5_000 },
      (_err, stdout) => resolve(new Set(stdout.split("\0").filter(Boolean))));
    // check-ignore exits 1 when NOTHING is ignored; that is not an error.
    child.stdin?.end(paths.join("\0"));
  });
}

/**
 * One directory level. Lazy expansion: the tree only asks for what the user
 * opened. A full walk in a large monorepo would freeze the UI for seconds and
 * most of the result would never be looked at.
 */
export async function listDir(path: string, gitRoot?: string): Promise<DirEntry[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const kept: DirEntry[] = [];
  const rels: string[] = [];

  for (const e of entries) {
    if (SKIP.has(e.name) || e.name === ".DS_Store") continue;
    if (!(e.isDirectory() || e.isFile() || e.isSymbolicLink())) continue;
    kept.push({ name: e.name, dir: e.isDirectory() });
    rels.push(relative(gitRoot ?? path, join(path, e.name)) || e.name);
  }

  const ignored = gitRoot ? await checkIgnored(gitRoot, rels) : new Set<string>();
  const out = kept.filter((_e, i) => !ignored.has(rels[i]!));

  // Directories first, then alphabetical — the order the eye expects.
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return out;
}

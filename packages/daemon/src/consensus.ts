import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  worktreeDir, createWorktree, removeWorktree, diffAgainstBase,
  headSha, isGitRepo, adoptFile, type FileChange,
} from "./worktree.ts";
import type { AgentRunner } from "./agent.ts";

/**
 * Variants with DELIBERATELY different framings.
 *
 * This is the conceptual point of the whole thing: running the same prompt
 * three times on the same model produces CORRELATED errors — the three variants
 * are wrong together, and their agreement means nothing. Divergent framings
 * force independent derivations, and that is what turns "all three landed in the
 * same place" into evidence rather than echo.
 *
 * Corollary: the divergence becomes informative too. When "minimal" and
 * "conservative" disagree on a file, the disagreement IS the design decision
 * nobody has made yet — and it is exactly where you need to look.
 */
export interface Variant { id: string; label: string; steer: string }

export const DEFAULT_VARIANTS: Variant[] = [
  { id: "a", label: "minimal", steer:
    "Make the MINIMAL change that solves the request. Do not refactor anything beyond what is strictly necessary. Prefer few lines over few abstractions." },
  { id: "b", label: "completo", steer:
    "Solve the request completely: edge cases, error handling and tests where they make sense. Prefer correctness over brevity." },
  { id: "c", label: "conservador", steer:
    "Prioritise NOT breaking anything that already exists. Preserve backwards compatibility of signatures and observable behaviour, even if the result is more verbose." },
];

export type Verdict = "identical" | "equivalent" | "divergent" | "minority";

/**
 * Artefacts an agent produces in passing and that are never the change itself.
 * A `.pyc` in the consensus map is noise that pushes signal off the screen.
 */
const ARTIFACT = /(?:^|\/)(?:__pycache__|\.pytest_cache|\.mypy_cache|node_modules|\.venv|dist|build|target)\/|\.(?:pyc|pyo|so|o|class|log|lock)$/;
export const isArtifact = (p: string): boolean => ARTIFACT.test(p);

export interface VariantFile {
  variantId: string; status: string; hash: string;
  added: number; removed: number; patch: string;
}

export interface FileVerdict {
  path: string;
  verdict: Verdict;
  touchedBy: string[];
  distinctHashes: number;
  variants: VariantFile[];
  /** No test exercises this file → nobody validated it, read carefully. */
  uncovered: boolean;
}

export interface TestRun {
  variantId: string;
  /**
   * Did the suite RUN? Distinct from `ok`.
   *
   * Without this distinction, three variants where the test command does not
   * exist produce identical signatures, the classifier concludes "behaviour
   * agrees" and marks everything equivalent — which reads as "pick any". We did
   * not learn that they agree; we learned that we could not measure. Absence of
   * evidence must not become agreement.
   */
  ran: boolean;
  ok: boolean; passed?: number; failed?: number;
  failedNames: string[]; command: string; output: string;
}

export interface ConsensusReport {
  taskId: string;
  root: string;
  base: string;
  variants: { id: string; label: string; ok: boolean; costUsd?: number; wt: string }[];
  files: FileVerdict[];
  tests: TestRun[];
  /** How many files need reading — the metric that actually matters. */
  needsReview: number;
  agreementPct: number;
  /** Did the suite run in every variant? If not, the verdicts are blind to behaviour. */
  measured: boolean;
  totalCostUsd: number;
}

// ── test detection and execution ───────────────────────────────────────

export function detectTestCommand(root: string): string | null {
  const has = (f: string): boolean => existsSync(join(root, f));
  const readJson = (f: string): Record<string, unknown> | null => {
    try { return JSON.parse(readFileSync(join(root, f), "utf8")) as Record<string, unknown>; } catch { return null; }
  };

  if (has("package.json")) {
    const pkg = readJson("package.json");
    const scripts = (pkg?.["scripts"] ?? {}) as Record<string, string>;
    if (scripts["test"]) return has("bun.lock") || has("bun.lockb") ? "bun run test" : "npm test";
  }
  if (has("pytest.ini") || has("pyproject.toml") || has("setup.cfg") || has("tests")) return "pytest -q";
  if (has("Cargo.toml")) return "cargo test --quiet";
  if (has("go.mod")) return "go test ./...";
  return null;
}

function parseTests(out: string): { passed?: number; failed?: number; failedNames: string[] } {
  const failedNames = [...out.matchAll(/^(?:FAILED|--- FAIL:)\s+(\S+)/gm)].map((m) => m[1]!).slice(0, 20);
  const num = (re: RegExp): number | undefined => {
    const m = out.match(re);
    return m?.[1] ? Number(m[1]) : undefined;
  };
  /*
   * Storing in a const before testing is not style: `num(re) !== undefined ?
   * { passed: num(re) }` narrows nothing, because the second call is a fresh
   * expression and stays `number | undefined` — which under
   * exactOptionalPropertyTypes does not satisfy an optional field. It also ran
   * the regex twice per field.
   */
  const passed = num(/(\d+)\s+passed/);
  const failed = num(/(\d+)\s+failed/);
  return {
    ...(passed !== undefined ? { passed } : {}),
    ...(failed !== undefined ? { failed } : {}),
    failedNames,
  };
}

function runTests(wt: string, command: string, variantId: string): Promise<TestRun> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-lc", command], { cwd: wt, maxBuffer: 32 * 1024 * 1024, timeout: 300_000 },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`;
        const parsed = parseTests(out);
        /**
         * "It ran" is defined POSITIVELY: the output contains a test count we
         * could read.
         *
         * The previous version defined it by the absence of one specific error
         * (exit 127 / "command not found") — and there is always another way to
         * fail. `python3 -m pytest` without pytest installed exits 1 with
         * ModuleNotFoundError: not "command not found", so it slipped past the
         * filter and the false signal came back in disguise.
         *
         * You measured only if you can point at a number.
         */
        const ran = parsed.passed !== undefined || parsed.failed !== undefined
                 || parsed.failedNames.length > 0 || /\b(\d+)\s+tests?\b/.test(out);
        resolve({
          variantId, ran, ok: ran && !err, command,
          output: out.trim().split("\n").slice(-25).join("\n"),
          ...parsed,
        });
      });
  });
}

// ── classification ─────────────────────────────────────────────────────

/**
 * Where the variants agree and where they diverge.
 *
 * The order of the verdicts is the order of attention they deserve:
 *   identical  — all N produced a byte-identical file. Do not read it.
 *   equivalent — all N touched it, the text differs, the tests agree. Pick one.
 *   divergent  — text AND behaviour diverge. This is where you read.
 *   minority   — only some variants touched it. Either it is superfluous, or the
 *                others forgot; of the two, the second is the one that hurts.
 */
export function classify(
  perVariant: Map<string, FileChange[]>,
  tests: TestRun[],
  coveredPaths: Set<string> | null,
): FileVerdict[] {
  const n = perVariant.size;
  const byPath = new Map<string, VariantFile[]>();

  for (const [variantId, changes] of perVariant) {
    for (const c of changes) {
      if (isArtifact(c.path)) continue;
      const list = byPath.get(c.path) ?? [];
      list.push({ variantId, status: c.status, hash: c.hash, added: c.added, removed: c.removed, patch: c.patch });
      byPath.set(c.path, list);
    }
  }

  /**
   * Behaviour agrees when the suite RAN in every variant and produced the same
   * result. "The same result" is not "they all passed" — it is "they all failed
   * identically", which is information too.
   *
   * The `every(ran)` is what blocks the false signal: without it, three suites
   * that did not run look like three suites that agree.
   */
  const sig = (t: TestRun): string => `${t.ok}|${[...t.failedNames].sort().join(",")}`;
  const measured = tests.length > 1 && tests.every((t) => t.ran);
  const behaviourAgrees = measured && new Set(tests.map(sig)).size === 1;

  const out: FileVerdict[] = [];
  for (const [path, variants] of byPath) {
    const hashes = new Set(variants.map((v) => v.hash));
    const touchedBy = variants.map((v) => v.variantId).sort();

    let verdict: Verdict;
    if (touchedBy.length < n) verdict = "minority";
    else if (hashes.size === 1) verdict = "identical";
    else verdict = behaviourAgrees ? "equivalent" : "divergent";

    out.push({
      path, verdict, touchedBy, distinctHashes: hashes.size, variants,
      uncovered: coveredPaths ? !coveredPaths.has(path) : false,
    });
  }

  const rank: Record<Verdict, number> = { divergent: 0, minority: 1, equivalent: 2, identical: 3 };
  return out.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.path.localeCompare(b.path));
}

// ── orchestration ──────────────────────────────────────────────────────

export interface ConsensusEmit {
  progress(taskId: string, variantId: string, phase: string, note: string): void;
  report(r: ConsensusReport): void;
  failed(taskId: string, reason: string): void;
}

export class ConsensusRunner {
  #emit: ConsensusEmit;
  #agents: AgentRunner;
  #active = new Map<string, ConsensusReport>();

  constructor(agents: AgentRunner, emit: ConsensusEmit) {
    this.#agents = agents;
    this.#emit = emit;
  }

  report(taskId: string): ConsensusReport | undefined { return this.#active.get(taskId); }

  async run(taskId: string, prompt: string, root: string, opts: { runTests: boolean }): Promise<void> {
    if (!(await isGitRepo(root))) {
      this.#emit.failed(taskId, "consensus requires a git repository: the worktrees are the isolation");
      return;
    }
    const base = await headSha(root);
    if (!base) {
      this.#emit.failed(taskId, "the repository has no commits — a worktree needs a HEAD");
      return;
    }

    const variants = DEFAULT_VARIANTS;
    const dirs = new Map<string, string>();

    // ── worktrees ──
    for (const v of variants) {
      const dir = worktreeDir(root, taskId, v.id);
      this.#emit.progress(taskId, v.id, "worktree", "isolando");
      if (!(await createWorktree(root, dir))) {
        this.#emit.failed(taskId, `failed to create a worktree for variant ${v.id}`);
        for (const d of dirs.values()) await removeWorktree(root, d);
        return;
      }
      dirs.set(v.id, dir);
    }

    // ── agents in parallel, each in its own worktree ──
    const results = await Promise.all(variants.map(async (v) => {
      const dir = dirs.get(v.id)!;
      this.#emit.progress(taskId, v.id, "agent", v.label);
      const r = await this.#agents.runToCompletion(`${taskId}:${v.id}`,
        `${prompt}\n\n---\nConstraint for this run: ${v.steer}`, dir);
      this.#emit.progress(taskId, v.id, "agentDone", r.ok ? "ok" : `falhou: ${r.error ?? "?"}`);
      return { v, dir, ...r };
    }));

    // ── diffs ──
    const perVariant = new Map<string, FileChange[]>();
    for (const r of results) {
      this.#emit.progress(taskId, r.v.id, "diff", "extracting changes");
      perVariant.set(r.v.id, await diffAgainstBase(r.dir, base));
    }

    // ── tests (optional: running the suite 3× costs real time) ──
    const tests: TestRun[] = [];
    const cmd = opts.runTests ? detectTestCommand(root) : null;
    if (opts.runTests && cmd) {
      await Promise.all(results.map(async (r) => {
        this.#emit.progress(taskId, r.v.id, "tests", cmd);
        tests.push(await runTests(r.dir, cmd, r.v.id));
      }));
    } else if (opts.runTests) {
      this.#emit.progress(taskId, "-", "tests", "nenhum comando de teste detectado");
    }

    const files = classify(perVariant, tests, null);
    const identical = files.filter((f) => f.verdict === "identical").length;
    const needsReview = files.filter((f) => f.verdict === "divergent" || f.verdict === "minority").length;
    const measured = tests.length > 1 && tests.every((t) => t.ran);

    const report: ConsensusReport = {
      taskId, root, base,
      variants: results.map((r) => ({
        id: r.v.id, label: r.v.label, ok: r.ok, wt: r.dir,
        ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
      })),
      files, tests, needsReview, measured,
      agreementPct: files.length ? Math.round((identical / files.length) * 100) : 100,
      totalCostUsd: results.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    };
    this.#active.set(taskId, report);
    this.#emit.report(report);
  }

  async adopt(taskId: string, variantId: string, path: string): Promise<boolean> {
    const r = this.#active.get(taskId);
    const v = r?.variants.find((x) => x.id === variantId);
    if (!r || !v) return false;
    return adoptFile(v.wt, r.root, path);
  }

  async discard(taskId: string): Promise<void> {
    const r = this.#active.get(taskId);
    if (!r) return;
    for (const v of r.variants) await removeWorktree(r.root, v.wt);
    this.#active.delete(taskId);
  }
}

/**
 * The contract between retroCode.app and retrod.
 *
 * The rule that governs this file: **the daemon owns processes, not content.**
 * No text buffer, no AST, no document crosses this boundary. If you feel the
 * urge to add `case setBufferText`, stop — typing latency is sacred and does
 * not pay for an IPC hop.
 */
import { z } from "zod";

export const TaskState = z.enum([
  "running",   // agente trabalhando
  "needsYou",  // a permission gate or a question — goes to the top of the attention queue
  "review",    // diff ready for judgement
  "failed",
  "merged",
]);
export type TaskState = z.infer<typeof TaskState>;

// ─────────────────────────── app → daemon ───────────────────────────

/**
 * The user's configuration — the contents of ~/.retro/config.json.
 *
 * The settings pane edits THIS file, not a parallel store: what the UI writes
 * is exactly what a human would write by hand, and what a hand writes the UI
 * shows. Two doors into the same state.
 */
export const RetroConfig = z.object({
  /** Absent = follow the system language. */
  lang: z.enum(["pt", "en"]).optional(),

  /*
   * Theme token overrides, without the `--`: { "signal": "#7AA2F7" }.
   * Key and value are constrained because this feeds setProperty — not out of
   * fear of XSS (there is none), but because a free-form value lets the theme
   * break silently.
   */
  theme: z.record(z.string().regex(/^[a-z0-9-]{1,24}$/), z.string().regex(/^[^;{}]{1,64}$/))
          .default({}),

  /** Your own commands in the palette: a label and a shell snippet. */
  commands: z.array(z.object({
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(80),
    run: z.string().min(1).max(2000),
    hint: z.string().max(20).optional(),
  })).default([]),
});
export type RetroConfig = z.infer<typeof RetroConfig>;

export const ClientRequest = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), clientId: z.string() }),

  z.object({ t: z.literal("openProject"), path: z.string() }),

  z.object({
    t: z.literal("spawnTerminal"),
    ptyId: z.string(),
    cwd: z.string(),
    shell: z.string().optional(),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({ t: z.literal("resizeTerminal"), ptyId: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive() }),
  z.object({ t: z.literal("killTerminal"), ptyId: z.string() }),

  /**
   * Reattaches to a pty that already existed — the path that makes "sessions
   * outlive a relaunch" visible instead of theoretical. The daemon answers with
   * the scrollback before resuming the live stream.
   */
  z.object({ t: z.literal("attachTerminal"), ptyId: z.string() }),

  z.object({ t: z.literal("listTerminals") }),

  // ── files ─────────────────────────────────────────────────────────
  // The renderer has no Node (nodeIntegration off, and it should stay off — it
  // displays agent output and repo content, a real injection surface). Every
  // disk access goes through here.
  z.object({ t: z.literal("indexProject"), path: z.string() }),
  z.object({ t: z.literal("readFile"), path: z.string() }),
  z.object({ t: z.literal("writeFile"), path: z.string(), text: z.string() }),

  /** Lazy tree expansion: one level per request, not the whole repo. */
  z.object({ t: z.literal("listDir"), path: z.string(), root: z.string().optional() }),
  z.object({ t: z.literal("recentProjects") }),
  z.object({ t: z.literal("eventLog"), project: z.string(), sinceId: z.number().optional() }),
  /** Turns the lens on: watch this project's claude CLI sessions. */
  z.object({ t: z.literal("watchClaude"), project: z.string() }),
  /**
   * Focused terminal → which repo is it in? The daemon resolves the shell's
   * real cwd (lsof) and the git root, turns on that repo's lens, and answers.
   * This is what makes the lens follow the terminal, not the open project.
   */
  z.object({ t: z.literal("resolvePtyProject"), ptyId: z.string() }),
  /** Connectors over the user's own claude MCP servers (headless + cache). */
  z.object({ t: z.literal("fetchLinear"), force: z.boolean().optional() }),
  z.object({ t: z.literal("fetchNotion"), force: z.boolean().optional() }),
  /** A page's content, to paste into the composer (bracketed paste). */
  z.object({ t: z.literal("fetchNotionPage"), url: z.string(), title: z.string() }),
  z.object({ t: z.literal("fetchLinearIssue"), id: z.string() }),
  /**
   * A repo's working tree vs HEAD — the question that matters here is "what did
   * the claude session change?". `paths` narrows it to one session's files;
   * empty means the whole repo.
   */
  z.object({ t: z.literal("readConfig") }),
  z.object({ t: z.literal("writeConfig"), config: RetroConfig }),
  z.object({ t: z.literal("gitDiff"), root: z.string(), paths: z.array(z.string()).optional() }),
  z.object({ t: z.literal("branchUrl"), root: z.string(), branch: z.string() }),


  // ── agente ────────────────────────────────────────────────────────
  z.object({
    t: z.literal("startAgent"),
    taskId: z.string(),
    prompt: z.string(),
    cwd: z.string(),
    resume: z.string().optional(),     // sessionId, to continue after a relaunch
  }),
  /**
   * `always: true` returns the SDK's `suggestions` as `updatedPermissions`,
   * which is the mechanism by which "always allow pytest" sticks for the rest
   * of the session instead of asking on every call.
   */
  z.object({
    t: z.literal("resolvePermission"),
    requestId: z.string(),
    allow: z.boolean(),
    always: z.boolean(),
  }),
  z.object({ t: z.literal("interruptAgent"), taskId: z.string() }),

  // ── consenso ──────────────────────────────────────────────────────
  z.object({
    t: z.literal("startConsensus"),
    taskId: z.string(),
    prompt: z.string(),
    cwd: z.string(),
    runTests: z.boolean(),
  }),
  z.object({ t: z.literal("adoptFile"), taskId: z.string(), variantId: z.string(), path: z.string() }),
  z.object({ t: z.literal("discardConsensus"), taskId: z.string() }),
  /** A reconnecting client has to be able to FETCH the report, not only
   *  receive it by broadcast at the instant it became ready. */
  z.object({ t: z.literal("getConsensus"), taskId: z.string() }),
]);
export type ClientRequest = z.infer<typeof ClientRequest>;

/**
 * A claude CLI session as the Lens sees it.
 *
 * Named and exported deliberately: the daemon used to keep its own
 * `interface ClaudeSession`, and when the usage fields arrived only one of the
 * two sides was updated. Two definitions of the same thing is one waiting to
 * diverge — here there is one, and the daemon imports this.
 */
export const ClaudeSession = z.object({
  id: z.string(), title: z.string(), branch: z.string(),
  state: z.enum(["working", "yourTurn", "maybeGate", "idle"]),
  startedAt: z.number(), lastAt: z.number(),
  files: z.array(z.object({ path: z.string(), edits: z.number(), lastAt: z.number() })),
  todos: z.array(z.object({ content: z.string(), status: z.string() })),
  lastText: z.string(), turns: z.number(),
  ctxTokens: z.number(), ctxWindow: z.number(), model: z.string(),
  outTokens: z.number(), inTokens: z.number(),
  cacheReadTokens: z.number(), cacheCreateTokens: z.number(), costUsd: z.number(),
});
export type ClaudeSession = z.infer<typeof ClaudeSession>;


export const TimelineEvent = z.object({
  id: z.number(),
  project: z.string(),
  lane: z.string(),
  at: z.number(),
  kind: z.enum(["lane-start", "lane-end", "tool", "tool-done", "text",
                "gate", "gate-done", "edit", "test", "output", "diff", "note"]),
  label: z.string(),
  detail: z.string().optional().nullable(),
  ref: z.string().optional().nullable(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

/** One piece of the agent's stream, already translated from the SDK's shape. */
export const AgentDelta = z.discriminatedUnion("k", [
  z.object({ k: z.literal("text"), text: z.string() }),
  z.object({ k: z.literal("thinking") }),
  z.object({ k: z.literal("tool"), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ k: z.literal("toolResult"), id: z.string(), ok: z.boolean(), summary: z.string() }),
  z.object({ k: z.literal("note"), text: z.string() }),
]);
export type AgentDelta = z.infer<typeof AgentDelta>;

// ─────────────────────────── daemon → app ───────────────────────────

export const DaemonEvent = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ready"), daemonPid: z.number(), version: z.string() }),
  z.object({ t: z.literal("terminalSpawned"), ptyId: z.string(), pid: z.number(), cwd: z.string() }),
  z.object({ t: z.literal("terminalExited"), ptyId: z.string(), exitCode: z.number(), signal: z.number().optional() }),
  z.object({
    t: z.literal("terminalList"),
    terminals: z.array(z.object({ ptyId: z.string(), pid: z.number(), cwd: z.string(), alive: z.boolean() })),
  }),
  z.object({ t: z.literal("error"), message: z.string(), cause: z.string().optional() }),

  z.object({
    t: z.literal("projectIndexed"),
    root: z.string(),
    name: z.string(),
    // Paths relative to the root. The fuzzy match runs in the renderer:
    // sending the list once and filtering locally is far more responsive than
    // a round trip per keystroke.
    files: z.array(z.string()),
    truncated: z.boolean(),
  }),
  z.object({ t: z.literal("fileContent"), path: z.string(), text: z.string(), binary: z.boolean() }),
  z.object({ t: z.literal("fileSaved"), path: z.string() }),

  z.object({
    t: z.literal("dirListing"),
    path: z.string(),
    entries: z.array(z.object({ name: z.string(), dir: z.boolean() })),
  }),
  z.object({
    t: z.literal("recents"),
    projects: z.array(z.object({ path: z.string(), name: z.string(), openedAt: z.number() })),
  }),

  z.object({ t: z.literal("agentDelta"), taskId: z.string(), delta: AgentDelta }),
  z.object({
    t: z.literal("permissionAsk"),
    requestId: z.string(),
    taskId: z.string(),
    tool: z.string(),
    input: z.unknown(),
    canAlways: z.boolean(),
  }),
  z.object({
    t: z.literal("agentDone"),
    taskId: z.string(),
    ok: z.boolean(),
    costUsd: z.number().optional(),
    turns: z.number().optional(),
    sessionId: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({ t: z.literal("taskState"), taskId: z.string(), state: TaskState }),

  z.object({
    t: z.literal("consensusProgress"),
    taskId: z.string(), variantId: z.string(), phase: z.string(), note: z.string(),
  }),
  z.object({
    t: z.literal("consensusReport"),
    taskId: z.string(),
    base: z.string(),
    agreementPct: z.number(),
    needsReview: z.number(),
    measured: z.boolean(),
    totalCostUsd: z.number(),
    variants: z.array(z.object({
      id: z.string(), label: z.string(), ok: z.boolean(), costUsd: z.number().optional(),
    })),
    files: z.array(z.object({
      path: z.string(),
      verdict: z.enum(["identical", "equivalent", "divergent", "minority"]),
      touchedBy: z.array(z.string()),
      distinctHashes: z.number(),
      uncovered: z.boolean(),
      variants: z.array(z.object({
        variantId: z.string(), status: z.string(), hash: z.string(),
        added: z.number(), removed: z.number(), patch: z.string(),
      })),
    })),
    tests: z.array(z.object({
      variantId: z.string(), ran: z.boolean(), ok: z.boolean(), command: z.string(),
      passed: z.number().optional(), failed: z.number().optional(),
      failedNames: z.array(z.string()), output: z.string(),
    })),
  }),
  z.object({ t: z.literal("consensusFailed"), taskId: z.string(), reason: z.string() }),
  z.object({ t: z.literal("fileAdopted"), taskId: z.string(), path: z.string(), ok: z.boolean() }),

  z.object({
    t: z.literal("claudeSessions"),
    project: z.string(),
    sessions: z.array(ClaudeSession),
  }),

  z.object({ t: z.literal("ptyProject"), ptyId: z.string(), project: z.string().nullable(), cwd: z.string().nullable() }),
  z.object({
    t: z.literal("linearIssues"),
    fresh: z.boolean(),
    issues: z.array(z.object({ id: z.string(), title: z.string(), state: z.string(), url: z.string() })),
    error: z.string().optional(),
  }),

  z.object({ t: z.literal("branchUrlResult"), url: z.string().nullable() }),
  z.object({
    t: z.literal("gitDiffFiles"),
    root: z.string(),
    files: z.array(z.object({
      path: z.string(), status: z.string(),
      added: z.number(), removed: z.number(), patch: z.string(),
      /*
       * Why a STRUCTURED note and not text inside the patch: the daemon does
       * not know the window's language — and should not. It says "binary,
       * 15379KB"; the renderer chooses the words, because that is where
       * language lives.
       */
      note: z.object({
        kind: z.enum(["binary", "truncated", "oversize"]),
        kb: z.number().optional(),
      }).optional(),
    })),
    /** A code when the cause is ours ("notARepo"); git's own prose when it is git's. */
    error: z.string().optional(),
  }),
  z.object({
    t: z.literal("linearIssueContent"),
    id: z.string(), markdown: z.string(), error: z.string().optional(),
  }),
  z.object({
    t: z.literal("notionPageContent"),
    url: z.string(), title: z.string(), markdown: z.string(),
    error: z.string().optional(),
  }),
  z.object({
    t: z.literal("notionPages"),
    fresh: z.boolean(),
    pages: z.array(z.object({ title: z.string(), url: z.string() })),
    error: z.string().optional(),
  }),

  z.object({ t: z.literal("event"), event: TimelineEvent }),
  /** `problem` is set when the file exists but could not be read. */
  z.object({ t: z.literal("config"), config: RetroConfig, path: z.string(),
             problem: z.string().optional() }),
  z.object({ t: z.literal("eventLog"), project: z.string(), events: z.array(TimelineEvent) }),
]);
export type DaemonEvent = z.infer<typeof DaemonEvent>;

export const PROTOCOL_VERSION = "0.0.6";

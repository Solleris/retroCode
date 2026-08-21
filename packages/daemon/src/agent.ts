import { query, type PermissionResult, type PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDelta } from "@retro/protocol";

/**
 * The agent engine. In-process: the daemon is Node, so the SDK is an `import` —
 * no sidecar, no IPC boundary, no double translation layer.
 *
 * The piece that justifies all of it is `canUseTool`: it BLOCKS here while the
 * renderer draws the approval sheet. Without that gate you do not have an IDE,
 * you have a terminal with a chat on top.
 */

export interface AgentEmit {
  delta(taskId: string, delta: AgentDelta): void;
  ask(req: { requestId: string; taskId: string; tool: string; input: unknown; canAlways: boolean }): void;
  done(r: { taskId: string; ok: boolean; costUsd?: number; turns?: number; sessionId?: string; error?: string }): void;
}

interface Pending {
  resolve(r: PermissionResult): void;
  suggestions: PermissionUpdate[] | undefined;
  tool: string;
}

interface Session {
  abort: AbortController;
  pending: Map<string, Pending>;
  /** Rules accumulated via "always allow" in this session. */
  granted: PermissionUpdate[];
  sessionId?: string;
}

let reqSeq = 0;

/** A short summary of a tool_result: the pane shows the shape, not the whole dump. */
function summarize(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 400);
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("")
      .slice(0, 400);
  }
  return "";
}

export class AgentRunner {
  #sessions = new Map<string, Session>();
  #emit: AgentEmit;
  /** Resolvers de `runToCompletion`, por taskId. */
  #oneShot = new Map<string, (r: { ok: boolean; costUsd?: number; sessionId?: string; error?: string }) => void>();

  constructor(emit: AgentEmit) { this.#emit = emit; }

  isRunning(taskId: string): boolean { return this.#sessions.has(taskId); }

  /**
   * Like `start`, but it returns the result and uses a permissive mode.
   *
   * Used by the consensus variants. They run in a disposable worktree outside
   * the repository, so a wrong edit costs nothing — and three agents asking for
   * approval on every file would be unbearable as well as useless: you have no
   * context to decide mid-run. The gate comes back where it matters, at the
   * ADOPTION of the result.
   */
  runToCompletion(
    taskId: string, prompt: string, cwd: string, timeoutMs = 15 * 60_000,
  ): Promise<{ ok: boolean; costUsd?: number; sessionId?: string; error?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: { ok: boolean; costUsd?: number; sessionId?: string; error?: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };

      /**
       * A deadline per variant. Without one, a stuck run hangs the consensus
       * `Promise.all` forever — and since nobody is watching (this is precisely
       * unsupervised work), the symptom is a window frozen on "running" with no
       * explanation. Work without a deadline is work that hangs.
       */
      const timer = setTimeout(() => {
        this.interrupt(taskId);
        finish({ ok: false, error: `estourou o prazo de ${Math.round(timeoutMs / 60000)}min` });
      }, timeoutMs);

      this.#oneShot.set(taskId, finish);
      void this.start(taskId, prompt, cwd, undefined, "bypassPermissions");
    });
  }

  async start(
    taskId: string, prompt: string, cwd: string, resume?: string,
    mode: "default" | "acceptEdits" | "bypassPermissions" = "default",
  ): Promise<void> {
    if (this.#sessions.has(taskId)) {
      this.#emit.delta(taskId, { k: "note", text: "an agent is already running on this task" });
      return;
    }

    const session: Session = { abort: new AbortController(), pending: new Map(), granted: [] };
    this.#sessions.set(taskId, session);

    const canUseTool = (
      toolName: string,
      input: Record<string, unknown>,
      opts: { signal: AbortSignal; suggestions?: PermissionUpdate[] },
    ): Promise<PermissionResult> =>
      new Promise<PermissionResult>((resolve) => {
        const requestId = `pr${++reqSeq}`;
        session.pending.set(requestId, { resolve, suggestions: opts.suggestions, tool: toolName });
        this.#emit.ask({
          requestId, taskId, tool: toolName, input,
          canAlways: (opts.suggestions?.length ?? 0) > 0,
        });
        // If the query is aborted, do not leave the promise hanging forever.
        opts.signal.addEventListener("abort", () => {
          if (session.pending.delete(requestId)) {
            resolve({ behavior: "deny", message: "interrompido" });
          }
        }, { once: true });
      });

    try {
      for await (const ev of query({
        prompt,
        options: {
          cwd,
          abortController: session.abort,
          canUseTool,

          /**
           * The IDE owns its own permission policy.
           *
           * Without this the SDK inherits ~/.claude/settings.json — including
           * `defaultMode: "auto"`, which auto-approves through the classifier
           * and makes `canUseTool` never fire. A gate that SOMETIMES fires is
           * worse than no gate: you cannot rely on it.
           *
           * Consensus variants are the exception: they run permissively because
           * they operate in a disposable worktree OUTSIDE the repository and
           * nobody is watching. The human gate does not disappear — it moves to
           * the ADOPTION of the result, where you decide with the consensus map
           * in hand instead of approving tool calls blind. The risk worth
           * naming: inside the worktree the agent runs commands freely, as
           * every parallel-agent tool does.
           *
           * "project" (and not `[]`) because CLAUDE.md and the REPOSITORY's
           * settings are versioned, reviewable and intentional — and it is
           * CLAUDE.md that teaches the agent this project's conventions. What
           * gets discarded is the user's global configuration.
           */
          settingSources: ["project"],
          permissionMode: mode,

          ...(resume ? { resume } : {}),
        },
      })) {
        this.#translate(taskId, session, ev);
      }
    } catch (e) {
      const msg = String(e);
      // An abort is a requested shutdown, not a failure — do not pollute the UI with an error.
      const aborted = session.abort.signal.aborted || /abort/i.test(msg);
      this.#finish({
        taskId, ok: aborted, ...(session.sessionId ? { sessionId: session.sessionId } : {}),
        ...(aborted ? {} : { error: msg.slice(0, 400) }),
      });
    } finally {
      this.#sessions.delete(taskId);
    }
  }

  /**
   * Translates the SDK's shape into `AgentDelta`.
   *
   * This method is the ONLY point of contact with the shape of the SDK's
   * events. The SDK is at 0.3.x with near-daily releases; confining the
   * translation here is what makes bumping it one function to fix rather than a
   * hunt.
   */
  #finish(r: { taskId: string; ok: boolean; costUsd?: number; turns?: number; sessionId?: string; error?: string }): void {
    this.#emit.done(r);
    const one = this.#oneShot.get(r.taskId);
    if (one) {
      this.#oneShot.delete(r.taskId);
      one({ ok: r.ok, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
            ...(r.sessionId ? { sessionId: r.sessionId } : {}),
            ...(r.error ? { error: r.error } : {}) });
    }
  }

  #translate(taskId: string, session: Session, ev: Record<string, unknown>): void {
    const type = ev["type"] as string;

    if (type === "system") {
      const sub = ev["subtype"] as string | undefined;
      if (typeof ev["session_id"] === "string") session.sessionId = ev["session_id"];
      if (sub && sub !== "init") this.#emit.delta(taskId, { k: "note", text: sub });
      return;
    }

    if (type === "assistant" || type === "user") {
      const msg = ev["message"] as { content?: unknown[] } | undefined;
      for (const b of msg?.content ?? []) {
        const block = b as Record<string, unknown>;
        switch (block["type"]) {
          case "text":
            this.#emit.delta(taskId, { k: "text", text: String(block["text"] ?? "") });
            break;
          case "thinking":
            this.#emit.delta(taskId, { k: "thinking" });
            break;
          case "tool_use":
            this.#emit.delta(taskId, {
              k: "tool",
              id: String(block["id"] ?? ""),
              name: String(block["name"] ?? "?"),
              input: block["input"],
            });
            break;
          case "tool_result":
            this.#emit.delta(taskId, {
              k: "toolResult",
              id: String(block["tool_use_id"] ?? ""),
              ok: block["is_error"] !== true,
              summary: summarize(block["content"]),
            });
            break;
        }
      }
      return;
    }

    if (type === "result") {
      if (typeof ev["session_id"] === "string") session.sessionId = ev["session_id"];
      this.#finish({
        taskId,
        ok: ev["subtype"] === "success",
        ...(typeof ev["total_cost_usd"] === "number" ? { costUsd: ev["total_cost_usd"] } : {}),
        ...(typeof ev["num_turns"] === "number" ? { turns: ev["num_turns"] } : {}),
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
        ...(ev["subtype"] !== "success" ? { error: String(ev["subtype"]) } : {}),
      });
    }
  }

  /**
   * Idempotent by requestId on purpose: the SDK's docs warn that a request
   * whose response was lost gets dispatched again, so resolving twice has to be
   * harmless.
   */
  resolvePermission(requestId: string, allow: boolean, always: boolean): void {
    for (const session of this.#sessions.values()) {
      const p = session.pending.get(requestId);
      if (!p) continue;
      session.pending.delete(requestId);

      if (!allow) {
        p.resolve({ behavior: "deny", message: "denied by the user" });
        return;
      }
      if (always && p.suggestions?.length) {
        // Returning the suggestions as updatedPermissions is what makes
        // "always allow" stick for the rest of the session.
        session.granted.push(...p.suggestions);
        p.resolve({ behavior: "allow", updatedPermissions: p.suggestions });
      } else {
        p.resolve({ behavior: "allow" });
      }
      return;
    }
  }

  interrupt(taskId: string): void {
    const s = this.#sessions.get(taskId);
    if (!s) return;
    s.abort.abort();
    for (const [id, p] of s.pending) {
      s.pending.delete(id);
      p.resolve({ behavior: "deny", message: "interrompido" });
    }
  }

  interruptAll(): void { for (const id of [...this.#sessions.keys()]) this.interrupt(id); }
}

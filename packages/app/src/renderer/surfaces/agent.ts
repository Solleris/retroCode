import type { AgentDelta } from "@retro/protocol";

declare const retro: { send(req: unknown): void };

import { t } from "../i18n.ts";
export interface PermissionAsk {
  requestId: string; taskId: string; tool: string; input: unknown; canAlways: boolean;
}

export interface AgentSurface {
  el: HTMLElement;
  taskId: string;
  feed(d: AgentDelta): void;
  ask(a: PermissionAsk): void;
  done(r: { ok: boolean; costUsd?: number; turns?: number; error?: string }): void;
  focus(): void;
  dispose(): void;
}

/**
 * A one-line summary of a tool call.
 *
 * A JSON dump per call makes the stream unreadable exactly when it gets
 * interesting (ten calls in a row). The argument that matters differs per tool,
 * so the table is explicit.
 */
function summarizeInput(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) if (typeof i[k] === "string") return i[k] as string;
    return "";
  };
  switch (name) {
    case "Bash": return pick("command");
    case "Read": case "Write": case "Edit": case "NotebookEdit": return pick("file_path", "path");
    case "Glob": case "Grep": return pick("pattern") + (i["path"] ? ` em ${i["path"]}` : "");
    case "WebFetch": return pick("url");
    case "Task": return pick("description");
    case "TodoWrite": return `${(i["todos"] as unknown[] | undefined)?.length ?? 0} items`;
    default: return pick("command", "file_path", "path", "pattern", "url", "description");
  }
}

export function createAgent(taskId: string, cwd: string): AgentSurface {
  const el = document.createElement("div");
  el.className = "surface surface-agent";

  const head = document.createElement("div");
  head.className = "ag-head";
  head.innerHTML = `<span class="ag-title">agente</span><span class="ag-state" data-s="idle">pronto</span>
    <span class="ag-spacer"></span><span class="ag-cost"></span>
    <button class="ag-stop" type="button" hidden>parar</button>`;
  const stateEl = head.querySelector<HTMLElement>(".ag-state")!;
  const costEl = head.querySelector<HTMLElement>(".ag-cost")!;
  const stopBtn = head.querySelector<HTMLButtonElement>(".ag-stop")!;

  const stream = document.createElement("div");
  stream.className = "ag-stream";

  const composer = document.createElement("div");
  composer.className = "ag-composer";
  const input = document.createElement("textarea");
  input.className = "ag-input";
  input.rows = 2;
  input.placeholder = t("ag.placeholder");
  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "ag-send";
  sendBtn.textContent = t("ag.send");
  composer.append(input, sendBtn);

  el.append(head, stream, composer);

  const toolRows = new Map<string, HTMLElement>();
  let running = false;

  const atBottom = (): boolean => stream.scrollHeight - stream.scrollTop - stream.clientHeight < 60;
  function append(node: HTMLElement): void {
    // Only scrolls if the user was already at the bottom. Dragging their view
    // down while they read something above is the worst possible behaviour in a
    // long stream.
    const stick = atBottom();
    stream.append(node);
    if (stick) stream.scrollTop = stream.scrollHeight;
  }

  function setState(s: "idle" | "running" | "needsYou" | "ok" | "fail", label: string): void {
    stateEl.dataset["s"] = s;
    stateEl.textContent = label;
    running = s === "running" || s === "needsYou";
    stopBtn.hidden = !running;
    input.disabled = running;
    sendBtn.disabled = running;
  }

  function send(): void {
    const prompt = input.value.trim();
    if (!prompt || running) return;
    input.value = "";
    const you = document.createElement("div");
    you.className = "ag-you";
    you.textContent = prompt;
    append(you);
    setState("running", "rodando");
    costEl.textContent = "";
    retro.send({ t: "startAgent", taskId, prompt, cwd });
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  stopBtn.addEventListener("click", () => retro.send({ t: "interruptAgent", taskId }));

  setState("idle", t("ag.idle"));

  return {
    el, taskId,
    focus: () => input.focus(),

    feed(d) {
      if (d.k === "text" && d.text.trim()) {
        const p = document.createElement("div");
        p.className = "ag-text";
        p.textContent = d.text;
        append(p);
      } else if (d.k === "thinking") {
        const th = document.createElement("div");
        th.className = "ag-thinking";
        th.textContent = t("ag.thinking");
        append(th);
      } else if (d.k === "tool") {
        const row = document.createElement("div");
        row.className = "ag-tool";
        const nm = document.createElement("span");
        nm.className = "ag-tool-name";
        nm.textContent = d.name;
        const arg = document.createElement("span");
        arg.className = "ag-tool-arg";
        arg.textContent = summarizeInput(d.name, d.input);
        row.append(nm, arg);
        toolRows.set(d.id, row);
        append(row);
      } else if (d.k === "toolResult") {
        const row = toolRows.get(d.id);
        if (row) {
          row.classList.add(d.ok ? "ok" : "err");
          if (d.summary.trim()) {
            const out = document.createElement("div");
            out.className = "ag-tool-out";
            // Only the first lines: the whole result belongs to the terminal
            // or the diff, not to the stream.
            out.textContent = d.summary.split("\n").slice(0, 6).join("\n");
            row.after(out);
          }
        }
      } else if (d.k === "note") {
        const n = document.createElement("div");
        n.className = "ag-note";
        n.textContent = d.text;
        append(n);
      }
    },

    ask(a) {
      setState("needsYou", t("ag.needsYou"));
      const card = document.createElement("div");
      card.className = "ag-gate";
      card.tabIndex = 0;

      const title = document.createElement("div");
      title.className = "ag-gate-title";
      title.textContent = t("ag.wantsToRun", { tool: a.tool });
      const body = document.createElement("pre");
      body.className = "ag-gate-body";
      body.textContent = summarizeInput(a.tool, a.input) || JSON.stringify(a.input, null, 2).slice(0, 600);

      const row = document.createElement("div");
      row.className = "ag-gate-actions";
      const mk = (label: string, cls: string, fn: () => void): HTMLButtonElement => {
        const b = document.createElement("button");
        b.type = "button"; b.className = `ag-gate-btn ${cls}`; b.textContent = label;
        b.addEventListener("click", fn);
        return b;
      };
      const settle = (allow: boolean, always: boolean): void => {
        retro.send({ t: "resolvePermission", requestId: a.requestId, allow, always });
        card.classList.add("settled");
        card.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
        title.textContent = allow ? (always ? t("ag.alwaysAllowed", { tool: a.tool }) : t("ag.approved", { tool: a.tool }))
                                  : t("ag.denied", { tool: a.tool });
        setState("running", "rodando");
        input.focus();
      };

      row.append(mk(t("ag.allow"), "allow", () => settle(true, false)));
      if (a.canAlways) row.append(mk(t("ag.always"), "always", () => settle(true, true)));
      row.append(mk("recusar esc", "deny", () => settle(false, false)));

      card.append(title, body, row);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); settle(true, e.altKey && a.canAlways); }
        if (e.key === "Escape") { e.preventDefault(); settle(false, false); }
      });
      append(card);
      // Focus the card: the gate is the only thing that matters at this
      // instant, and the keyboard has to resolve it without moving your hand.
      card.focus();
    },

    done(r) {
      setState(r.ok ? "ok" : "fail", r.ok ? "terminou" : "falhou");
      const bits: string[] = [];
      if (r.turns !== undefined) bits.push(`${r.turns} turno${r.turns === 1 ? "" : "s"}`);
      if (r.costUsd !== undefined) bits.push(`$${r.costUsd.toFixed(4)}`);
      costEl.textContent = bits.join(" · ");
      if (r.error) {
        const e = document.createElement("div");
        e.className = "ag-error";
        e.textContent = r.error;
        append(e);
      }
      input.focus();
    },

    dispose() { retro.send({ t: "interruptAgent", taskId }); },
  };
}

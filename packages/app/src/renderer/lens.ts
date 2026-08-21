/**
 * THE LENS — the right rail that gives structure to claude CLI sessions.
 *
 * It follows the FOCUSED TERMINAL: each terminal may sit in a different repo,
 * and the lens shows the sessions of that terminal's repo — not of the "open
 * project". The header says which repo it is talking about.
 *
 * The connectors (Linear/Notion) use the user's own claude MCP servers, via the
 * daemon. Clicking an item injects the prompt into the focused terminal WITHOUT
 * sending — you review it and press enter.
 */

import { icons } from "./icons.ts";
import { t } from "./i18n.ts";

export interface LensSession {
  id: string; title: string; branch: string;
  state: "working" | "yourTurn" | "maybeGate" | "idle";
  startedAt: number; lastAt: number;
  files: { path: string; edits: number; lastAt: number }[];
  todos: { content: string; status: string }[];
  lastText: string; turns: number;
  ctxTokens: number; ctxWindow: number; model: string;
  outTokens: number; inTokens: number;
  cacheReadTokens: number; cacheCreateTokens: number; costUsd: number;
}
export interface LinearIssue { id: string; title: string; state: string; url: string }
export interface NotionPage { title: string; url: string }

const STATE = {
  yourTurn:  { dot: "wait", label: t("lens.stateYourTurn") },
  maybeGate: { dot: "wait", label: t("lens.maybeGate") },
  working:   { dot: "run",  label: t("lens.working") },
  idle:      { dot: "idle", label: t("lens.idle") },
} as const;

export class Lens {
  #el: HTMLElement;
  #repoEl: HTMLElement;
  #list: HTMLElement;
  #detail: HTMLElement;
  #panel: HTMLElement;

  /** Sessions per repo — the lens switches repos without re-requesting. */
  #byProject = new Map<string, LensSession[]>();
  #project: string | null = null;
  #selectedId: string | null = null;
  #panelMode: "none" | "linear" | "notion" = "none";
  /** Sessions the IDE launched, and which one belongs to the focused pane. */
  #owned = new Set<string>();
  #focusedSession: string | undefined;

  #onOpenFile: (path: string) => void;
  #onInject: (text: string) => void;
  #onFetch: (what: "linear" | "notion", force: boolean) => void;
  #onPickIssue: (issue: LinearIssue) => void;
  #onPickPage: (page: NotionPage) => void;
  #onSessionDiff: (paths: string[]) => void;
  #onOpenBranch: (branch: string) => void;

  constructor(host: HTMLElement, cb: {
    onOpenFile: (path: string) => void;
    onInject: (text: string) => void;
    onFetch: (what: "linear" | "notion", force: boolean) => void;
    onPickIssue: (issue: LinearIssue) => void;
    onPickPage: (page: NotionPage) => void;
    onSessionDiff: (paths: string[]) => void;
    onOpenBranch: (branch: string) => void;
  }) {
    this.#el = host;
    this.#onOpenFile = cb.onOpenFile;
    this.#onInject = cb.onInject;
    this.#onFetch = cb.onFetch;
    this.#onPickIssue = cb.onPickIssue;
    this.#onPickPage = cb.onPickPage;
    this.#onSessionDiff = cb.onSessionDiff;
    this.#onOpenBranch = cb.onOpenBranch;

    host.innerHTML = `
      <div class="lens-repo"></div>
      <div class="lens-sec"><h2>${t("lens.sessions")}</h2><div class="lens-list"></div></div>
      <div class="lens-detail"></div>
      <div class="lens-panel" hidden></div>
      <div class="lens-chips">
        <button type="button" data-chip="linear">${icons.issue}<span>linear</span></button>
        <button type="button" data-chip="notion">${icons.doc}<span>notion</span></button>
      </div>`;
    this.#repoEl = host.querySelector(".lens-repo")!;
    this.#list = host.querySelector(".lens-list")!;
    this.#detail = host.querySelector(".lens-detail")!;
    this.#panel = host.querySelector(".lens-panel")!;

    host.querySelector('[data-chip="linear"]')!.addEventListener("click", () => this.#togglePanel("linear"));
    host.querySelector('[data-chip="notion"]')!.addEventListener("click", () => this.#togglePanel("notion"));
  }

  /**
   * Which sessions are "ours" and which belongs to the focused pane.
   *
   * With several sessions in the same repo, the list alone does not answer the
   * most basic question: which one is in front of me?
   */
  setOwnedSessions(owned: Set<string>, focused: string | undefined): void {
    this.#owned = owned;
    this.#focusedSession = focused;
    if (focused && this.#sessionExists(focused)) this.#selectedId = focused;
    this.#render();
  }

  #sessionExists(id: string): boolean {
    const list = this.#project ? this.#byProject.get(this.#project) ?? [] : [];
    return list.some((s) => s.id === id);
  }

  /** O terminal focado mudou de repo → a lente segue. */
  setProject(project: string | null): void {
    if (project === this.#project) return;
    this.#project = project;
    this.#selectedId = null;
    this.#repoEl.textContent = project ? (project.split("/").pop() ?? project) : "—";
    this.#render();
  }

  update(project: string, sessions: LensSession[]): void {
    this.#byProject.set(project, sessions);
    if (project === this.#project) this.#render();
  }

  waiting(): number {
    let n = 0;
    for (const sessions of this.#byProject.values()) {
      n += sessions.filter((s) => s.state === "yourTurn" || s.state === "maybeGate").length;
    }
    return n;
  }

  // ── conectores ─────────────────────────────────────────────────────
  #togglePanel(mode: "linear" | "notion"): void {
    if (this.#panelMode === mode) { this.closePanel(); return; }
    this.#panelMode = mode;
    this.#panel.hidden = false;
    this.#paintChips();
    this.#panel.innerHTML = `<div class="lens-loading">${t("lens.mcpFetching")}</div>`;
    this.#onFetch(mode, false);
  }

  closePanel(): void {
    this.#panelMode = "none";
    this.#panel.hidden = true;
    this.#paintChips();
  }

  #paintChips(): void {
    this.#el.querySelectorAll(".lens-chips button").forEach((b) =>
      b.classList.toggle("on", (b as HTMLElement).dataset["chip"] === this.#panelMode));
  }

  showLinear(issues: LinearIssue[], fresh: boolean, error?: string): void {
    if (this.#panelMode !== "linear") return;
    this.#panel.replaceChildren(panelHead(t("lens.linearTitle"), fresh,
      () => this.#onFetch("linear", true)));
    if (error) { this.#panel.append(note(t("lens.mcpFailed", { msg: error }))); return; }
    if (!issues.length) { this.#panel.append(note(t("lens.linearEmpty"))); return; }
    for (const i of issues) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "lens-item";
      row.innerHTML = `<span class="lens-item-id">${esc(i.id)}</span>
        <span class="lens-item-title">${esc(i.title)}</span>
        <span class="lens-item-meta">${esc(i.state)}</span>`;
      row.title = t("lens.issueTitle");
      row.addEventListener("click", () => {
        row.classList.add("busy");
        this.#onPickIssue(i);
      });
      this.#panel.append(row);
    }
  }

  /**
   * Content delivered to the composer → the panel closes itself.
   *
   * Once the issue or page is chosen, what matters is the text that just landed
   * in the terminal — a panel taking half the rail in front of that is
   * clutter. Anyone wanting another issue clicks the chip again (and the cache
   * makes reopening instant).
   */
  settle(): void {
    this.#panel.querySelectorAll(".busy").forEach((r) => r.classList.remove("busy"));
    this.closePanel();
  }

  showNotion(pages: NotionPage[], fresh: boolean, error?: string): void {
    if (this.#panelMode !== "notion") return;
    this.#panel.replaceChildren(panelHead(t("lens.notionTitle"), fresh,
      () => this.#onFetch("notion", true)));
    if (error) { this.#panel.append(note(t("lens.mcpFailed", { msg: error }))); return; }
    if (!pages.length) { this.#panel.append(note(t("lens.notionEmpty"))); return; }
    for (const pg of pages) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "lens-item";
      row.innerHTML = `<span class="lens-item-title">${esc(pg.title)}</span>`;
      row.title = t("lens.pageTitle");
      row.addEventListener("click", () => {
        row.classList.add("busy");
        this.#onPickPage(pg);
      });
      this.#panel.append(row);
    }
  }

  // ── sessions ───────────────────────────────────────────────────────
  #render(): void {
    const sessions = this.#project ? (this.#byProject.get(this.#project) ?? []) : [];
    if (!this.#selectedId || !sessions.some((s) => s.id === this.#selectedId)) {
      this.#selectedId = sessions[0]?.id ?? null;
    }
    this.#list.replaceChildren();
    if (!sessions.length) {
      const e = document.createElement("div");
      e.className = "lens-empty";
      e.textContent = t("lens.noSessions");
      this.#list.append(e);
    }
    for (const s of sessions) {
      const st = STATE[s.state];
      const row = document.createElement("button");
      row.type = "button";
      const mine = this.#owned.has(s.id);
      const isFocused = s.id === this.#focusedSession;
      row.className = "lens-row"
        + (s.id === this.#selectedId ? " sel" : "")
        + (mine ? " mine" : "")
        + (isFocused ? " focused-pane" : "");
      if (isFocused) row.title = t("lens.hereTitle");
      const pct = s.ctxWindow ? Math.round((s.ctxTokens / s.ctxWindow) * 100) : 0;
      row.innerHTML = `<span class="dot ${st.dot}"></span>
        <span class="lens-title">${esc(s.title)}</span>
        ${isFocused ? `<span class="lens-here">${t("lens.here")}</span>` : ""}
        ${pct >= 40 ? `<span class="lens-ctx ${ctxTier(pct)}">${pct}%</span>` : ""}
        <span class="lens-ago">${ago(s.lastAt)}</span>`;
      row.addEventListener("click", () => { this.#selectedId = s.id; this.#render(); });
      this.#list.append(row);
    }
    this.#renderDetail(sessions);
  }

  #renderDetail(sessions: LensSession[]): void {
    this.#detail.replaceChildren();
    const s = sessions.find((x) => x.id === this.#selectedId);
    if (!s) return;
    const st = STATE[s.state];

    /*
     * A two-line header, not one running sentence.
     *
     * The previous version queued state, turns, branch and model into a
     * paragraph that wrapped at any rail width. Now: state on the left, model
     * on the right (it is an attribute of the session, not narrative), and the
     * branch on a second line only when there is one.
     */
    const head = document.createElement("div");
    head.className = "lens-head2";
    head.innerHTML = `<span class="dot ${st.dot}"></span>
      <span class="lens-st">${st.label}</span>
      <span class="lens-grow"></span>
      ${s.model ? `<span class="lens-model">${esc(shortModel(s.model))}</span>` : ""}`;
    this.#detail.append(head);

    if (s.branch) {
      // A detached HEAD has no page on the remote — it stays text, not a link.
      const detached = s.branch === "HEAD";
      const br = document.createElement(detached ? "div" : "button");
      br.className = "lens-branch" + (detached ? "" : " link");
      br.innerHTML = `${icons.branch}<span>${esc(s.branch)}</span>`;
      if (!detached) {
        (br as HTMLButtonElement).type = "button";
        br.title = t("lens.branchTitle");
        br.addEventListener("click", () => this.#onOpenBranch(s.branch));
      }
      this.#detail.append(br);
    }

    // Context bar: a bar is a bar, a number is a number — the label moved off
    // the fill, where the text fought the colour for contrast.
    if (s.ctxTokens > 0) {
      const pct = Math.min(100, Math.round((s.ctxTokens / s.ctxWindow) * 100));
      const wrap = document.createElement("div");
      wrap.className = `lens-ctx2 ${ctxTier(pct)}`;
      wrap.innerHTML = `
        <div class="lens-ctxtop">
          <span>${t("lens.context")}</span>
          <span class="lens-ctxnum">${fmt(s.ctxTokens)} / ${fmt(s.ctxWindow)}</span>
          <span class="lens-ctxpct">${pct}%</span>
        </div>
        <div class="lens-ctxtrack"><div class="lens-ctxfill" style="width:${pct}%"></div></div>`;
      this.#detail.append(wrap);
    }

    /*
     * USAGE = the cost. Nothing else.
     *
     * The previous version showed turns, output and cache — three
     * implementation details competing for space with the only thing that
     * answers "what did this session cost me?". You decide nothing with tokens
     * and turns; you do with money.
     */
    const usage = document.createElement("div");
    usage.className = "lens-usage";
    usage.innerHTML = `<span class="lens-uk">${t("lens.usage")}</span>
      <span class="lens-uv">${s.costUsd >= 0.01 ? `≈$${s.costUsd < 10 ? s.costUsd.toFixed(2) : s.costUsd.toFixed(0)}` : "—"}</span>`;
    usage.title = t("lens.costTitle");
    this.#detail.append(usage);

    if (s.files.length) {
      const diffBtn = document.createElement("button");
      diffBtn.type = "button";
      diffBtn.className = "lens-diff-btn";
      diffBtn.innerHTML = `${icons.diff}<span>${t("lens.seeDiff", { n: s.files.length })}</span>`;
      diffBtn.addEventListener("click", () => this.#onSessionDiff(s.files.map((f) => f.path)));
      this.#detail.append(diffBtn);
      this.#detail.append(sec(t("lens.files")));
      for (const f of s.files.slice(0, 12)) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "lens-file";
        row.innerHTML = `<span class="lens-fname">${esc(f.path.split("/").pop() ?? f.path)}</span>
          <span class="lens-fmeta">×${f.edits}</span>`;
        row.title = f.path;
        row.addEventListener("click", () => this.#onOpenFile(f.path));
        this.#detail.append(row);
      }
    }
    if (s.todos.length) {
      this.#detail.append(sec(t("lens.plan")));
      for (const t of s.todos.slice(0, 10)) {
        const row = document.createElement("div");
        row.className = "lens-todo " + t.status;
        row.textContent = (t.status === "completed" ? "✓ " : t.status === "in_progress" ? "◐ " : "○ ") + t.content;
        this.#detail.append(row);
      }
    }
  }
}

function panelHead(title: string, fresh: boolean, onRefresh: () => void): HTMLElement {
  const h = document.createElement("div");
  h.className = "lens-panel-head";
  // `label`, not `t`: the i18n `t` is imported at module scope and a local of
  // the same name shadows it. tsc caught it; at runtime it would have been
  // "t is not a function".
  const label = document.createElement("span");
  label.textContent = title + (fresh ? "" : " · cache");
  const r = document.createElement("button");
  r.type = "button";
  r.innerHTML = icons.refresh;
  r.title = t("lens.mcpRefresh");
  r.addEventListener("click", onRefresh);
  h.append(label, r);
  return h;
}
function note(text: string): HTMLElement {
  const e = document.createElement("div");
  e.className = "lens-loading";
  e.textContent = text;
  return e;
}
/**
 * The context colour ladder — the same in both places (row and bar), because
 * two different scales for the same number is misinformation:
 *   <40 does not appear · 40s blue · 60s amber · 75s orange · 85+ red
 */
function ctxTier(pct: number): string {
  return pct >= 85 ? "t4" : pct >= 75 ? "t3" : pct >= 60 ? "t2" : pct >= 40 ? "t1" : "t0";
}

/** "claude-fable-5" → "fable-5"; "claude-haiku-4-5-20251001" → "haiku-4-5". */
function shortModel(m: string): string {
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/** 214051261 → "214M"; 633218 → "633k". Long numbers do not fit the rail. */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function sec(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.textContent = text;
  return h;
}
function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}min`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}
function esc(s: string): string {
  const d = document.createElement("span");
  d.textContent = s;
  return d.innerHTML;
}

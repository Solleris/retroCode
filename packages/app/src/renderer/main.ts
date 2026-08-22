import "@xterm/xterm/css/xterm.css";
import "./style.css";
import type { Surface } from "@retro/protocol/layout";
import { isPaneNode } from "@retro/protocol/layout";
import { TilingHost } from "./tiling.ts";
import { createTerminal, type TerminalSurface } from "./surfaces/terminal.ts";
import { createDocument, type DocumentSurface } from "./surfaces/document.ts";
import { createDiffView, type DiffSurface, type DiffFile } from "./surfaces/diffview.ts";
import { t } from "./i18n.ts";
import { applyConfig, reconcileLanguage, config as cfg } from "./config.ts";
import { createSettings, type SettingsSurface } from "./surfaces/settings.ts";
import type { RetroConfig } from "@retro/protocol";
import { Sidebar } from "./sidebar.ts";
import { Palette, type Command } from "./palette.ts";
import { icons } from "./icons.ts";
import { Lens, type LensSession, type LinearIssue, type NotionPage } from "./lens.ts";

declare const retro: {
  send(req: unknown): void;
  write(ptyId: string, data: Uint8Array): void;
  pickFolder(): Promise<string | null>;
  openExternal(url: string): Promise<boolean>;
  daemonStatus(): Promise<{ state: "open" | "close"; detail?: string }>;
  onControl(cb: (ev: unknown) => void): void;
  onPty(cb: (ptyId: string, data: Uint8Array) => void): void;
  onStatus(cb: (s: "open" | "close", detail?: string) => void): void;
};

// ── estado ─────────────────────────────────────────────────────────────
let root = "";
let booted = false;
const terms = new Map<string, TerminalSurface>();
const docs = new Map<string, DocumentSurface>();
const diffs = new Map<string, DiffSurface>();     // root do repo → pane de diff
/*
 * Only ONE settings pane. Two open would diverge silently: each holds the
 * config it received, and the last one to write would win.
 */
let settings: SettingsSurface | null = null;
let configPath = "";
let configProblem: string | undefined;
let diffSeq = 0;
const openOrder: string[] = [];
const enc = new TextEncoder();

const $ = <T extends HTMLElement>(s: string): T => document.querySelector<T>(s)!;
const pathEl = $("#path"), hintEl = $("#hint"), statusEl = $("#status"), attEl = $("#attention");

const rel = (a: string): string => (a.startsWith(root + "/") ? a.slice(root.length + 1) : a);
const newTerminal = (): Surface => ({ s: "terminal", ptyId: `pty-${crypto.randomUUID().slice(0, 8)}` });

// ── navigation (⌘E overlay) ────────────────────────────────────────────
const navWrap = $("#navwrap");
/**
 * The tree has two modes: overlay (default, dismissed by clicking outside) and
 * PINNED (a permanent left panel). The preference persists — someone who browses
 * the tree all day should not have to reopen it on every click.
 */
let navPinned = localStorage.getItem("retro.navPinned") === "1";
function applyPin(): void {
  document.body.classList.toggle("nav-pinned", navPinned);
  if (navPinned) navWrap.hidden = false;
  localStorage.setItem("retro.navPinned", navPinned ? "1" : "0");
  window.dispatchEvent(new Event("retro:relayout"));
}
const toggleNav = (): void => { if (!navPinned) navWrap.hidden = !navWrap.hidden; };
const closeNav = (): void => { if (!navPinned) navWrap.hidden = true; };
navWrap.addEventListener("mousedown", (e) => { if (e.target === navWrap) closeNav(); });
window.addEventListener("retro:toggle-pin", () => { navPinned = !navPinned; applyPin(); });
applyPin();

const sidebar = new Sidebar($("#nav"), {
  onPickOpen: (r) => { closeNav(); openFileAbs(`${root}/${r}`); },
  onOpenFileAbs: (a) => { closeNav(); openFileAbs(a); },
  onOpenProject: () => void pickProject(),
  onSwitchProject: switchProject,
});
const palette = new Palette((r) => openFileAbs(`${root}/${r}`));

// ── lente ──────────────────────────────────────────────────────────────
const lens = new Lens($("#lens"), {
  onOpenFile: openFileAbs,
  onInject: injectIntoFocusedTerminal,
  onFetch: (what, force) => retro.send(what === "linear" ? { t: "fetchLinear", force } : { t: "fetchNotion", force }),
  onPickIssue: (i) => retro.send({ t: "fetchLinearIssue", id: i.id }),
  onPickPage: (p) => retro.send({ t: "fetchNotionPage", url: p.url, title: p.title }),
  onSessionDiff: (paths) => openDiff(paths),
  onFocusSession: focusSessionPane,
  onResumeSession: resumeClaudeSession,
  onOpenBranch: (branch) => {
    const project = (focusedPty ? ptyProjects.get(focusedPty) : null) ?? root;
    retro.send({ t: "branchUrl", root: project, branch });
  },
});

/** ptyId → the repo the daemon resolved (shell's real cwd + git root). */
const ptyProjects = new Map<string, string>();
/** ptyId → the shell's real cwd, so the next terminal is born there. */
const ptyCwds = new Map<string, string>();
/** ptyId → the sessionId of the claude WE launched in that pane. */
const ptySessions = new Map<string, string>();
let focusedPty: string | null = null;

/**
 * Launch lines waiting for their pty to EXIST.
 *
 * Writing straight after the split looks right and loses the bytes.
 * `PtyManager.write` drops anything addressed to a ptyId it does not know (the
 * early `if (!e?.alive) return`), and `createTerminal` only asks for the spawn
 * on the next animation frame — so the command raced ahead of the pty and
 * vanished. Measured against a running daemon: a write sent before
 * `spawnTerminal` never reaches the shell; the same write after it does.
 *
 * The comment this replaces reasoned that input typed before the shell finished
 * booting would sit in the TTY buffer and run afterwards. True — and about a pty
 * that exists. The problem was never the shell's readiness.
 *
 * So the line waits for `terminalSpawned`, the one moment the app knows there is
 * something to receive it.
 */
const pendingLaunch = new Map<string, string>();

/** Types `line` into that pane as soon as its pty is real. Newline included. */
function launchIn(ptyId: string, line: string): void {
  pendingLaunch.set(ptyId, line);
}

function refreshLensProject(): void {
  if (focusedPty) {
    retro.send({ t: "resolvePtyProject", ptyId: focusedPty });
    const known = ptyProjects.get(focusedPty);
    if (known) lens.setProject(known);
  } else {
    lens.setProject(root);
  }
}
// The user may cd inside the shell: re-check the focused terminal's repo at a
// slow cadence. lsof is cheap; the lens must not stay stuck on the old repo.
setInterval(refreshLensProject, 8000);

/**
 * Types into the focused terminal WITHOUT sending. The IDE composes the text;
 * you review it and press enter. That is the contract that keeps the human in
 * charge — the lens never submits anything on its own.
 */
function injectIntoFocusedTerminal(text: string): void {
  const leaf = tiling.allLeaves().find((l) => l.id === tiling.focused && l.surface.s === "terminal")
    ?? tiling.allLeaves().find((l) => l.surface.s === "terminal");
  if (!leaf || leaf.surface.s !== "terminal") return;
  retro.write(leaf.surface.ptyId, enc.encode(text));
  terms.get(leaf.surface.ptyId)?.focus();
}

/**
 * PASTES into the focused terminal via bracketed paste (ESC[200~ … ESC[201~).
 *
 * This is what makes an issue's or a page's content land IN claude's composer
 * as a compact "[Pasted text #N]" — instead of thousands of typed characters
 * flooding the screen. And it still does not send: the final instruction and
 * the enter are yours. In plain zsh bracketed paste is safe too — the text
 * lands as an editable buffer, nothing executes.
 */
function pasteIntoFocusedTerminal(text: string): void {
  injectIntoFocusedTerminal(`\x1b[200~${text}\x1b[201~`);
}

window.addEventListener("retro:pick-file-for-context", () => {
  palette.openWith("files", (relPath) => injectIntoFocusedTerminal(`@${relPath} `));
});

// ── tiling ─────────────────────────────────────────────────────────────
const tiling = new TilingHost($("#stage"), { s: "empty" }, {
  mount(_id, surface) {
    if (surface.s === "terminal") {
      // Inherits the focused terminal's cwd; falls back to the project root.
      const inherited = focusedPty ? ptyCwds.get(focusedPty) : undefined;
      const t = createTerminal(surface.ptyId, inherited ?? root ?? ".");
      terms.set(surface.ptyId, t);
      return t.el;
    }
    if (surface.s === "editor") {
      const d = createDocument(surface.path, refreshOpen);
      docs.set(surface.path, d);
      retro.send({ t: "readFile", path: surface.path });
      return d.el;
    }
    if (surface.s === "diff") {
      const [droot, ...paths] = surface.taskId.split("\u0000");
      const dv = createDiffView(droot!, paths);
      diffs.set(droot!, dv);
      return dv.el;
    }
    if (surface.s === "settings") {
      settings = createSettings();
      settings.render(cfg(), configPath, configProblem);
      // Pull again on open: the config may have changed on disk while the
      // pane was closed, and initial state is pulled.
      retro.send({ t: "readConfig" });
      return settings.el;
    }
    const el = document.createElement("div");
    el.className = "surface surface-empty";
    el.innerHTML = `<div class="ph"><span class="ph-name">${t("app.emptyPane")}</span><span class="ph-phase">${t("app.emptyHint")}</span></div>`;
    return el;
  },
  unmount(_id, surface) {
    if (surface.s === "terminal") {
      terms.get(surface.ptyId)?.dispose();
      terms.delete(surface.ptyId);
      ptySessions.delete(surface.ptyId);
      ptyCwds.delete(surface.ptyId);
      pendingLaunch.delete(surface.ptyId);
    } else if (surface.s === "editor") {
      docs.get(surface.path)?.dispose();
      docs.delete(surface.path);
      const i = openOrder.indexOf(surface.path);
      if (i >= 0) openOrder.splice(i, 1);
    } else if (surface.s === "diff") {
      const droot = surface.taskId.split("\u0000")[0]!;
      diffs.get(droot)?.dispose();
      diffs.delete(droot);
    } else if (surface.s === "settings") {
      settings?.dispose();
      settings = null;
    }
  },
  onFocus(_id, surface) {
    if (surface.s === "terminal") {
      terms.get(surface.ptyId)?.focus();
      focusedPty = surface.ptyId;
      refreshLensProject();
      lens.setOwnedSessions(new Set(ptySessions.values()), ptySessions.get(surface.ptyId));
    }
    if (surface.s === "editor") {
      docs.get(surface.path)?.focus();
      sidebar.tree.setActive(surface.path);
    }
    if (surface.s === "diff") diffs.get(surface.taskId.split("\u0000")[0]!)?.refresh();
    if (surface.s === "settings") settings?.focus();
    pathEl.textContent = surface.s === "settings" ? t("set.title")
      : surface.s === "diff" ? `diff · ${surface.taskId.split("\u0000")[0]!.split("/").pop()}`
      : surface.s === "editor" ? rel(surface.path)
      : root.split("/").pop() ?? "retro";
    refreshOpen();
  },
  onLayoutChange(tree) {
    /*
     * Layout saved per project.
     *
     * It stopped being a luxury when changing the language began reloading the
     * window: without this, editing a preference threw away the pane
     * arrangement and orphaned live ptys in the daemon. Persisting turns the
     * reload into something the user never notices.
     */
    try { localStorage.setItem(layoutKey(), JSON.stringify(tree)); } catch { /* quota full: carry on */ }
  },
});

// ── abrir arquivo / projeto ────────────────────────────────────────────
function openFileAbs(path: string): void {
  const existing = tiling.allLeaves().find((l) => l.surface.s === "editor" && l.surface.path === path);
  if (existing) { tiling.focus(existing.id); return; }
  if (!openOrder.includes(path)) openOrder.push(path);
  const leaves = tiling.allLeaves();
  const focused = leaves.find((l) => l.id === tiling.focused);
  const target = focused && (focused.surface.s === "editor" || focused.surface.s === "empty")
    ? focused.id
    : leaves.find((l) => l.surface.s === "editor")?.id ?? null;
  if (target) tiling.setSurface(target, { s: "editor", path });
  else tiling.split("h", { s: "editor", path });
}

function refreshOpen(): void {
  const l = tiling.allLeaves().find((x) => x.id === tiling.focused);
  const active = l && l.surface.s === "editor" ? rel(l.surface.path) : null;
  sidebar.setOpenFiles(openOrder.map((abs) => ({
    rel: rel(abs), abs,
    dirty: docs.get(abs)?.isDirty() ?? false,
    active: rel(abs) === active,
  })));
}

async function pickProject(): Promise<void> {
  const picked = await retro.pickFolder();
  if (picked) switchProject(picked);
}

function switchProject(path: string): void {
  if (path === root) return;
  root = path;
  for (const l of tiling.allLeaves()) {
    if (l.surface.s === "editor") tiling.setSurface(l.id, { s: "empty" });
  }
  openOrder.length = 0;
  docs.clear();
  pathEl.textContent = path.split("/").pop() ?? "retro";
  sidebar.setProject(path.split("/").pop() ?? "projeto");
  loadProject(path);
  closeNav();
}

function loadProject(path: string): void {
  retro.send({ t: "indexProject", path });
  retro.send({ t: "recentProjects" });
  sidebar.tree.setRoot(path, path.split("/").pop() ?? "projeto");
}

// ── new claude session ─────────────────────────────────────────────────
/**
 * ⌘J: a new terminal already running `claude` — with a `--session-id` WE
 * generate.
 *
 * That is what lets the lens say "this session belongs to your left pane".
 * Without passing the id, the transcript and the pty have nothing in common and
 * the correlation would only come from a timestamp heuristic — fragile exactly
 * when there are several sessions, which is when the information matters.
 *
 * The real CLI, untouched. Input typed before the shell finishes starting sits
 * in the TTY buffer and runs afterwards, so there is no race.
 */
function newClaudeSession(): void {
  const surface = newTerminal();
  const sessionId = crypto.randomUUID();
  tiling.split("h", surface);
  if (surface.s === "terminal") {
    ptySessions.set(surface.ptyId, sessionId);
    launchIn(surface.ptyId, `claude --session-id ${sessionId}`);
    lens.setOwnedSessions(new Set(ptySessions.values()), sessionId);
  }
}

/**
 * A lens row → the pane running it.
 *
 * `ptySessions` is indexed the way the writer needs it (ptyId → sessionId,
 * written when ⌘J launches the CLI); reading it backwards is a scan over at
 * most a handful of live terminals, so an inverse map would be a second thing
 * to keep in sync for nothing.
 *
 * A miss is normal, not an error: `unmount` drops the entry when the pane
 * closes, and the lens keeps showing the session because its transcript is
 * still on disk. The row simply stays selected — and the resume button appears,
 * because the session stopped being one of ours.
 */
function focusSessionPane(sessionId: string): void {
  const ptyId = [...ptySessions].find(([, id]) => id === sessionId)?.[0];
  if (!ptyId) return;
  const leaf = tiling.allLeaves()
    .find((l) => l.surface.s === "terminal" && l.surface.ptyId === ptyId);
  if (leaf) tiling.focus(leaf.id);
}

/**
 * A pane for a session that no longer has one: `claude --resume <id>`.
 *
 * Two things make this correct rather than approximate:
 *
 * 1. `--resume` REUSES the session id — creating a new one is opt-in behind
 *    `--fork-session`. So registering the id in `ptySessions` right away is
 *    honest, and the row this came from immediately shows `aqui`.
 *
 * 2. The CLI resolves `--resume` against the CWD's project directory, and the
 *    daemon watches `~/.claude/projects/<munge(gitRoot)>` — so every session in
 *    the list was started AT the repo root. A new pane, however, is born in the
 *    focused terminal's cwd, which may be a subdirectory someone cd'd into.
 *    Hence the `cd`, emitted only when the two actually differ: in the common
 *    case the terminal shows the bare `claude --resume` and nothing else.
 *
 * Same idiom as `onOpenBranch` for the project — literally the expression
 * `refreshLensProject` uses, so what we resume against is what the lens shows.
 */
function resumeClaudeSession(sessionId: string): void {
  const project = (focusedPty ? ptyProjects.get(focusedPty) : null) ?? root;
  const born = (focusedPty ? ptyCwds.get(focusedPty) : null) ?? root;
  const surface = newTerminal();
  tiling.split("h", surface);
  if (surface.s !== "terminal") return;
  ptySessions.set(surface.ptyId, sessionId);
  const prefix = born === project ? "" : `cd ${shq(project)} && `;
  launchIn(surface.ptyId, `${prefix}claude --resume ${sessionId}`);
  lens.setOwnedSessions(new Set(ptySessions.values()), sessionId);
}

/** POSIX single-quoting: a repo path may hold a space, and may hold a quote. */
function shq(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/**
 * ⇧⌘G: the diff of the focused terminal's repo — the question "what did claude
 * change?" answered against HEAD. Reuses that repo's existing pane if there is
 * one.
 */
function openDiff(paths?: string[]): void {
  const project = (focusedPty ? ptyProjects.get(focusedPty) : null) ?? root;
  const key = [project, ...(paths ?? [])].join("\u0000");
  const existing = tiling.allLeaves().find((l) => l.surface.s === "diff" && l.surface.taskId.split("\u0000")[0] === project);
  if (existing) {
    tiling.setSurface(existing.id, { s: "diff", taskId: key });
    tiling.focus(existing.id);
    return;
  }
  tiling.split("h", { s: "diff", taskId: key });
  diffSeq++;
}

function saveFocused(): void {
  const l = tiling.allLeaves().find((x) => x.id === tiling.focused);
  if (l?.surface.s === "editor") docs.get(l.surface.path)?.save();
}

// ── comandos ───────────────────────────────────────────────────────────
$("#proj").querySelector(".caret")!.innerHTML = icons.chevron;
$("#proj").addEventListener("click", toggleNav);

/** One key per project: different repos deserve different arrangements. */
function layoutKey(): string { return `retro.layout:${root}`; }

/** One pane only: if it already exists, focus it instead of opening another. */
function openSettings(): void {
  const existente = tiling.allLeaves().find((l) => l.surface.s === "settings");
  if (existente) { tiling.focus(existente.id); return; }
  tiling.split("h", { s: "settings" });
}

/**
 * Commands = the built-ins plus the ones from config.json.
 *
 * Recomposed on every config event rather than assembled once at startup:
 * adding a command to the file has to show up in the palette without a
 * restart, otherwise "customisable" becomes "customisable if you quit the app".
 */
function rebuildCommands(): void {
  const embutidos: Command[] = [
  { id: "claude", label: t("cmd.claude"), hint: "⌘J", run: newClaudeSession },
  { id: "ctx-file", label: t("cmd.ctxFile"), hint: "@",
    run: () => window.dispatchEvent(new CustomEvent("retro:pick-file-for-context")) },
  { id: "open", label: t("cmd.open"), hint: "⌘P", run: () => palette.open("files") },
  { id: "proj", label: t("cmd.proj"), hint: "⌘O", run: () => void pickProject() },
  { id: "tree", label: t("cmd.tree"), hint: "⌘E", run: toggleNav },
  { id: "term", label: t("cmd.term"), hint: "⌘T", run: () => tiling.split("h", newTerminal()) },
  { id: "splitD", label: t("cmd.splitD"), hint: "⌘D", run: () => tiling.split("v", newTerminal()) },
  // The side split existed only as a shortcut, advertised nowhere: anyone who
  // had not read the code did not know it was possible. A command that does not
  // appear in the palette is a command that does not exist.
  { id: "splitR", label: t("cmd.splitR"), hint: "⇧⌘D", run: () => tiling.split("h", newTerminal()) },
  { id: "close", label: t("cmd.close"), hint: "⌘W", run: () => tiling.closeFocused() },
  { id: "save", label: t("cmd.save"), hint: "⌘S", run: saveFocused },
  { id: "diff", label: t("cmd.diff"), hint: "⇧⌘G", run: () => openDiff() },
  { id: "settings", label: t("cmd.settings"), hint: "⌘,", run: openSettings },
  ];

  /*
   * The monitor command (k9s/btop) USED TO LIVE here, hardcoded. It became a
   * default entry in config.json: a tiled terminal already is the monitor, and
   * "open a terminal running X" is the generic shape — it did not deserve a
   * special case in code when the file does the same thing and is editable.
   */
  const doArquivo: Command[] = cfg().commands.map((c) => ({
    id: c.id,
    label: c.label,
    ...(c.hint ? { hint: c.hint } : {}),
    run: () => {
      const surface = newTerminal();
      tiling.split("v", surface);
      // Same race as ⌘J had: this used to write before the pty existed, so a
      // command from config.json opened a terminal and then did nothing.
      if (surface.s === "terminal") launchIn(surface.ptyId, c.run);
    },
  }));

  palette.setCommands([...embutidos, ...doArquivo]);
}
rebuildCommands();

// ── eventos do daemon ──────────────────────────────────────────────────
retro.onPty((ptyId, data) => terms.get(ptyId)?.feed(data));

retro.onControl((ev) => {
  const e = ev as Record<string, unknown> & { t: string };
  switch (e.t) {
    case "ready":
      if (booted) loadProject(root);
      booted = true;
      return;
    case "projectIndexed": {
      const files = e["files"] as string[];
      palette.setFiles(files);
      sidebar.setProject((e["name"] as string) ?? "projeto");
      hintEl.textContent = t("app.footHint");
      return;
    }
    case "claudeSessions": {
      const sessions = e["sessions"] as LensSession[];
      lens.update(e["project"] as string, sessions);
      const n = lens.waiting();
      // The bar sums attention AND the worst active context: knowing WHICH
      // session is approaching the limit before it compacts.
      const active = sessions.filter((x) => x.state !== "idle" && x.ctxTokens > 0);
      const worst = active.length
        ? Math.max(...active.map((x) => Math.round((x.ctxTokens / x.ctxWindow) * 100))) : 0;
      attEl.innerHTML = [
        n ? `● ${n} ${t("lens.yourTurn")}` : "",
        worst >= 60 ? `<b class="${worst >= 85 ? "at-bad" : "at-wait"}">◐ ctx ${worst}%</b>` : "",
      ].filter(Boolean).join(" · ");
      return;
    }

    /*
     * The pty is up — so anything queued for it can go now.
     *
     * This is the first thing in the app to listen to `terminalSpawned` at all:
     * the event was being broadcast and dropped on the floor, which is exactly
     * why the race above went unnoticed.
     */
    case "terminalSpawned": {
      const ptyId = e["ptyId"] as string;
      const pending = pendingLaunch.get(ptyId);
      if (pending === undefined) return;
      pendingLaunch.delete(ptyId);
      retro.write(ptyId, enc.encode(`${pending}\n`));
      return;
    }

    case "ptyProject": {
      const ptyId = e["ptyId"] as string, project = e["project"] as string | null;
      if (project) {
        ptyProjects.set(ptyId, project);
        if (ptyId === focusedPty) lens.setProject(project);
      }
      const cwd = e["cwd"] as string | null;
      if (cwd) ptyCwds.set(ptyId, cwd);
      return;
    }

    case "branchUrlResult": {
      const url = e["url"] as string | null;
      if (url) void retro.openExternal(url);
      return;
    }

    case "config": {
      const conf = e["config"] as RetroConfig;
      configPath = e["path"] as string;
      configProblem = e["problem"] as string | undefined;

      /*
       * Language first, and if it changed the window reloads — there is no
       * point applying a theme and recomposing commands in a document that is
       * about to go away.
       */
      if (reconcileLanguage(conf)) { location.reload(); return; }

      applyConfig(conf);
      rebuildCommands();
      settings?.render(conf, configPath, configProblem);
      return;
    }

    case "gitDiffFiles": {
      diffs.get(e["root"] as string)?.render(e["files"] as DiffFile[], e["error"] as string | undefined);
      return;
    }

    case "linearIssueContent": {
      lens.settle();
      const md = e["markdown"] as string;
      if (md) pasteIntoFocusedTerminal(md + "\n");
      else if (e["error"]) injectIntoFocusedTerminal(
        t("inject.linear", { id: String(e["id"]) }));
      return;
    }

    case "notionPageContent": {
      lens.settle();
      const md = e["markdown"] as string;
      if (md) pasteIntoFocusedTerminal(`# ${e["title"]}\n${md}\n`);
      else if (e["error"]) injectIntoFocusedTerminal(
        t("inject.notion", { title: String(e["title"]), url: String(e["url"]) }));
      return;
    }

    case "linearIssues":
      lens.showLinear(e["issues"] as LinearIssue[], e["fresh"] as boolean, e["error"] as string | undefined);
      return;

    case "notionPages":
      lens.showNotion(e["pages"] as NotionPage[], e["fresh"] as boolean, e["error"] as string | undefined);
      return;
    case "dirListing":
      sidebar.tree.ingest(e["path"] as string, e["entries"] as { name: string; dir: boolean }[]);
      return;
    case "recents":
      sidebar.setRecents(e["projects"] as { path: string; name: string }[]);
      return;
    case "fileContent":
      docs.get(e["path"] as string)?.setText((e["text"] as string) ?? "", (e["binary"] as boolean) ?? false);
      return;
    case "fileSaved": {
      refreshOpen();
      for (const dv of diffs.values()) {
        if ((e["path"] as string).startsWith(dv.root + "/")) dv.refresh();
      }
      return;
    }
    case "error":
      console.error("[daemon]", e["message"], e["cause"] ?? "");
      return;
  }
});

function paintStatus(s: "open" | "close", detail?: string): void {
  statusEl.hidden = s === "open";
  statusEl.textContent = detail ? `retrod: ${detail}` : t("app.daemonDown");
}
/**
 * Reconnecting reattaches EVERY terminal on screen.
 *
 * Without this, a restarted daemon left every terminal pane orphaned: the
 * surface stayed drawn, accepting keystrokes, with nothing on the other side —
 * a terminal that looks alive and swallows what you type. Since `spawnTerminal`
 * with a known id now attaches, this single request covers both cases: the pty
 * survived (attach and replay the scrollback) or it died with the daemon (a new
 * one takes its place).
 */
function reattachTerminals(): void {
  for (const l of tiling.allLeaves()) {
    if (l.surface.s !== "terminal") continue;
    const term = terms.get(l.surface.ptyId);
    if (!term) continue;
    retro.send({ t: "spawnTerminal", ptyId: l.surface.ptyId, cwd: root, cols: 80, rows: 24 });
    term.fit();   // sends the real dimensions right after
  }
}

retro.onStatus((state, detail) => {
  paintStatus(state, detail);
  if (state === "open" && booted) reattachTerminals();
});
void retro.daemonStatus().then((r) => paintStatus(r.state, r.detail));

// ── teclado ────────────────────────────────────────────────────────────
window.addEventListener("keydown", (e) => {
  if (!e.metaKey) {
    if (e.key === "Escape") { closeNav(); lens.closePanel(); }
    return;
  }
  const k = e.key.toLowerCase();
  if (palette.isOpen && k !== "p" && k !== "k") return;

  const act: Record<string, () => void> = {
    j: newClaudeSession,
    p: () => palette.open("files"),
    k: () => palette.open("commands"),
    o: () => void pickProject(),
    e: toggleNav,
    t: () => tiling.split("h", newTerminal()),
    /*
     * ⌘D splits BELOW, ⇧⌘D beside.
     *
     * They were the other way round (the iTerm2 convention). macOS Terminal
     * splits below on plain ⌘D, and that is what the hand already does on this
     * keyboard — a shortcut fighting the local habit loses, even with precedent
     * in another app.
     */
    d: () => tiling.split(e.shiftKey ? "h" : "v", newTerminal()),
    w: () => tiling.closeFocused(),
    s: saveFocused,
    g: () => { if (e.shiftKey) openDiff(); },
    ",": openSettings,
    "]": () => tiling.cycle(1),
    "[": () => tiling.cycle(-1),
  };
  const run = act[k];
  if (run) { e.preventDefault(); run(); }
});

// ── arranque ───────────────────────────────────────────────────────────
root = new URLSearchParams(location.search).get("root") ?? "";
pathEl.textContent = root.split("/").pop() ?? "retro";
sidebar.setProject(root.split("/").pop() ?? "projeto");

lens.setProject(root);
/*
 * The surfaces worth resurrecting. Agent and consensus are left out on purpose:
 * they point at a run that already finished, and restoring a pane whose only
 * message is "that task no longer exists" is worse than not restoring.
 */
const RESTORABLE = new Set(["terminal", "editor", "diff", "settings", "empty"] as const);

function restoreLayout(): boolean {
  let raw: string | null = null;
  try { raw = localStorage.getItem(layoutKey()); } catch { return false; }
  if (!raw) return false;
  try {
    const tree: unknown = JSON.parse(raw);
    // Persisted state is untrusted input: an earlier version of the app may
    // have written a shape that no longer exists.
    if (!isPaneNode(tree, RESTORABLE)) return false;
    tiling.restore(tree);
    return true;
  } catch { return false; }
}

if (!restoreLayout()) {
  // One terminal, ready for `claude`. The screen is born in its real shape.
  tiling.setSurface(tiling.allLeaves()[0]!.id, newTerminal());
}
tiling.start();
loadProject(root);
// Initial state is pulled: a push emitted before the listener exists is lost,
// and that has already cost dearly three times in this app.
retro.send({ t: "readConfig" });
booted = true;

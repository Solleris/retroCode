/**
 * retrod — the process that outlives the app.
 *
 * Owns: ptys, Agent SDK sessions, SQLite.
 * Does not own: windows, text buffers, rendered layout.
 *
 * Run with:  node --watch packages/daemon/src/main.ts
 */
import net from "node:net";
import { existsSync, unlinkSync, createWriteStream } from "node:fs";
import { basename } from "node:path";
import {
  FrameParser, encodeControl, encodePty, KIND_CONTROL, KIND_PTY,
} from "@retro/protocol/frame";
import { ClientRequest, PROTOCOL_VERSION, type DaemonEvent } from "@retro/protocol";
import { SOCKET_PATH, LOG_PATH, ensureHome } from "./paths.ts";
import { PtyManager } from "./pty.ts";
import { openDb, upsertProject, appendEvent, readEvents, type EventKind } from "./db.ts";
import { indexProject, readFile, writeFile, listDir } from "./fs.ts";
import { loadConfig, saveConfig, watchConfig, CONFIG_PATH } from "./config.ts";
import { AgentRunner } from "./agent.ts";
import { ConsensusRunner } from "./consensus.ts";
import { ClaudeWatcher } from "./claude-watch.ts";
import { diffAgainstBase, isGitRepo, branchWebUrl } from "./worktree.ts";
import { isArtifact } from "./consensus.ts";
import { fetchLinear, fetchNotion, fetchNotionPage, fetchLinearIssue } from "./connectors.ts";
import { execFile } from "node:child_process";

ensureHome();
const db = openDb();
const ptys = new PtyManager();

/**
 * The "current" project for logging purposes. The daemon serves N projects,
 * but events need an owner; opening a project makes it the context.
 */
let currentProject = "";

/**
 * One lens PER REPO, not a global one. Terminals can sit in different repos;
 * focusing a terminal turns on (and keeps) the lens for its repo. Watchers are
 * cheap (fs.watch + a 2s poll), so they stay alive.
 */
const watchers = new Map<string, ClaudeWatcher>();
function watchClaude(project: string): void {
  if (watchers.has(project)) return;
  const w = new ClaudeWatcher(project, (sessions) =>
    broadcast({ t: "claudeSessions", project, sessions }));
  watchers.set(project, w);
  w.start();
  log("claude lens attached for", project);
}

/** The shell's REAL cwd (the user may have cd'd) via lsof, then the git root. */
function ptyCwd(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 4000 },
      (_e, out) => {
        const m = out.match(/^n(.+)$/m);
        resolve(m?.[1] ?? null);
      });
  });
}
function gitRoot(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 4000 },
      (e, out) => resolve(e ? dir : out.trim()));   // no git: the dir itself
  });
}

/**
 * Everything that happens becomes an event on the timeline.
 *
 * This is not telemetry — it is the primary structure of the UI. The screen's X
 * axis is the time of these events, and each band is a lane. Emitting here, in
 * the daemon, is what makes the timeline outlive the app closing: you come back
 * and see what the agents did while you were not looking.
 */
function ev(lane: string, kind: EventKind, label: string, detail?: unknown, ref?: string): void {
  if (!currentProject) return;
  const e = {
    project: currentProject, lane, at: Date.now(), kind, label,
    ...(detail !== undefined ? { detail: JSON.stringify(detail) } : {}),
    ...(ref ? { ref } : {}),
  };
  const id = appendEvent(db, e);
  broadcast({ t: "event", event: { ...e, id } });
}

/**
 * The agent runner emits to ALL clients: a second window watching the same task
 * has to see the same stream. Agent state belongs to the daemon.
 */
const agents = new AgentRunner({
  delta: (taskId, delta) => {
    broadcast({ t: "agentDelta", taskId, delta });
    const lane = `agent:${taskId}`;
    if (delta.k === "tool") ev(lane, "tool", delta.name, delta.input, delta.id);
    else if (delta.k === "toolResult") ev(lane, "tool-done", delta.ok ? "ok" : "erro", delta.summary, delta.id);
    else if (delta.k === "text" && delta.text.trim()) ev(lane, "text", delta.text.slice(0, 200));
  },
  ask: (req) => {
    log("permission requested", req.taskId, req.tool);
    // A gate is the only event that BLOCKS — on the timeline it becomes a bar
    // that stretches until it is resolved, and is impossible to miss.
    ev(`agent:${req.taskId}`, "gate", req.tool, req.input, req.requestId);
    broadcast({ t: "permissionAsk", ...req });
    broadcast({ t: "taskState", taskId: req.taskId, state: "needsYou" });
  },
  done: (r) => {
    ev(`agent:${r.taskId}`, "lane-end", r.ok ? "ok" : (r.error ?? "falhou"),
       { costUsd: r.costUsd, turns: r.turns });
    log("agente terminou", r.taskId, r.ok ? "ok" : `erro: ${r.error}`,
        r.costUsd !== undefined ? `$${r.costUsd.toFixed(4)}` : "");
    broadcast({ t: "agentDone", ...r });
    broadcast({ t: "taskState", taskId: r.taskId, state: r.ok ? "review" : "failed" });
    if (r.sessionId) {
      db.prepare(`UPDATE task SET session_id = ?, state = ?, updated_at = ? WHERE id = ?`)
        .run(r.sessionId, r.ok ? "review" : "failed", Date.now(), r.taskId);
    }
  },
});

const consensus = new ConsensusRunner(agents, {
  progress: (taskId, variantId, phase, note) => {
    broadcast({ t: "consensusProgress", taskId, variantId, phase, note });
    ev(`cons:${taskId}:${variantId}`, phase === "agentDone" ? "lane-end" : "note", `${phase}: ${note}`);
  },
  report: (r) => {
    log("consenso pronto", r.taskId, `${r.files.length} arquivos`,
        `${r.needsReview} need review`, r.measured ? "tests measured" : "tests NOT measured",
        `$${r.totalCostUsd.toFixed(4)}`);
    broadcast({
      t: "consensusReport", taskId: r.taskId, base: r.base,
      agreementPct: r.agreementPct, needsReview: r.needsReview,
      measured: r.measured, totalCostUsd: r.totalCostUsd,
      variants: r.variants.map(({ id, label, ok, costUsd }) =>
        ({ id, label, ok, ...(costUsd !== undefined ? { costUsd } : {}) })),
      files: r.files, tests: r.tests,
    });
    broadcast({ t: "taskState", taskId: r.taskId, state: "review" });
  },
  failed: (taskId, reason) => {
    log("consenso falhou", taskId, reason);
    broadcast({ t: "consensusFailed", taskId, reason });
    broadcast({ t: "taskState", taskId, state: "failed" });
  },
});

/** Connected clients. Broadcast because a second window is a second client. */
const clients = new Set<net.Socket>();

/**
 * The auto-spawned daemon runs with stdio:"ignore" — if it only used
 * console.log it would be completely mute, and a mute daemon is undebuggable.
 * So every log line also goes to ~/.retro/retrod.log (`tail -f` it).
 */
const logStream = createWriteStream(LOG_PATH, { flags: "a" });
function log(...a: unknown[]): void {
  const line = `${new Date().toISOString()} ${a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}`;
  console.log(line);
  logStream.write(line + "\n");
}

function send(sock: net.Socket, ev: DaemonEvent): void {
  if (!sock.destroyed) sock.write(encodeControl(ev));
}
function broadcast(ev: DaemonEvent): void {
  for (const c of clients) send(c, ev);
}

// Pty bytes go to every attached client, in a binary frame.
ptys.on("data", (ptyId: string, buf: Buffer) => {
  const frame = encodePty(ptyId, buf);
  for (const c of clients) if (!c.destroyed) c.write(frame);
});

ptys.on("exit", (ptyId: string, exitCode: number, signal?: number) => {
  log("pty exit", ptyId, exitCode);
  broadcast(signal === undefined
    ? { t: "terminalExited", ptyId, exitCode }
    : { t: "terminalExited", ptyId, exitCode, signal });
});

async function handle(sock: net.Socket, raw: unknown): Promise<void> {
  const parsed = ClientRequest.safeParse(raw);
  if (!parsed.success) {
    // Validating here is not ceremony: the socket is a boundary, and a
    // malformed message has to become a named error instead of an undefined
    // three frames later.
    send(sock, { t: "error", message: "invalid request", cause: parsed.error.message });
    return;
  }
  const req = parsed.data;

  switch (req.t) {
    case "hello":
      // Just record who arrived. `ready` already went out on connect —
      // answering here too would make the client index the project twice.
      log("cliente identificado:", req.clientId);
      return;

    case "openProject": {
      upsertProject(db, req.path, basename(req.path));
      return;
    }

    case "spawnTerminal": {
      /*
       * An id that already exists means ATTACH, not error.
       *
       * The ids are uuids, so a repeat only happens deliberately: it is the
       * window reopening a saved layout and asking for the same terminal again.
       * This used to throw "ptyId already exists" and the pane was born dead.
       * Since attaching already does the right thing (scrollback replay plus
       * announce), the intent "put this terminal on screen" has one answer.
       */
      const vivo = ptys.info(req.ptyId);
      if (vivo) {
        const back = ptys.scrollback(req.ptyId);
        if (back && back.length) sock.write(encodePty(req.ptyId, back));
        send(sock, { t: "terminalSpawned", ptyId: vivo.ptyId, pid: vivo.pid, cwd: vivo.cwd,
                     fresh: false });
        return;
      }
      try {
        const info = ptys.spawn(req);
        db.prepare(`INSERT OR REPLACE INTO pty (id, cwd, created_at) VALUES (?, ?, ?)`)
          .run(info.ptyId, info.cwd, Date.now());
        log("pty spawn", info.ptyId, "pid", info.pid, info.cwd);
        ev(`term:${info.ptyId}`, "lane-start", info.cwd);
        broadcast({ t: "terminalSpawned", ptyId: info.ptyId, pid: info.pid, cwd: info.cwd,
                    fresh: true });
      } catch (e) {
        send(sock, { t: "error", message: `spawn falhou`, cause: String(e) });
      }
      return;
    }

    case "attachTerminal": {
      const info = ptys.info(req.ptyId);
      if (!info) { send(sock, { t: "error", message: `pty ${req.ptyId} does not exist` }); return; }
      // Order matters: replay BEFORE announcing, otherwise the UI paints new
      // output on top of a terminal that is still about to receive history.
      const back = ptys.scrollback(req.ptyId);
      if (back && back.length) sock.write(encodePty(req.ptyId, back));
      send(sock, { t: "terminalSpawned", ptyId: info.ptyId, pid: info.pid, cwd: info.cwd,
                   fresh: false });
      return;
    }

    case "indexProject": {
      upsertProject(db, req.path, basename(req.path));
      try {
        currentProject = req.path;
      watchClaude(req.path);
      const { files, truncated } = await indexProject(req.path);
        log("indexado", req.path, files.length, "arquivos", truncated ? "(truncado)" : "");
        send(sock, { t: "projectIndexed", root: req.path, name: basename(req.path), files, truncated });
      } catch (e) {
        send(sock, { t: "error", message: "falha ao indexar", cause: String(e) });
      }
      return;
    }

    case "readFile": {
      try {
        const { text, binary } = await readFile(req.path);
        send(sock, { t: "fileContent", path: req.path, text, binary });
      } catch (e) {
        send(sock, { t: "error", message: `falha ao ler ${req.path}`, cause: String(e) });
      }
      return;
    }

    case "writeFile": {
      try {
        await writeFile(req.path, req.text);
        log("salvo", req.path, req.text.length, "bytes");
        ev("you", "edit", req.path.split("/").pop() ?? req.path, { path: req.path });
        // Broadcast: a second window looking at the same file needs to know.
        broadcast({ t: "fileSaved", path: req.path });
      } catch (e) {
        send(sock, { t: "error", message: `falha ao salvar ${req.path}`, cause: String(e) });
      }
      return;
    }

    case "watchClaude":
      watchClaude(req.project);
      return;

    case "resolvePtyProject": {
      const info = ptys.info(req.ptyId);
      if (!info?.alive) {
        send(sock, { t: "ptyProject", ptyId: req.ptyId, project: null, cwd: null });
        return;
      }
      const cwd = (await ptyCwd(info.pid)) ?? info.cwd;
      const root = (await gitRoot(cwd)) ?? cwd;
      watchClaude(root);
      // The cwd travels along: a new terminal should be born WHERE YOU ARE,
      // not at the project root. Someone who cd'd into a subdirectory or is in
      // a worktree does not want to jump back just to open a shell beside it.
      send(sock, { t: "ptyProject", ptyId: req.ptyId, project: root, cwd });
      // The current snapshot travels along: the lens does not wait for the
      // next transcript change to stop being empty.
      const snap = watchers.get(root)?.current() ?? [];
      if (snap.length) send(sock, { t: "claudeSessions", project: root, sessions: snap });
      return;
    }

    case "fetchLinear": {
      const r = await fetchLinear(db, req.force ?? false,
        (items) => broadcast({ t: "linearIssues", fresh: true, issues: items }));
      send(sock, { t: "linearIssues", fresh: r.fresh, issues: r.items,
                   ...(r.error ? { error: r.error } : {}) });
      return;
    }

    case "fetchNotion": {
      const r = await fetchNotion(db, req.force ?? false,
        (items) => broadcast({ t: "notionPages", fresh: true, pages: items }));
      send(sock, { t: "notionPages", fresh: r.fresh, pages: r.items,
                   ...(r.error ? { error: r.error } : {}) });
      return;
    }

    case "branchUrl":
      send(sock, { t: "branchUrlResult", url: await branchWebUrl(req.root, req.branch) });
      return;

    case "readConfig": {
      const { config, problem } = loadConfig();
      send(sock, { t: "config", config, path: CONFIG_PATH, ...(problem ? { problem } : {}) });
      return;
    }

    case "writeConfig": {
      try {
        saveConfig(req.config);
        /*
         * No event is emitted here: the watcher will emit when the file
         * changes. A single source of notification keeps the screen from
         * receiving the change twice and disagreeing with itself if the write
         * fails halfway.
         */
      } catch (e) {
        send(sock, { t: "config", config: req.config, path: CONFIG_PATH,
                     problem: `could not write it: ${String(e).slice(0, 120)}` });
      }
      return;
    }

    case "gitDiff": {
      if (!(await isGitRepo(req.root))) {
        send(sock, { t: "gitDiffFiles", root: req.root, files: [], error: "notARepo" });
        return;
      }
      try {
        // No build artefacts: a .pyc in the diff is noise that pushes signal
        // off the screen — same rule as the consensus map.
        let files = (await diffAgainstBase(req.root, "HEAD")).filter((f) => !isArtifact(f.path));
        if (req.paths?.length) {
          const want = new Set(req.paths.map((x) => x.startsWith(req.root + "/") ? x.slice(req.root.length + 1) : x));
          files = files.filter((f) => want.has(f.path));
        }
        // Cap: a diff of hundreds of files is not reviewable on one screen.
        files = files.slice(0, 60);

        /*
         * A payload budget, on top of the per-patch cap.
         *
         * The per-file cap already handles the pathological case, but 60 files
         * at the limit would still add up to more than is worth sending at
         * once. Here the cut is explicit and VISIBLE: the file still appears in
         * the list with the right counts, just without its body. Silently
         * trimming the list would make the screen say "that is all that
         * changed", which is worse than saying "this did not fit".
         */
        let orcamento = 12 * 1024 * 1024;
        for (const f of files) {
          if (f.patch.length <= orcamento) { orcamento -= f.patch.length; continue; }
          f.patch = "";
          f.note = { kind: "oversize" };
        }
        send(sock, { t: "gitDiffFiles", root: req.root, files });
      } catch (e) {
        send(sock, { t: "gitDiffFiles", root: req.root, files: [], error: String(e).slice(0, 200) });
      }
      return;
    }

    case "fetchLinearIssue": {
      const r = await fetchLinearIssue(db, req.id);
      send(sock, { t: "linearIssueContent", id: req.id, markdown: r.markdown,
                   ...(r.error ? { error: r.error } : {}) });
      return;
    }

    case "fetchNotionPage": {
      const r = await fetchNotionPage(db, req.url, req.title);
      send(sock, { t: "notionPageContent", url: req.url, title: req.title,
                   markdown: r.markdown, ...(r.error ? { error: r.error } : {}) });
      return;
    }

    case "eventLog": {
      const events = readEvents(db, req.project, req.sinceId ?? 0);
      send(sock, { t: "eventLog", project: req.project, events });
      return;
    }

    case "listDir": {
      try {
        send(sock, { t: "dirListing", path: req.path, entries: await listDir(req.path, req.root) });
      } catch (e) {
        send(sock, { t: "error", message: `falha ao listar ${req.path}`, cause: String(e) });
      }
      return;
    }

    case "recentProjects": {
      const rows = db.prepare(
        `SELECT path, name, opened_at AS openedAt FROM project ORDER BY opened_at DESC LIMIT 12`,
      ).all() as { path: string; name: string; openedAt: number }[];
      // Filter out what was moved or deleted — a recent project that does not open is worse than none.
      send(sock, { t: "recents", projects: rows.filter((r) => existsSync(r.path)) });
      return;
    }

    case "startConsensus": {
      ev("you", "note", `consenso: ${req.prompt.slice(0, 100)}`);
      log("consensus started", req.taskId, req.runTests ? "with tests" : "without tests");
      broadcast({ t: "taskState", taskId: req.taskId, state: "running" });
      void consensus.run(req.taskId, req.prompt, req.cwd, { runTests: req.runTests });
      return;
    }

    case "adoptFile": {
      const ok = await consensus.adopt(req.taskId, req.variantId, req.path);
      log("adotado", req.path, "da variante", req.variantId, ok ? "ok" : "FALHOU");
      broadcast({ t: "fileAdopted", taskId: req.taskId, path: req.path, ok });
      return;
    }

    case "getConsensus": {
      const r = consensus.report(req.taskId);
      if (r) {
        send(sock, {
          t: "consensusReport", taskId: r.taskId, base: r.base,
          agreementPct: r.agreementPct, needsReview: r.needsReview,
          measured: r.measured, totalCostUsd: r.totalCostUsd,
          variants: r.variants.map(({ id, label, ok, costUsd }) =>
            ({ id, label, ok, ...(costUsd !== undefined ? { costUsd } : {}) })),
          files: r.files, tests: r.tests,
        });
      }
      return;
    }

    case "discardConsensus":
      await consensus.discard(req.taskId);
      log("consenso descartado", req.taskId);
      return;

    case "startAgent": {
      ev(`agent:${req.taskId}`, "lane-start", req.prompt.slice(0, 120));
      // The task is persisted BEFORE the agent starts: if the app dies
      // mid-run, its record (and the sessionId, at the end) survives to resume.
      db.prepare(
        `INSERT INTO task (id, project_id, title, prompt, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?)
         ON CONFLICT(id) DO UPDATE SET prompt = excluded.prompt, state = 'running', updated_at = excluded.updated_at`,
      ).run(req.taskId, upsertProject(db, req.cwd, basename(req.cwd)),
            req.prompt.slice(0, 80), req.prompt, Date.now(), Date.now());

      broadcast({ t: "taskState", taskId: req.taskId, state: "running" });
      void agents.start(req.taskId, req.prompt, req.cwd, req.resume);
      return;
    }

    case "resolvePermission":
      ev("you", "gate-done", req.allow ? (req.always ? "always" : "allowed") : "denied",
         undefined, req.requestId);
      agents.resolvePermission(req.requestId, req.allow, req.always);
      broadcast({ t: "taskState", taskId: "-", state: "running" });
      return;

    case "interruptAgent":
      agents.interrupt(req.taskId);
      return;

    case "resizeTerminal": ptys.resize(req.ptyId, req.cols, req.rows); return;
    case "killTerminal":   ptys.kill(req.ptyId); return;
    case "listTerminals":  send(sock, { t: "terminalList", terminals: ptys.list() }); return;
  }
}

/**
 * Single-instance guard.
 *
 * A socket file at that path means one of two things: a LIVE daemon, or the
 * orphan of one that died. Unlinking unconditionally (as it did) makes a second
 * daemon STEAL the socket from a first one that is working fine — and then half
 * the clients talk to one and half to the other, each with its own ptys and
 * sessions. Day-to-day symptom: "I sent the command and nothing happened".
 *
 * Telling the two cases apart requires trying to connect: whoever answers is
 * alive.
 */
async function claimSocket(): Promise<void> {
  if (!existsSync(SOCKET_PATH)) return;

  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.createConnection(SOCKET_PATH);
    const settle = (v: boolean) => { probe.destroy(); resolve(v); };
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false));
    setTimeout(() => settle(false), 500);
  });

  if (alive) {
    log("a live retrod already owns this socket — exiting");
    process.exit(0);
  }
  log("orphan socket found, removing it");
  unlinkSync(SOCKET_PATH);
}

/*
 * Config hot reload: editing the file by hand changes the IDE's colours with no
 * restart. Same pattern as the lens — the daemon watches disk and pushes.
 */
watchConfig(({ config, problem }) => {
  log("config reloaded", problem ? `with problem: ${problem}` : "");
  broadcast({ t: "config", config, path: CONFIG_PATH, ...(problem ? { problem } : {}) });
});

await claimSocket();

const server = net.createServer((sock) => {
  sock.setNoDelay(true);
  clients.add(sock);
  log("cliente conectou; total", clients.size);

  /**
   * Announces itself without waiting for a handshake. The daemon KNOWS when it
   * is ready — requiring a `hello` from the client only creates a way for the
   * client to forget, and that is exactly what happened: the app connected and
   * sat waiting for a `ready` that never came.
   */
  send(sock, { t: "ready", daemonPid: process.pid, version: PROTOCOL_VERSION });
  send(sock, { t: "terminalList", terminals: ptys.list() });

  const parser = new FrameParser();
  sock.on("data", (chunk: Buffer) => {
    try {
      for (const frame of parser.push(chunk)) {
        if (frame.kind === KIND_CONTROL) {
          // A bad request must NOT take the daemon down: it carries every
          // client's ptys and agent sessions. That is how one colliding
          // project id became total state loss.
          void handle(sock, frame.json).catch((err: unknown) => {
            log("handler falhou:", String(err));
            send(sock, { t: "error", message: "handler falhou", cause: String(err).slice(0, 300) });
          });
        }
        else if (frame.kind === KIND_PTY) ptys.write(frame.ptyId, frame.data);
      }
    } catch (e) {
      log("invalid frame, dropping client:", e);
      sock.destroy();
    }
  });

  const drop = () => { clients.delete(sock); log("cliente saiu; total", clients.size); };
  sock.on("close", drop);
  sock.on("error", drop);
});

server.listen(SOCKET_PATH, () => log(`retrod ${PROTOCOL_VERSION} ouvindo em ${SOCKET_PATH} (pid ${process.pid})`));

/**
 * Last line of defence. The daemon owns work that cannot be recreated — ptys
 * with state, agents mid-run. Dying from a stray exception costs far more than
 * carrying on degraded and logging it.
 */
process.on("uncaughtException", (err) => log("UNCAUGHT EXCEPTION:", err?.stack ?? String(err)));
process.on("unhandledRejection", (r) => log("UNHANDLED REJECTION:", String(r)));

/**
 * SIGTERM kills the ptys on purpose: that is the shutdown you asked for.
 * The case that matters is the OTHER one — the app closing, which does not come
 * through here. Then the ptys stay alive, which is the whole point.
 */
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig} — encerrando`);
    agents.interruptAll();
    ptys.killAll();
    server.close();
    try { unlinkSync(SOCKET_PATH); } catch { /* already gone */ }
    process.exit(0);
  });
}

import ptyModule from "node-pty";
import type { IPty } from "node-pty";
import { EventEmitter } from "node:events";
import * as tmux from "./tmux.ts";

/**
 * How much scrollback to keep per terminal, in bytes.
 *
 * This number is the price of "reattach and see what happened". Too low and
 * you reattach to a blank terminal after a long build — which makes the
 * daemon look pointless. Too high and 20 terminals become 100MB of RSS.
 * 256KB comfortably covers the output of a `pytest -q` or a `cargo build`.
 *
 * For a tmux-backed terminal this ring is only the SAME-daemon replay. The
 * history that outlives retrod is tmux's own, and it is much larger.
 */
const SCROLLBACK_BYTES = 256 * 1024;

export interface TerminalInfo {
  ptyId: string;
  pid: number;
  cwd: string;
  alive: boolean;
}

/**
 * What `spawn` knows and `TerminalInfo` deliberately does not carry.
 *
 * `TerminalInfo` is the shape the protocol publishes; keeping these two out of
 * it meant the durability work needed no protocol change at all.
 */
export interface SpawnResult extends TerminalInfo {
  /** The session already existed: we attached to a shell that never stopped. */
  adopted: boolean;
  /** tmux owns the shell, so it survives this process. */
  durable: boolean;
}

interface Entry {
  pty: IPty;
  cwd: string;
  /**
   * The shell's pid — NOT `pty.pid`.
   *
   * For a durable terminal `pty.pid` is our `tmux attach` client, a process the
   * user has no interest in and which changes every time retrod restarts.
   */
  pid: number;
  /** The tmux session that owns the shell, or null for a direct pty. */
  session: string | null;
  /** A deque of chunks with a byte cap. This is what the attach replay serves. */
  scrollback: Buffer[];
  scrollbackBytes: number;
  alive: boolean;
  exitCode: number | null;
}

/**
 * Owner of every live pty. Emits:
 *   "data"  (ptyId, Buffer)
 *   "exit"  (ptyId, exitCode, signal?)
 *
 * Nothing in here knows a socket or an Electron exists. That decoupling is
 * what lets a second client (a `retro attach` CLI) show up later without
 * touching this class.
 *
 * "Owner" is now a half-truth, and the better half. When tmux is installed the
 * shells belong to the tmux server and this class only holds a view of them:
 * it can be torn down, and the work keeps running. See tmux.ts.
 */
/**
 * A SANITISED environment for the shells.
 *
 * `{...process.env}` propagates the context of whoever launched the daemon —
 * and if the daemon was started from inside a Claude Code session (a dev
 * running `bun run daemon`), the ptys inherit CLAUDE_CODE_SESSION_ID and
 * friends. Observed result: every `claude` opened in a Retro terminal wrote
 * its transcript INTO THE LAUNCHER'S SESSION instead of creating its own —
 * and the lens went blind.
 */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^CLAUDE/i.test(k)) continue;
    env[k] = v;
  }
  env["TERM"] = "xterm-256color";
  env["RETRO"] = "1";
  return env;
}

export class PtyManager extends EventEmitter {
  #entries = new Map<string, Entry>();
  #log: (...a: unknown[]) => void;

  /**
   * The logger is injected because this class must not import the daemon's
   * log stream — that would be the decoupling above, undone. A no-op default
   * keeps it usable from a test or a script.
   */
  constructor(log: (...a: unknown[]) => void = () => {}) {
    super();
    this.#log = log;
  }

  /*
   * `shell?: string | undefined`, not `shell?: string`: under
   * exactOptionalPropertyTypes those are DIFFERENT types, and what arrives
   * from the zod-validated request is the former (key present, holding
   * undefined). Accept the shape the caller actually has.
   */
  spawn(opts: { ptyId: string; cwd: string; shell?: string | undefined; cols: number; rows: number }): SpawnResult {
    if (this.#entries.has(opts.ptyId)) throw new Error(`ptyId ${opts.ptyId} already exists`);

    const shell = opts.shell ?? process.env["SHELL"] ?? "/bin/zsh";
    const env = cleanEnv();

    let session: string | null = null;
    let adopted = false;

    if (tmux.available()) {
      const name = tmux.sessionName(opts.ptyId);
      try {
        /*
         * The adoption path, and the reason this whole file changed.
         *
         * A session already carrying this ptyId means a previous retrod created
         * it and died. The shell never stopped. Attaching instead of creating
         * is what turns daemon death into a repaint.
         */
        if (tmux.hasSession(name)) adopted = true;
        else tmux.createSession({ name, cwd: opts.cwd, shell, cols: opts.cols, rows: opts.rows, env });
        session = name;
      } catch (e) {
        /*
         * tmux exists but refused. A non-durable terminal beats no terminal, so
         * fall through to the direct pty — but say so, because silently losing
         * durability is the kind of thing you only discover after a crash.
         */
        this.#log("tmux falhou, caindo para pty direto:", String(e));
        session = null;
        adopted = false;
      }
    }

    const pty = session
      ? (() => {
          const { file, args } = tmux.attachArgv(session);
          return ptyModule.spawn(file, args, {
            name: "xterm-256color",
            cwd: opts.cwd,
            cols: opts.cols,
            rows: opts.rows,
            env,
          });
        })()
      : ptyModule.spawn(shell, ["-l"], {
          name: "xterm-256color",
          cwd: opts.cwd,
          cols: opts.cols,
          rows: opts.rows,
          env,
        });

    /*
     * The pane's shell if tmux can tell us, our attach client only as a last
     * resort — and loudly, because a pid pointing at the viewer is a pid that
     * lies to everything downstream: the UI, the log, `kill`.
     */
    let pid = pty.pid;
    if (session) {
      const doPane = tmux.panePid(session);
      if (doPane) pid = doPane;
      else this.#log("tmux não devolveu pane_pid para", session, "— usando o pid do cliente");
    }

    const entry: Entry = {
      pty, cwd: opts.cwd, pid, session,
      scrollback: [], scrollbackBytes: 0, alive: true, exitCode: null,
    };
    this.#entries.set(opts.ptyId, entry);

    pty.onData((chunk) => {
      // node-pty hands over a string; a pty is a byte stream, so we normalise
      // to Buffer once, here, and the rest of the system only ever sees bytes.
      const buf = Buffer.from(chunk, "utf8");
      this.#appendScrollback(entry, buf);
      this.emit("data", opts.ptyId, buf);
    });

    pty.onExit(({ exitCode, signal }) => {
      /*
       * For a durable terminal this fires when the ATTACH CLIENT ends, which is
       * not the same event as the shell ending — a detach looks identical from
       * here. So ask tmux who is right: session still there means the shell
       * outlived the viewer, and announcing an exit would make the UI bury a
       * terminal that is still working.
       */
      if (entry.session && tmux.hasSession(entry.session)) {
        this.#log("pty detach", opts.ptyId, "sessão tmux segue viva");
        this.#entries.delete(opts.ptyId);
        return;
      }
      entry.alive = false;
      entry.exitCode = exitCode;
      this.emit("exit", opts.ptyId, exitCode, signal);
    });

    return { ptyId: opts.ptyId, pid, cwd: opts.cwd, alive: true, adopted, durable: session !== null };
  }

  #appendScrollback(entry: Entry, buf: Buffer): void {
    entry.scrollback.push(buf);
    entry.scrollbackBytes += buf.length;
    while (entry.scrollbackBytes > SCROLLBACK_BYTES && entry.scrollback.length > 1) {
      const dropped = entry.scrollback.shift();
      entry.scrollbackBytes -= dropped ? dropped.length : 0;
    }
  }

  /**
   * The replay that makes reattaching mean something.
   *
   * An adopted terminal starts with an empty ring on purpose. tmux repaints the
   * whole screen when a client attaches, so seeding this from `capture-pane`
   * would render the same output twice — once as replayed history, once as the
   * repaint — and the pane would look corrupted. The screen comes from tmux;
   * this ring only serves same-daemon reattaches.
   */
  scrollback(ptyId: string): Buffer | null {
    const e = this.#entries.get(ptyId);
    return e ? Buffer.concat(e.scrollback) : null;
  }

  write(ptyId: string, data: Buffer): void {
    const e = this.#entries.get(ptyId);
    if (!e?.alive) return;
    e.pty.write(data.toString("utf8"));
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const e = this.#entries.get(ptyId);
    if (!e?.alive) return;
    // For a durable terminal this resizes our tmux CLIENT; `window-size latest`
    // then propagates it to the window. One hop more than before, same result.
    e.pty.resize(cols, rows);
  }

  /** Close the terminal for good — the shell dies. This is ⌘W, not shutdown. */
  kill(ptyId: string): void {
    const e = this.#entries.get(ptyId);
    if (e?.alive) e.pty.kill();
    // Killing the attach client only detaches, so the session has to go too or
    // ⌘W would leave a shell running forever with nothing pointing at it.
    if (e?.session) tmux.killSession(e.session);
    this.#entries.delete(ptyId);
  }

  info(ptyId: string): TerminalInfo | null {
    const e = this.#entries.get(ptyId);
    return e ? { ptyId, pid: e.pid, cwd: e.cwd, alive: e.alive } : null;
  }

  list(): TerminalInfo[] {
    return [...this.#entries].map(([ptyId, e]) => ({ ptyId, pid: e.pid, cwd: e.cwd, alive: e.alive }));
  }

  /**
   * Give up the terminals without ending the work.
   *
   * This is what the daemon runs on SIGINT/SIGTERM. For a durable terminal it
   * drops the viewer and leaves the shell running under tmux — the next retrod
   * adopts it. For a direct pty there is nothing to hand over, so it is still
   * the old kill.
   *
   * Replaces `killAll()`, whose name described the only behaviour that used to
   * be possible.
   */
  shutdown(): void {
    for (const [ptyId, e] of [...this.#entries]) {
      if (e.session) {
        if (e.alive) e.pty.kill(); // detaches; the tmux session lives on
        this.#entries.delete(ptyId);
      } else {
        this.kill(ptyId);
      }
    }
  }

  /** Terminals whose shell is still running under tmux with no viewer here. */
  orphans(): string[] {
    if (!tmux.available()) return [];
    return tmux.orphanPtyIds().filter((id) => !this.#entries.has(id));
  }
}

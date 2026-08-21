import ptyModule from "node-pty";
import type { IPty } from "node-pty";
import { EventEmitter } from "node:events";

/**
 * How much scrollback to keep per terminal, in bytes.
 *
 * This number is the price of "reattach and see what happened". Too low and
 * you reattach to a blank terminal after a long build — which makes the
 * daemon look pointless. Too high and 20 terminals become 100MB of RSS.
 * 256KB comfortably covers the output of a `pytest -q` or a `cargo build`.
 */
const SCROLLBACK_BYTES = 256 * 1024;

export interface TerminalInfo {
  ptyId: string;
  pid: number;
  cwd: string;
  alive: boolean;
}

interface Entry {
  pty: IPty;
  cwd: string;
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

  /*
   * `shell?: string | undefined`, not `shell?: string`: under
   * exactOptionalPropertyTypes those are DIFFERENT types, and what arrives
   * from the zod-validated request is the former (key present, holding
   * undefined). Accept the shape the caller actually has.
   */
  spawn(opts: { ptyId: string; cwd: string; shell?: string | undefined; cols: number; rows: number }): TerminalInfo {
    if (this.#entries.has(opts.ptyId)) throw new Error(`ptyId ${opts.ptyId} already exists`);

    const shell = opts.shell ?? process.env["SHELL"] ?? "/bin/zsh";
    const pty = ptyModule.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: cleanEnv(),
    });

    const entry: Entry = {
      pty, cwd: opts.cwd, scrollback: [], scrollbackBytes: 0, alive: true, exitCode: null,
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
      entry.alive = false;
      entry.exitCode = exitCode;
      this.emit("exit", opts.ptyId, exitCode, signal);
    });

    return { ptyId: opts.ptyId, pid: pty.pid, cwd: opts.cwd, alive: true };
  }

  #appendScrollback(entry: Entry, buf: Buffer): void {
    entry.scrollback.push(buf);
    entry.scrollbackBytes += buf.length;
    while (entry.scrollbackBytes > SCROLLBACK_BYTES && entry.scrollback.length > 1) {
      const dropped = entry.scrollback.shift();
      entry.scrollbackBytes -= dropped ? dropped.length : 0;
    }
  }

  /** The replay that makes reattaching mean something. */
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
    e.pty.resize(cols, rows);
  }

  kill(ptyId: string): void {
    const e = this.#entries.get(ptyId);
    if (e?.alive) e.pty.kill();
    this.#entries.delete(ptyId);
  }

  info(ptyId: string): TerminalInfo | null {
    const e = this.#entries.get(ptyId);
    return e ? { ptyId, pid: e.pty.pid, cwd: e.cwd, alive: e.alive } : null;
  }

  list(): TerminalInfo[] {
    return [...this.#entries].map(([ptyId, e]) => ({ ptyId, pid: e.pty.pid, cwd: e.cwd, alive: e.alive }));
  }

  killAll(): void {
    for (const id of [...this.#entries.keys()]) this.kill(id);
  }
}

import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { FrameParser, encodeControl, encodePty, KIND_CONTROL, KIND_PTY } from "@retro/protocol/frame";

const SOCKET = process.env["RETRO_SOCKET"] ?? join(homedir(), ".retro", "retrod.sock");

/**
 * The app's bridge to the daemon.
 *
 * The reconnect contract is what makes the daemon worth having: if connecting
 * fails, start a new daemon and try again; if the connection drops while the
 * daemon lives, reconnect and reattach. Either way the ptys were still there.
 */
export class DaemonLink extends EventEmitter {
  #sock: net.Socket | null = null;
  #parser = new FrameParser();
  #retry = 0;
  #closing = false;
  /**
   * The outbox. Without it, `#sock?.write()` SILENTLY DROPS anything sent
   * before the socket opens — and the renderer asks for spawnTerminal on the
   * first requestAnimationFrame, long before a cold daemon is up. Result: the
   * window opens with an empty terminal and no error anywhere.
   *
   * The queue lives HERE rather than as a "wait for open" in every caller,
   * because discipline at each call site is a bug waiting for the next one.
   */
  #outbox: Buffer[] = [];

  connect(): void {
    const sock = net.createConnection(SOCKET);
    sock.setNoDelay(true);

    sock.on("connect", () => {
      this.#retry = 0;
      this.#sock = sock;
      this.#parser = new FrameParser();
      // Drains in the order it was queued — control and pty bytes share the
      // queue precisely to preserve the order between them.
      const pending = this.#outbox;
      this.#outbox = [];
      for (const frame of pending) sock.write(frame);
      // Identification, not a handshake: the daemon already announced itself.
      sock.write(encodeControl({ t: "hello", clientId: `app-${process.pid}` }));
      this.emit("open");
    });

    /*
     * The parse happens inside an event handler, and that is exactly why it
     * NEEDS a try/catch here.
     *
     * `FrameParser.push` throws on a frame above the cap — a guard against
     * OOM. But a throw inside a Node callback does not climb to any caller's
     * try: it becomes an uncaughtException and kills the main process. That is
     * precisely what happened with a 73MB diff: the guard traded an OOM for a
     * crash, which is the same loss with worse diagnostics.
     *
     * A bad frame also desynchronises the stream (the rest of the buffer has
     * no trustworthy boundary any more), so the right recovery is to drop the
     * connection and reconnect clean — not to keep reading garbage.
     */
    sock.on("data", (chunk: Buffer) => {
      try {
        for (const f of this.#parser.push(chunk)) {
          if (f.kind === KIND_CONTROL) this.emit("control", f.json);
          else if (f.kind === KIND_PTY) this.emit("pty", f.ptyId, f.data);
        }
      } catch (err) {
        console.error("[daemon-link] invalid frame, resynchronising:", String(err));
        this.emit("fatal", `protocolo dessincronizado: ${String(err).slice(0, 120)}`);
        this.#parser = new FrameParser();
        sock.destroy();
      }
    });

    sock.on("error", (err: NodeJS.ErrnoException) => {
      // ENOENT: there never was a daemon.  ECONNREFUSED: an orphan socket
      // left by one that died. Both want the same thing — start one.
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") this.#spawnDaemon();
    });

    sock.on("close", () => {
      this.#sock = null;
      this.emit("close");
      if (!this.#closing) this.#scheduleRetry();
    });
  }

  #scheduleRetry(): void {
    // Capped backoff: a daemon that will not start must not become a busy loop.
    const delay = Math.min(250 * 2 ** this.#retry++, 4000);
    setTimeout(() => this.connect(), delay);
  }

  #spawnDaemon(): void {
    const built = resolve(import.meta.dirname, "../../../daemon/dist/main.js");
    const source = resolve(import.meta.dirname, "../../../daemon/src/main.ts");

    /*
     * The SOURCE takes priority, not the dist — and the order matters a lot.
     *
     * Two paths exist on purpose:
     *   · dev      → src/main.ts with the system node, which strips types
     *                natively (>= 23). The Node embedded in Electron does not
     *                yet, so running the .ts through it would fail.
     *   · packaged → dist/main.js with Electron's own Node; there the .ts is
     *                not shipped, so this is the only path.
     *
     * The dist used to come first, and that created a silent trap: someone
     * only had to run the typecheck for a broken dist to appear, and from then
     * on the app preferred that dist over the source that worked. The daemon
     * died at import, with no log (stdio ignored), and the status bar sat
     * forever on "restarting" — a false message, which is worse than none.
     * A file being present was never proof that it works.
     */
    const [cmd, args, env] = existsSync(source)
      ? [process.env["RETRO_NODE"] ?? "node", [source], { ...process.env }]
      : [process.execPath, [built], { ...process.env, ELECTRON_RUN_AS_NODE: "1" }];

    if (!existsSync(built) && !existsSync(source)) {
      this.emit("fatal", `daemon not found (neither ${built} nor ${source})`);
      return;
    }

    // detached + unref: the daemon MUST outlive this process — that is
    // literally why it exists. Inheriting the process group would make Cmd+Q
    // kill every agent along with it.
    const child = spawn(cmd as string, args as string[], {
      detached: true,
      stdio: "ignore",
      env: env as NodeJS.ProcessEnv,
    });
    child.on("error", (e) => this.emit("fatal", `failed to start the daemon: ${e.message}`));

    /*
     * An early death has to be VISIBLE. `child.on("error")` only covers a spawn
     * failure (a missing binary); a daemon that starts and dies on its first
     * import leaves through here, and with stdio ignored it would be absolute
     * silence. After the initial window the listener steps aside — a daemon
     * that lives and exits ten minutes later is a normal reconnect, not a
     * startup failure.
     */
    const earlyExit = (code: number | null): void => {
      if (code !== 0) this.emit("fatal", `the daemon died on startup (code ${code}) — see ~/.retro/retrod.log`);
    };
    child.on("exit", earlyExit);
    setTimeout(() => child.off("exit", earlyExit), 4000).unref();

    child.unref();
  }

  send(req: unknown): void { this.#enqueue(encodeControl(req)); }
  write(ptyId: string, data: Uint8Array): void { this.#enqueue(encodePty(ptyId, Buffer.from(data))); }

  #enqueue(frame: Buffer): void {
    if (this.#sock && !this.#sock.destroyed) { this.#sock.write(frame); return; }
    // Cap: a daemon that never starts must not become a memory leak. 512
    // frames comfortably covers the opening burst; beyond that, drop the
    // oldest, because the recent one is what still matters.
    if (this.#outbox.length >= 512) this.#outbox.shift();
    this.#outbox.push(frame);
  }

  /** Cmd+Q closes the socket and nothing else. The ptys stay alive, on purpose. */
  dispose(): void { this.#closing = true; this.#sock?.destroy(); }
}

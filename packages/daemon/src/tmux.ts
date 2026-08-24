import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { RETRO_HOME } from "./paths.ts";

/**
 * tmux as the durable substrate for terminals.
 *
 * The problem this file exists to solve: node-pty puts the master fd in
 * retrod's own address space. The daemon dies — crash, SIGTERM, a tree-kill
 * from whatever launched it — and every shell dies with it, mid-build,
 * mid-session. No amount of hardening the daemon changes that, because the
 * ownership is the bug.
 *
 * With tmux the shell is a child of the tmux SERVER, not of retrod. retrod
 * becomes a viewer: it attaches, streams bytes, and can vanish without taking
 * the work along. Daemon death stops being data loss and becomes a repaint.
 *
 * tmux is OPTIONAL on purpose. Absent, `available()` is false and the caller
 * keeps the old direct-pty behaviour — a clone of this repo must not need a
 * new binary to get a terminal.
 */

/**
 * A tmux server of OUR OWN, addressed by socket name instead of the default.
 *
 * Sharing the user's server was the tempting version and the wrong one. Every
 * option retrod wants is global or session-wide: `history-limit` only applies
 * to windows created AFTER it is set, and `prefix None` — which retrod needs so
 * that C-b reaches the shell instead of being eaten by a multiplexer the user
 * never asked for — would disarm the prefix in their own sessions too. On top
 * of that, `list-sessions` would hand us panes we do not own and must never
 * kill. A separate server gives a separate option namespace and a session list
 * that is only ours.
 *
 * The name is DERIVED FROM RETRO_HOME, not fixed, because the tmux server is
 * daemon state exactly like the sqlite file next to it. Two daemons with
 * different homes are meant to be independent — a test run, a second checkout —
 * and a fixed name would silently put them on the same server, where they would
 * fight over the size of the same window (`window-size latest` hands it to
 * whoever attached last) and each could kill sessions belonging to the other.
 * The default home keeps the plain name, so `tmux -L retro ls` still works when
 * you are debugging by hand.
 */
const SERVER_NAME = (() => {
  if (RETRO_HOME === join(homedir(), ".retro")) return "retro";
  return `retro-${createHash("sha1").update(RETRO_HOME).digest("hex").slice(0, 8)}`;
})();

const SERVER = ["-L", SERVER_NAME] as const;

/** Exported so a test can tear down exactly the server it created. */
export { SERVER_NAME };

/** Every session we own carries this prefix, so adoption never guesses. */
const PREFIX = "retro-";

/**
 * How much history tmux keeps per pane.
 *
 * This is the number that replaces the old 256KB in-memory ring: it survives
 * the daemon, so it is worth being generous with. 20k lines is a long build
 * plus the session that ran it.
 */
const HISTORY_LIMIT = 20_000;

/** tmux control commands are local and fast; a hung one must not hang retrod. */
const TIMEOUT_MS = 5_000;

export interface CreateOpts {
  name: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

function tmux(args: readonly string[], env?: Record<string, string>): string {
  return execFileSync("tmux", [...SERVER, ...args], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    ...(env ? { env } : {}),
  });
}

/** The argv retrod uses to ATTACH to a session, for node-pty to run. */
export function attachArgv(name: string): { file: string; args: string[] } {
  // `=name` is an exact match. Without it `-t retro-pty-ab` also matches
  // `retro-pty-abcd`, and two panes would share one shell.
  return { file: "tmux", args: [...SERVER, "attach-session", "-t", `=${name}`] };
}

let probed: boolean | null = null;

/** Is tmux usable at all? Probed once — the answer cannot change mid-run. */
export function available(): boolean {
  if (probed !== null) return probed;
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore", timeout: TIMEOUT_MS });
    probed = true;
  } catch {
    probed = false;
  }
  return probed;
}

/** A tmux session name for a ptyId. Session names cannot hold `:` or `.`. */
export function sessionName(ptyId: string): string {
  return PREFIX + ptyId.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function hasSession(name: string): boolean {
  try {
    tmux(["has-session", "-t", `=${name}`]);
    return true;
  } catch {
    // Also the "no server running" case, which is a legitimate "no".
    return false;
  }
}

/**
 * Options that make tmux invisible.
 *
 * The user asked for a terminal, not for a multiplexer: no status bar stealing
 * a row, no prefix key stealing a chord, no escape-time delay making vim and
 * the Claude TUI feel broken. `escape-time 0` in particular is not cosmetic —
 * the default 500ms turns every ESC into a guess.
 *
 * Applied before each create instead of once: the server exits when its last
 * session closes (`exit-empty`), and a fresh server has fresh defaults.
 *
 * `start-server` FIRST, and it is not ceremony. `set` requires a running server
 * — it does not start one — so without this the very first call of a cold
 * server failed with "error connecting to /tmp/tmux-501/…", the caller caught
 * it, and every terminal silently came up as a non-durable direct pty. And the
 * options cannot simply move after `new-session` instead: `history-limit` is a
 * session option that only applies to windows created AFTER it is set, so the
 * order server → options → session is the only one that works.
 */
function applyOptions(env: Record<string, string>): void {
  const opts: string[][] = [
    ["start-server"],
    ["set", "-g", "status", "off"],
    ["set", "-g", "prefix", "None"],
    ["set", "-g", "prefix2", "None"],
    ["set", "-sg", "escape-time", "0"],
    ["set", "-g", "history-limit", String(HISTORY_LIMIT)],
    ["set", "-g", "default-terminal", "xterm-256color"],
    // The window follows the size of the client that attached most recently,
    // which for us is always the only client.
    ["set", "-g", "window-size", "latest"],
    // The default is already off, but this one is the entire premise: a session
    // whose viewer went away must keep running.
    ["set", "-g", "destroy-unattached", "off"],
  ];
  // One invocation, `;`-separated: eight execs per terminal would be eight
  // process spawns on the request path.
  const argv: string[] = [];
  for (const o of opts) {
    if (argv.length) argv.push(";");
    argv.push(...o);
  }
  /*
   * The env goes HERE, on the command that may start the server, and nowhere
   * else. tmux forks its server from the first client, so the server — and
   * therefore every pane it ever opens — inherits this environment. See
   * createSession for why it must not travel as arguments instead.
   */
  tmux(argv, env);
}

export function createSession(o: CreateOpts): void {
  /*
   * The environment reaches the shell by INHERITANCE, never as arguments.
   *
   * The first version of this passed `-- /usr/bin/env -i K=V … $SHELL -l`, which
   * worked and was a security downgrade: argv is world-readable through `ps`,
   * and the tmux server keeps its original argv for as long as it lives. Any
   * token in the daemon's environment would have been on display in a
   * long-lived process — something node-pty never did, because it passes the
   * environment through `exec`'s envp, which `ps` cannot show. tmux's own `-e`
   * has exactly the same problem, so the answer is neither.
   *
   * So applyOptions starts the server WITH this environment and the server
   * hands it down to every pane. The sanitising in pty.ts's cleanEnv is what
   * makes that safe to share: the server is long-lived, so a CLAUDE_* leaking
   * in once would contaminate every terminal opened afterwards.
   */
  applyOptions(o.env);

  /*
   * EVERY client carries the sanitised environment, not just the one that
   * starts the server. tmux samples the environment of the client running the
   * command, so a `new-session` spawned with the daemon's raw environment put
   * the launcher's CLAUDE_CODE_SESSION_ID straight into the server's global
   * environment — measured with `show-environment -g` — and from there into the
   * shell. Which is the exact failure cleanEnv exists to prevent: every
   * `claude` in a Retro terminal writing into the LAUNCHER's transcript while
   * the lens goes blind.
   */
  const create = (withSize: boolean): void => {
    const args = ["new-session", "-d", "-s", o.name, "-c", o.cwd];
    if (withSize) args.push("-x", String(o.cols), "-y", String(o.rows));
    args.push("--", o.shell, "-l");
    tmux(args, o.env);
  };

  try {
    create(true);
  } catch {
    // `-x`/`-y` on new-session need tmux >= 3.0. Without them the detached
    // session starts at 80x24 and the attaching client resizes it a moment
    // later — worth one reflow to support an older tmux.
    create(false);
  }
}

/**
 * The pid of the SHELL, not of our attach client.
 *
 * `info()` reports this to the UI, and a pid that points at a `tmux attach`
 * process is a pid that tells the user nothing and points at the wrong thing
 * in Activity Monitor.
 */
export function panePid(name: string): number {
  try {
    /*
     * `list-panes`, NOT `display-message -p`.
     *
     * display-message is a CLIENT command: with nobody attached to the session
     * it prints an empty line and exits 0. That silent empty string was read as
     * "no pid", the caller fell back to the pid of our own `tmux attach`
     * process, and the UI then showed a pid belonging to a viewer instead of to
     * the shell. list-panes queries the server directly and needs no client.
     */
    const out = tmux(["list-panes", "-t", `=${name}`, "-F", "#{pane_pid}"]);
    const first = out.split("\n")[0]?.trim() ?? "";
    const pid = Number.parseInt(first, 10);
    return Number.isFinite(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

export function killSession(name: string): void {
  try {
    tmux(["kill-session", "-t", `=${name}`]);
  } catch {
    // Already gone is the outcome we wanted.
  }
}

/**
 * ptyIds of the sessions still running on our server.
 *
 * Recovering the id by stripping the prefix is exact only while ptyIds stay
 * inside the alphabet `sessionName` preserves — which uuids and `pty-xxxx` do.
 * A future id with a `.` in it would come back sanitised, so this is a
 * reporting aid: adoption itself always goes the other way, id -> name.
 */
export function orphanPtyIds(): string[] {
  let out: string;
  try {
    out = tmux(["list-sessions", "-F", "#{session_name}"]);
  } catch {
    return []; // No server running: nothing to adopt.
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(PREFIX))
    .map((l) => l.slice(PREFIX.length));
}

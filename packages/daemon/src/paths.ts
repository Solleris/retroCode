import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Daemon state lives in ~/.retro, not in the project directory.
 * One daemon serves N projects, and the socket needs a stable path so that
 * any client — the app, `retro attach`, a script — can find it.
 */
export const RETRO_HOME = process.env["RETRO_HOME"] ?? join(homedir(), ".retro");
export const SOCKET_PATH = process.env["RETRO_SOCKET"] ?? join(RETRO_HOME, "retrod.sock");
export const DB_PATH = join(RETRO_HOME, "retro.db");
export const LOG_PATH = join(RETRO_HOME, "retrod.log");

export function ensureHome(): void {
  mkdirSync(RETRO_HOME, { recursive: true, mode: 0o700 });
}

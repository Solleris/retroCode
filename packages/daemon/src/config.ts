import { readFileSync, writeFileSync, existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { RetroConfig } from "@retro/protocol";
import { RETRO_HOME } from "./paths.ts";

export const CONFIG_PATH = join(RETRO_HOME, "config.json");

/**
 * The config file, and the daemon is what owns it.
 *
 * It could have lived in the renderer via localStorage — the language did. But
 * localStorage is not human-editable, does not survive "I want my theme in
 * version control", and cannot be watched. A file on disk solves all three,
 * and watching a file is exactly what the daemon already does for transcripts.
 *
 * The default is WRITTEN on first launch instead of staying implicit. Config
 * that does not exist on disk teaches nothing; a file with one example command
 * inside shows the shape without needing documentation.
 */
const DEFAULT: RetroConfig = {
  theme: {},
  commands: [
    {
      id: "monitor",
      label: "monitor terminal (k9s/btop)",
      run: "command -v k9s >/dev/null && k9s || (command -v btop >/dev/null && btop || htop || top)",
    },
  ],
};

export interface ConfigLoad {
  config: RetroConfig;
  /** Set when the file exists but is invalid. */
  problem?: string;
}

/**
 * Reads and validates. An invalid file breaks NOTHING and is NOT overwritten.
 *
 * The temptation is to rewrite with defaults when the parse fails — and that
 * erases the work of whoever typed one comma wrong. Here the defaults are used
 * in memory and the problem travels back with them, so the screen can say what
 * is wrong with the file that is still sitting there, intact, to be fixed.
 */
export function loadConfig(): ConfigLoad {
  if (!existsSync(CONFIG_PATH)) {
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT, null, 2) + "\n", { mode: 0o600 });
    } catch { /* no permission: carry on with the in-memory default */ }
    return { config: DEFAULT };
  }

  let raw: string;
  try { raw = readFileSync(CONFIG_PATH, "utf8"); }
  catch (e) { return { config: DEFAULT, problem: `could not read it: ${String(e).slice(0, 120)}` }; }

  let json: unknown;
  try { json = JSON.parse(raw); }
  catch (e) { return { config: DEFAULT, problem: `invalid JSON: ${String(e).slice(0, 120)}` }; }

  const r = RetroConfig.safeParse(json);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path.join(".") || "(root)";
    return { config: DEFAULT, problem: `${where}: ${first?.message ?? "unexpected shape"}` };
  }
  return { config: r.data };
}

/** Writes what the settings pane assembled. Formatted to be read by a human. */
export function saveConfig(config: RetroConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Watches the file and reports. Hot reload is the entire point: editing the
 * theme in your editor and watching the IDE change colour without a restart is
 * what makes "customisable" mean something.
 *
 * Watches the DIRECTORY, not the file. Any decent editor saves by writing a
 * temp file and renaming over the target — the inode changes, and a watch on
 * the file keeps pointing at the old inode, going deaf after the first save.
 */
export function watchConfig(onChange: (load: ConfigLoad) => void): FSWatcher | null {
  try {
    let timer: NodeJS.Timeout | null = null;
    const w = watch(RETRO_HOME, (_ev, name) => {
      if (name !== "config.json") return;
      // A single save usually produces several events (rename + change).
      // Debounce so we do not re-read and re-emit three times per Cmd+S.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; onChange(loadConfig()); }, 60);
    });
    return w;
  } catch { return null; }
}

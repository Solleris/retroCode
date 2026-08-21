import type { RetroConfig } from "@retro/protocol";
import { terminalTheme } from "./theme.ts";
import type { Terminal } from "@xterm/xterm";

/**
 * The renderer's side of configuration: it applies what the daemon sends.
 *
 * Theme arrives as CSS variables, which is why it changes LIVE. A custom
 * property recalculates through the cascade with no reload, so editing
 * config.json in your editor recolours the IDE as you type — including the
 * terminal, which is the only thing needing a nudge because xterm copies the
 * theme at construction time.
 */

export type ThemeKey = keyof typeof TOKENS;

/**
 * The editable tokens, with labels. This list is CURATED on purpose.
 *
 * The theme has ~35 variables; exposing all of them turns settings into a CSS
 * dump and guarantees someone breaks the contrast of their own editor. These
 * are the ones that change the identity — the ground, the accent, the states —
 * plus the code palette, which is the one people actually want to swap.
 */
export const TOKENS = {
  bg:          { pt: "fundo",            en: "background" },
  surface:     { pt: "painel",           en: "panel" },
  "surface-2": { pt: "painel elevado",   en: "raised panel" },
  ink:         { pt: "texto",            en: "text" },
  "ink-dim":   { pt: "texto secundário", en: "secondary text" },
  rule:        { pt: "divisória",        en: "divider" },
  signal:      { pt: "acento",           en: "accent" },
  focus:       { pt: "painel em foco",   en: "focused pane" },
  ok:          { pt: "sucesso",          en: "success" },
  bad:         { pt: "erro",             en: "error" },
  "term-bg":   { pt: "fundo do terminal", en: "terminal background" },
  "code-key":  { pt: "código · palavra-chave", en: "code · keyword" },
  "code-str":  { pt: "código · string",  en: "code · string" },
  "code-fn":   { pt: "código · função",  en: "code · function" },
  "code-num":  { pt: "código · número",  en: "code · number" },
  "code-type": { pt: "código · tipo",    en: "code · type" },
} as const;

/** A token's factory value, read from the CSS before any override. */
const FACTORY = new Map<string, string>();

export function captureFactory(): void {
  if (FACTORY.size) return;
  const root = getComputedStyle(document.documentElement);
  for (const k of Object.keys(TOKENS)) FACTORY.set(k, root.getPropertyValue(`--${k}`).trim());
}

export function factoryValue(k: string): string {
  return FACTORY.get(k) ?? "";
}

let current: RetroConfig = { theme: {}, commands: [] };
export const config = (): RetroConfig => current;

/**
 * Applies the theme. It removes before writing, otherwise a token dropped from
 * the config would stay painted — the screen would show state the file no
 * longer holds.
 */
export function applyConfig(next: RetroConfig): void {
  captureFactory();
  const root = document.documentElement;

  for (const k of Object.keys(TOKENS)) root.style.removeProperty(`--${k}`);
  for (const [k, v] of Object.entries(next.theme)) {
    if (k in TOKENS) root.style.setProperty(`--${k}`, v);
  }

  current = next;
  retintTerminals();
}

/**
 * xterm reads the theme once, at construction — so changing the CSS variable
 * never reaches it. Reassigning `options.theme` is the nudge. The registry of
 * live terminals has existed since the CDP checks; here it gains a second use.
 */
function retintTerminals(): void {
  const reg = (globalThis as unknown as { __retroTerms?: Map<string, Terminal> }).__retroTerms;
  if (!reg) return;
  const theme = terminalTheme();
  for (const term of reg.values()) {
    try { term.options.theme = theme; } catch { /* terminal already disposed */ }
  }
}

/**
 * Language: the file decides, localStorage is only a cache.
 *
 * i18n resolves the language synchronously, at module load — before anything
 * arrives over the socket. So the config syncs the cache and, if it diverged,
 * reloads ONCE. The alternative would be holding the first paint waiting on the
 * socket, which delays the whole startup for a value that changes once per
 * install.
 */
export function reconcileLanguage(next: RetroConfig): boolean {
  const KEY = "retro.lang";
  const wanted = next.lang ?? null;
  let cache: string | null = null;
  try { cache = localStorage.getItem(KEY); } catch { return false; }

  if (wanted === null) {
    // No language in the config = follow the system. Only reload if an override existed.
    if (cache === null) return false;
    try { localStorage.removeItem(KEY); } catch { return false; }
    return true;
  }
  if (cache === wanted) return false;
  try { localStorage.setItem(KEY, wanted); } catch { return false; }
  return true;
}

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { terminalTheme } from "../theme.ts";

declare const retro: {
  send(req: unknown): void;
  write(ptyId: string, data: Uint8Array): void;
  openExternal(url: string): Promise<boolean>;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

import { t } from "../i18n.ts";
export interface TerminalSurface {
  el: HTMLElement;
  ptyId: string;
  feed(data: Uint8Array): void;
  fit(): void;
  focus(): void;
  dispose(): void;
}

/**
 * A terminal pane. xterm.js with the WebGL renderer — the same path VS Code
 * ships, and the reason there is no Metal renderer project in this code's
 * future.
 */
export function createTerminal(ptyId: string, cwd: string): TerminalSurface {
  const el = document.createElement("div");
  el.className = "surface surface-term";

  const term = new Terminal({
    fontFamily: '"SF Mono", "IBM Plex Mono", Menlo, monospace',
    fontSize: 12.5,
    lineHeight: 1.4,
    cursorBlink: true,
    cursorStyle: "block",
    allowProposedApi: true,
    // Let the CSS decide the colours: the terminal's theme and the app's theme
    // have to be one system, otherwise "minimal" breaks at the first surface.
    theme: terminalTheme(),
    scrollback: 10_000,

    /**
     * An explicit handler for OSC 8 hyperlinks (zsh prompts and Claude Code
     * emit plenty).
     *
     * Without it xterm.js uses its internal fallback: a `confirm()` saying
     * "WARNING: This link could potentially be dangerous" and then
     * `window.open()`. Two problems — the warning is noise in an IDE (the link
     * came from YOUR terminal, not a hostile site), and its `window.open()`
     * opens the window BEFORE setting the URL, so the main process handler has
     * nothing to intercept and nothing happens.
     *
     * Here the URL goes straight to the system browser, where your session is.
     */
    linkHandler: {
      activate(_event, uri) {
        void retro.openExternal(uri);
      },
      hover() { /* the OSC 8 underline is already the affordance */ },
      leave() { },
    },
  });

  /**
   * Instances exposed for inspection over CDP.
   *
   * The WebGL renderer draws into a canvas, so there is no link DOM to click in
   * a test — checking terminal behaviour requires reaching the object.
   */
  ((globalThis as unknown as { __retroTerms?: Map<string, Terminal> }).__retroTerms ??= new Map())
    .set(ptyId, term);

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  // WebGL can fail (a VM, a driver, a lost context). Falling back to canvas is
  // better than a black screen, so this is an attempt, not a requirement.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    console.warn(t("app.noWebgl"));
  }

  term.onData((s) => retro.write(ptyId, enc.encode(s)));

  const doFit = (): void => {
    try {
      fit.fit();
      retro.send({ t: "resizeTerminal", ptyId, cols: term.cols, rows: term.rows });
    } catch { /* pane de tamanho zero durante o relayout */ }
  };

  // A freshly created pane has no size in the frame it is born in.
  requestAnimationFrame(() => {
    doFit();
    retro.send({ t: "spawnTerminal", ptyId, cwd, cols: term.cols, rows: term.rows });
  });

  const ro = new ResizeObserver(() => doFit());
  ro.observe(el);
  window.addEventListener("retro:relayout", doFit);

  return {
    el, ptyId,
    feed: (data) => term.write(dec.decode(data)),
    fit: doFit,
    focus: () => term.focus(),
    dispose: () => {
      ro.disconnect();
      window.removeEventListener("retro:relayout", doFit);
      retro.send({ t: "killTerminal", ptyId });
      // Leave the registry too: it was born for CDP inspection, but the live
      // theme now walks this list — leaving a dead terminal in it makes the
      // retint touch a disposed object on every colour change.
      (globalThis as unknown as { __retroTerms?: Map<string, Terminal> })
        .__retroTerms?.delete(ptyId);
      term.dispose();
    },
  };
}

import type { RetroConfig } from "@retro/protocol";
import { t, lang } from "../i18n.ts";
import { TOKENS, factoryValue, applyConfig, config } from "../config.ts";
import { icons } from "../icons.ts";

declare const retro: { send(req: unknown): void };

export interface SettingsSurface {
  el: HTMLElement;
  render(config: RetroConfig, path: string, problem?: string): void;
  focus(): void;
  dispose(): void;
}

/**
 * Settings as a PANE, editing the same file a person would edit.
 *
 * The loop is one-way and runs through disk: the pane sends writeConfig → the
 * daemon saves → the watcher notices → the event comes back → the screen
 * redraws. So the UI and the file cannot disagree, and editing in your editor
 * or in here gives exactly the same result.
 *
 * One deliberate exception: colour applies immediately, before the disk round
 * trip. Dragging a colour picker with 100ms of latency is unusable, so the
 * theme is optimistic on screen and the write is debounced.
 */
export function createSettings(): SettingsSurface {
  const el = document.createElement("div");
  el.className = "surface surface-settings";
  el.tabIndex = 0;

  let current: RetroConfig = config();
  let writeTimer: number | null = null;

  /** Debounce: dragging a colour emits dozens of events per second. */
  const save = (next: RetroConfig, alreadyApplied = false): void => {
    current = next;
    if (!alreadyApplied) applyConfig(next);
    if (writeTimer !== null) clearTimeout(writeTimer);
    writeTimer = window.setTimeout(() => {
      writeTimer = null;
      retro.send({ t: "writeConfig", config: current });
    }, 220);
  };

  function render(cfg: RetroConfig, path: string, problem?: string): void {
    current = cfg;
    el.replaceChildren();

    const head = document.createElement("div");
    head.className = "set-head";
    head.innerHTML = `<span class="set-title">${esc(t("set.title"))}</span>
      <span class="set-path" title="${esc(t("set.pathTitle"))}">${esc(path)}</span>`;
    el.append(head);

    const body = document.createElement("div");
    body.className = "set-body";
    el.append(body);

    /*
     * An invalid file is a warning, not silence. The daemon carries on with the
     * in-memory default and does NOT rewrite the file — so whatever was typed
     * wrong is still there to be fixed, and this says what is wrong with it.
     */
    if (problem) {
      const w = document.createElement("div");
      w.className = "set-warn";
      w.textContent = t("set.broken", { msg: problem });
      body.append(w);
    }

    // ── language ──────────────────────────────────────────────────────
    body.append(section(t("set.language")));
    const langRow = document.createElement("div");
    langRow.className = "set-choices";
    for (const [value, labelText] of [
      ["", t("set.langSystem")], ["pt", "Português"], ["en", "English"],
    ] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "set-choice";
      b.textContent = labelText;
      const active = (current.lang ?? "") === value;
      b.classList.toggle("on", active);
      if (active) b.setAttribute("aria-current", "true");
      b.addEventListener("click", () => {
        const next: RetroConfig = value === ""
          ? { ...current, lang: undefined } as RetroConfig
          : { ...current, lang: value };
        // The language only shows after a reload (strings are read at render
        // time). That reload comes from the event coming back, not from here.
        save(next);
      });
      langRow.append(b);
    }
    body.append(langRow, note(t("set.langNote")));

    // ── theme ─────────────────────────────────────────────────────────
    body.append(section(t("set.theme")));
    const grid = document.createElement("div");
    grid.className = "set-tokens";
    for (const [key, labels] of Object.entries(TOKENS)) {
      const value = current.theme[key] ?? factoryValue(key);
      const overridden = key in current.theme;

      const row = document.createElement("div");
      row.className = "set-token";

      const swatch = document.createElement("input");
      swatch.type = "color";
      swatch.className = "set-swatch";
      swatch.value = hex(value);

      const nameEl = document.createElement("span");
      nameEl.className = "set-token-name";
      nameEl.textContent = labels[lang];

      const hexInput = document.createElement("input");
      hexInput.type = "text";
      hexInput.className = "set-token-hex";
      hexInput.value = value;
      hexInput.spellcheck = false;

      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "set-reset";
      resetBtn.innerHTML = icons.refresh;
      resetBtn.title = t("set.reset");
      resetBtn.hidden = !overridden;

      const apply = (v: string): void => {
        const theme = { ...current.theme, [key]: v };
        // Apply now, write later: dragging a colour with disk latency in the
        // loop is not editable.
        document.documentElement.style.setProperty(`--${key}`, v);
        hexInput.value = v;
        swatch.value = hex(v);
        resetBtn.hidden = false;
        save({ ...current, theme }, true);
      };

      swatch.addEventListener("input", () => apply(swatch.value));
      hexInput.addEventListener("change", () => apply(hexInput.value.trim()));
      resetBtn.addEventListener("click", () => {
        const theme = { ...current.theme };
        delete theme[key];
        save({ ...current, theme });
        render(current, path, problem);
      });

      row.append(swatch, nameEl, hexInput, resetBtn);
      grid.append(row);
    }
    body.append(grid);

    // ── commands ──────────────────────────────────────────────────────
    body.append(section(t("set.commands")));
    body.append(note(t("set.commandsNote")));

    if (current.commands.length) {
      const list = document.createElement("div");
      list.className = "set-cmds";
      for (const cmd of current.commands) {
        const row = document.createElement("div");
        row.className = "set-cmd";
        row.innerHTML = `<span class="set-cmd-label">${esc(cmd.label)}</span>
          <code class="set-cmd-run">${esc(cmd.run)}</code>`;
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "set-cmd-rm";
        rm.textContent = "×";
        rm.title = t("set.remove");
        rm.addEventListener("click", () => {
          save({ ...current, commands: current.commands.filter((c) => c.id !== cmd.id) });
          render(current, path, problem);
        });
        row.append(rm);
        list.append(row);
      }
      body.append(list);
    }

    const form = document.createElement("form");
    form.className = "set-newcmd";
    const labelText = field(t("set.cmdLabel"));
    const snippet = field(t("set.cmdRun"));
    const add = document.createElement("button");
    add.type = "submit";
    add.className = "set-add";
    add.textContent = t("set.add");
    form.append(labelText, snippet, add);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const label = labelText.value.trim();
      const run = snippet.value.trim();
      if (!label || !run) return;
      const id = `u-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`;
      save({ ...current, commands: [...current.commands, { id, label, run }] });
      labelText.value = ""; snippet.value = "";
      render(current, path, problem);
    });
    body.append(form);
  }

  return {
    el, render,
    focus: () => el.focus(),
    dispose: () => { if (writeTimer !== null) clearTimeout(writeTimer); },
  };
}

function section(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.className = "set-sec";
  h.textContent = text;
  return h;
}
function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "set-note";
  p.textContent = text;
  return p;
}
function field(placeholder: string): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "text";
  i.placeholder = placeholder;
  i.spellcheck = false;
  return i;
}

/**
 * `<input type=color>` only accepts #rrggbb. A token can be anything (`#fff`,
 * `rgb(...)`, another `var()`), so the swatch gets an approximation — and the
 * text field remains the source of truth.
 */
function hex(v: string): string {
  const s = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return "#000000";
}
function esc(s: string): string {
  const d = document.createElement("span");
  d.textContent = s;
  return d.innerHTML;
}

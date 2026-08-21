/**
 * Command palette and fuzzy finder. One surface, two modes:
 *   ⌘P  files
 *   ⌘K  commands
 *
 * The file index lives in the renderer and matching runs locally. A round trip
 * to the daemon per keystroke would give perceptible latency; 20k paths filter
 * in well under a frame.
 */

import { t } from "./i18n.ts";
export interface Command { id: string; label: string; hint?: string; run(): void }

interface Scored { value: string; score: number; hits: number[] }

/**
 * Subsequence matching with positional bonuses. It is not fzf, but it gets the
 * important case right: "dlink" finds `src/main/daemon-link.ts` because it
 * rewards path-segment starts and consecutive characters.
 */
function score(needle: string, hay: string): Scored | null {
  if (!needle) return { value: hay, score: 0, hits: [] };
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  const hits: number[] = [];
  let s = 0, hi = 0, streak = 0;

  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni]!;
    let found = -1;
    for (let i = hi; i < h.length; i++) {
      if (h[i] === c) { found = i; break; }
    }
    if (found < 0) return null;

    const prev = found > 0 ? h[found - 1]! : "/";
    if (prev === "/" || prev === "-" || prev === "_" || prev === ".") s += 12; // word start
    if (found === streak) s += 8;                                             // consecutivo
    if (hay[found] !== h[found]) s += 2;                                      // camelCase
    s += 1;
    hits.push(found);
    hi = found + 1;
    streak = hi;
  }

  // Caminho curto e match perto do fim (nome do arquivo) valem mais.
  s -= hay.length * 0.06;
  const lastSlash = hay.lastIndexOf("/");
  if (hits[0]! > lastSlash) s += 20;
  return { value: hay, score: s, hits };
}

function rank(needle: string, pool: string[], limit = 60): Scored[] {
  const out: Scored[] = [];
  for (const p of pool) {
    const r = score(needle, p);
    if (r) out.push(r);
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

function highlight(text: string, hits: number[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const set = new Set(hits);
  let run = "";
  let runIsHit = false;
  const flush = (): void => {
    if (!run) return;
    if (runIsHit) {
      const m = document.createElement("mark");
      m.textContent = run;
      frag.append(m);
    } else {
      frag.append(document.createTextNode(run));
    }
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const isHit = set.has(i);
    if (isHit !== runIsHit) { flush(); runIsHit = isHit; }
    run += text[i];
  }
  flush();
  return frag;
}

export class Palette {
  #root: HTMLElement;
  #input: HTMLInputElement;
  #list: HTMLElement;
  #empty: HTMLElement;
  #mode: "files" | "commands" = "files";
  #files: string[] = [];
  #commands: Command[] = [];
  #results: Scored[] = [];
  #cursor = 0;
  #onOpenFile: (rel: string) => void;
  /** A single-use override — lets the fuzzy finder be reused as a PICKER
   *  (e.g. choosing a file to inject as context) without duplicating UI. */
  #oneShot: ((rel: string) => void) | null = null;

  constructor(onOpenFile: (rel: string) => void) {
    this.#onOpenFile = onOpenFile;

    this.#root = document.createElement("div");
    this.#root.className = "palette";
    this.#root.hidden = true;
    this.#root.innerHTML = `
      <div class="palette-box">
        <div class="palette-head"><span class="palette-mode"></span><input
          class="palette-input" type="text" spellcheck="false" autocomplete="off"></div>
        <div class="palette-list" role="listbox"></div>
        <div class="palette-empty" hidden></div>
      </div>`;
    document.body.append(this.#root);

    this.#input = this.#root.querySelector(".palette-input")!;
    this.#list = this.#root.querySelector(".palette-list")!;
    this.#empty = this.#root.querySelector(".palette-empty")!;

    this.#input.addEventListener("input", () => { this.#cursor = 0; this.#refresh(); });
    this.#input.addEventListener("keydown", (e) => this.#onKey(e));
    // Clicking outside closes it. Esc too. Never trapped.
    this.#root.addEventListener("mousedown", (e) => { if (e.target === this.#root) this.close(); });
  }

  setFiles(files: string[]): void { this.#files = files; }
  setCommands(cmds: Command[]): void { this.#commands = cmds; }
  get isOpen(): boolean { return !this.#root.hidden; }

  openWith(mode: "files" | "commands", onPick: (value: string) => void): void {
    this.#oneShot = onPick;
    this.open(mode);
  }

  open(mode: "files" | "commands"): void {
    this.#mode = mode;
    this.#root.hidden = false;
    this.#root.querySelector(".palette-mode")!.textContent = mode === "files" ? "abrir" : "comando";
    this.#input.value = "";
    this.#input.placeholder = mode === "files"
      ? `${this.#files.length} ${t("palette.files")}`
      : `${this.#commands.length} ${t("palette.commands")}`;
    this.#cursor = 0;
    this.#refresh();
    this.#input.focus();
  }

  close(): void {
    this.#oneShot = null;
    this.#root.hidden = true;
    this.#input.blur();
    window.dispatchEvent(new Event("retro:palette-closed"));
  }

  #pool(): string[] {
    return this.#mode === "files" ? this.#files : this.#commands.map((c) => c.label);
  }

  #refresh(): void {
    this.#results = rank(this.#input.value.trim(), this.#pool());
    this.#list.replaceChildren();

    if (this.#results.length === 0) {
      this.#empty.hidden = false;
      this.#empty.textContent = this.#input.value ? t("palette.noMatch") : t("palette.emptyIndex");
      return;
    }
    this.#empty.hidden = true;

    this.#results.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "palette-row";
      row.setAttribute("role", "option");
      if (i === this.#cursor) row.classList.add("sel");

      const label = document.createElement("span");
      label.className = "palette-label";
      label.append(highlight(r.value, r.hits));

      if (this.#mode === "files") {
        // Filename emphasised, directory dimmed — the eye looks for the name,
        // the path is only disambiguation.
        const cut = r.value.lastIndexOf("/");
        if (cut > 0) {
          const dir = document.createElement("span");
          dir.className = "palette-dir";
          dir.textContent = r.value.slice(0, cut + 1);
          label.replaceChildren(dir, highlight(r.value.slice(cut + 1), r.hits.filter((h) => h > cut).map((h) => h - cut - 1)));
        }
      } else {
        const cmd = this.#commands.find((c) => c.label === r.value);
        if (cmd?.hint) {
          const hint = document.createElement("span");
          hint.className = "palette-hint";
          hint.textContent = cmd.hint;
          row.append(label, hint);
          row.addEventListener("mousedown", () => this.#choose(i));
          this.#list.append(row);
          return;
        }
      }

      row.append(label);
      row.addEventListener("mousedown", () => this.#choose(i));
      this.#list.append(row);
    });

    this.#list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }

  #onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") { e.preventDefault(); this.close(); return; }
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault(); this.#move(1); return;
    }
    if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault(); this.#move(-1); return;
    }
    if (e.key === "Enter") { e.preventDefault(); this.#choose(this.#cursor); }
  }

  #move(d: 1 | -1): void {
    if (!this.#results.length) return;
    this.#cursor = (this.#cursor + d + this.#results.length) % this.#results.length;
    this.#refresh();
  }

  #choose(i: number): void {
    const hit = this.#results[i];
    if (!hit) return;
    const oneShot = this.#oneShot;
    this.close();
    if (oneShot) { oneShot(hit.value); return; }
    if (this.#mode === "files") this.#onOpenFile(hit.value);
    else this.#commands.find((c) => c.label === hit.value)?.run();
  }
}

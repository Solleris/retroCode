import { icons } from "../icons.ts";

import { t } from "../i18n.ts";
declare const retro: { send(req: unknown): void };

/**
 * The diff pane: working tree vs HEAD, per file, with hunks.
 *
 * Decisions about reading, not aesthetics:
 *   · side by side, because the question is "what changed in this line" and
 *     two aligned columns answer it without counting characters.
 *   · small files open, huge ones start collapsed — the header (+N −M) already
 *     says whether the click is worth it.
 *   · both line numbers in the gutters, so a hunk can be located in either
 *     version of the file.
 */

export interface DiffFile {
  path: string; status: string; added: number; removed: number; patch: string;
  /** The daemon's note on why the patch is empty or cut short. */
  note?: { kind: "binary" | "truncated" | "oversize"; kb?: number };
}

export interface DiffSurface {
  el: HTMLElement;
  root: string;
  render(files: DiffFile[], error?: string): void;
  refresh(): void;
  focus(): void;
  dispose(): void;
}

const STATUS = (): Record<string, string> => ({ A: t("st.A"), M: t("st.M"), D: t("st.D"), R: t("st.R"), "?": "?" });

export function createDiffView(root: string, paths?: string[]): DiffSurface {
  const el = document.createElement("div");
  el.className = "surface surface-diff";

  const head = document.createElement("div");
  head.className = "dv-head";
  head.innerHTML = `<span class="dv-title">${esc(t("diff.title", { repo: root.split("/").pop() ?? root }))}</span>
    <span class="dv-sum"></span><span class="dv-spacer"></span>
    <button class="dv-refresh" type="button" title="${t("diff.refresh")}">${icons.refresh}</button>`;
  const sumEl = head.querySelector<HTMLElement>(".dv-sum")!;

  const body = document.createElement("div");
  body.className = "dv-body";
  body.innerHTML = `<div class="dv-empty">${t("diff.computing")}</div>`;
  el.append(head, body);

  const ask = (): void => {
    retro.send({ t: "gitDiff", root, ...(paths?.length ? { paths } : {}) });
  };
  head.querySelector(".dv-refresh")!.addEventListener("click", ask);
  ask();

  function render(files: DiffFile[], error?: string): void {
    body.replaceChildren();
    if (error) {
      // "notARepo" is our own code and has a translation; git's stderr is
      // git's and passes through intact — translating another tool's message
      // is making things up.
      const msg = t(`diff.${error}`);
      body.append(empty(msg === `diff.${error}` ? error : msg));
      sumEl.textContent = "";
      return;
    }
    if (!files.length) { body.append(empty(t("diff.clean"))); sumEl.textContent = ""; return; }

    const added = files.reduce((s, f) => s + f.added, 0);
    const removed = files.reduce((s, f) => s + f.removed, 0);
    sumEl.innerHTML = `${t("diff.summary", { n: files.length })}
      <b class="add">+${added}</b> <b class="del">−${removed}</b>`;

    for (const f of files) body.append(fileBlock(f));
  }

  function fileBlock(f: DiffFile): HTMLElement {
    const box = document.createElement("div");
    box.className = "dv-file";

    const hdr = document.createElement("button");
    hdr.type = "button";
    hdr.className = "dv-file-head";
    hdr.innerHTML = `<span class="dv-caret">${icons.caretDown}</span>
      <span class="dv-status s-${f.status}">${STATUS()[f.status] ?? f.status}</span>
      <span class="dv-path">${esc(f.path)}</span>
      <span class="dv-counts"><b class="add">+${f.added}</b> <b class="del">−${f.removed}</b></span>`;

    const patch = document.createElement("div");
    patch.className = "dv-patch";
    if (f.note) {
      const n = document.createElement("div");
      n.className = "dv-note";
      n.textContent = t(`diff.${f.note.kind}`, { kb: f.note.kb ?? 0 });
      patch.append(n);
    }
    // Large starts collapsed: the cost of opening is one click; the cost of an
    // 800-line wall left open is losing the small files below it.
    const big = f.added + f.removed > 160;
    patch.hidden = big;
    if (!big && f.patch) patch.append(renderPatch(f.patch));

    hdr.addEventListener("click", () => {
      patch.hidden = !patch.hidden;
      hdr.querySelector(".dv-caret")!.innerHTML = patch.hidden ? icons.caretRight : icons.caretDown;
      if (!patch.hidden && f.patch && !patch.querySelector(".sd-grid")) patch.append(renderPatch(f.patch));
    });
    if (big) hdr.querySelector(".dv-caret")!.innerHTML = icons.caretRight;

    box.append(hdr, patch);
    return box;
  }

  return {
    el, root, render,
    refresh: ask,
    focus: () => el.focus(),
    dispose: () => { /* nada a soltar */ },
  };
}

/**
 * A unified patch → TWO aligned columns: the file before on the left, after on
 * the right.
 *
 * The alignment comes from a single 4-column grid [no. | before | no. | after]:
 * each logical line is ONE grid row, so even when text wraps across several
 * visual lines, both sides grow together — impossible to misalign.
 *
 * Runs of consecutive -/+ are paired line by line (del[i] ↔ add[i]) and, when
 * both sides exist, the differing middle is highlighted by common prefix and
 * suffix — the "obvious difference" within the line.
 */
interface Row {
  kind: "hunk" | "pair" | "note";
  text?: string;                       // for hunk and note rows
  oldN?: number; newN?: number;
  oldText?: string; newText?: string;
  oldKind?: "ctx" | "del" | "void";
  newKind?: "ctx" | "add" | "void";
}

function parseRows(patch: string): Row[] {
  const rows: Row[] = [];
  let oldN = 0, newN = 0;
  let dels: string[] = [], adds: string[] = [];

  const flush = (): void => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      rows.push({
        kind: "pair",
        ...(i < dels.length ? { oldN: oldN - dels.length + i, oldText: dels[i]!, oldKind: "del" as const } : { oldKind: "void" as const }),
        ...(i < adds.length ? { newN: newN - adds.length + i, newText: adds[i]!, newKind: "add" as const } : { newKind: "void" as const }),
      });
    }
    dels = []; adds = [];
  };

  for (const line of patch.split("\n").slice(0, 4000)) {
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---") || line.startsWith("\\")) continue;
    if (line.startsWith("@@")) {
      flush();
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldN = m?.[1] ? Number(m[1]) : 0;
      newN = m?.[2] ? Number(m[2]) : 0;
      if (rows.length) rows.push({ kind: "hunk", text: "···" });
      continue;
    }
    if (line.startsWith("-")) { dels.push(line.slice(1)); oldN++; continue; }
    if (line.startsWith("+")) { adds.push(line.slice(1)); newN++; continue; }
    if (line.startsWith(" ")) {
      flush();
      rows.push({ kind: "pair", oldN, newN, oldText: line.slice(1), newText: line.slice(1), oldKind: "ctx", newKind: "ctx" });
      oldN++; newN++;
      continue;
    }
    /*
     * What is left is git metadata: "Binary files a/x and b/x differ",
     * "old mode", "similarity index", and the daemon's truncation notes. These
     * used to fall into the context branch above, which does `slice(1)` — so
     * "Binary files…" rendered as "inary files…", a bug that looked like an
     * encoding error. Full width, spanning all four columns.
     */
    if (line) { flush(); rows.push({ kind: "note", text: line }); }
  }
  flush();
  return rows;
}

/** Destaque intra-linha por prefixo/sufixo comum. Devolve [ini, fimExcl] do miolo. */
function hotSpan(a: string, b: string): [number, number, number, number] | null {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a[p] === b[p]) p++;
  let sa = a.length, sb = b.length;
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) { sa--; sb--; }
  // A wholly replaced line gets no highlight — it would mark everything, which is nothing.
  if (p === 0 && sa === a.length && sb === b.length) return null;
  return [p, sa, p, sb];
}

function cellText(text: string, hot: [number, number] | null): HTMLElement {
  const el = document.createElement("span");
  el.className = "sd-t";
  if (!hot || hot[0] >= hot[1]) { el.textContent = text || " "; return el; }
  el.append(document.createTextNode(text.slice(0, hot[0])));
  const h = document.createElement("span");
  h.className = "sd-hot";
  h.textContent = text.slice(hot[0], hot[1]);
  el.append(h, document.createTextNode(text.slice(hot[1])));
  return el;
}

function renderPatch(patch: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const grid = document.createElement("div");
  grid.className = "sd-grid";

  for (const r of parseRows(patch)) {
    if (r.kind === "hunk" || r.kind === "note") {
      const sep = document.createElement("div");
      sep.className = r.kind === "note" ? "sd-sep sd-note" : "sd-sep";
      sep.textContent = r.kind === "note" ? (r.text ?? "") : "···";
      grid.append(sep);
      continue;
    }
    const paired = r.oldKind === "del" && r.newKind === "add";
    const spans = paired ? hotSpan(r.oldText ?? "", r.newText ?? "") : null;

    const nL = document.createElement("span");
    nL.className = `sd-n ${r.oldKind}`;
    nL.textContent = r.oldN !== undefined ? String(r.oldN) : "";
    const tL = cellText(r.oldText ?? "", spans ? [spans[0], spans[1]] : null);
    tL.classList.add(r.oldKind ?? "void");

    const nR = document.createElement("span");
    nR.className = `sd-n ${r.newKind}`;
    nR.textContent = r.newN !== undefined ? String(r.newN) : "";
    const tR = cellText(r.newText ?? "", spans ? [spans[2], spans[3]] : null);
    tR.classList.add(r.newKind ?? "void");

    grid.append(nL, tL, nR, tR);
  }
  frag.append(grid);
  return frag;
}

function empty(text: string): HTMLElement {
  const e = document.createElement("div");
  e.className = "dv-empty";
  e.textContent = text;
  return e;
}
function esc(s: string): string {
  const d = document.createElement("span");
  d.textContent = s;
  return d.innerHTML;
}

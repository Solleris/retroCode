declare const retro: { send(req: unknown): void };

import { t } from "../i18n.ts";
export interface ConsensusFile {
  path: string;
  verdict: "identical" | "equivalent" | "divergent" | "minority";
  touchedBy: string[];
  distinctHashes: number;
  uncovered: boolean;
  variants: { variantId: string; status: string; hash: string; added: number; removed: number; patch: string }[];
}
export interface ConsensusReportMsg {
  taskId: string; base: string; agreementPct: number; needsReview: number;
  measured: boolean; totalCostUsd: number;
  variants: { id: string; label: string; ok: boolean; costUsd?: number }[];
  files: ConsensusFile[];
  tests: { variantId: string; ran: boolean; ok: boolean; command: string;
           passed?: number; failed?: number; failedNames: string[]; output: string }[];
}

export interface ConsensusSurface {
  el: HTMLElement;
  taskId: string;
  progress(variantId: string, phase: string, note: string): void;
  render(r: ConsensusReportMsg): void;
  fail(reason: string): void;
  adopted(path: string, ok: boolean): void;
  focus(): void;
  dispose(): void;
}

const VERDICT = {
  divergent:  { label: t("cons.divergent"), cls: "v-div",  hint: t("cons.hDivergent") },
  minority:   { label: t("cons.minority"), cls: "v-min",  hint: t("cons.hMinority") },
  equivalent: { label: t("cons.equivalent"), cls: "v-eq",  hint: t("cons.hEquivalent") },
  identical:  { label: t("cons.identical"), cls: "v-id",   hint: t("cons.hIdentical") },
} as const;

export function createConsensus(taskId: string, cwd: string): ConsensusSurface {
  const el = document.createElement("div");
  el.className = "surface surface-cons";

  const head = document.createElement("div");
  head.className = "cons-head";
  head.innerHTML = `<span class="cons-title">consenso</span>
    <span class="cons-state">${t("cons.ready")}</span><span class="cons-spacer"></span>
    <span class="cons-meta"></span>
    <button class="cons-discard" type="button" hidden>descartar</button>`;
  const stateEl = head.querySelector<HTMLElement>(".cons-state")!;
  const metaEl = head.querySelector<HTMLElement>(".cons-meta")!;
  const discardBtn = head.querySelector<HTMLButtonElement>(".cons-discard")!;

  const body = document.createElement("div");
  body.className = "cons-body";

  const composer = document.createElement("div");
  composer.className = "cons-composer";
  const input = document.createElement("textarea");
  input.className = "cons-input";
  input.rows = 2;
  input.placeholder = t("cons.placeholder");
  const testsToggle = document.createElement("label");
  testsToggle.className = "cons-check";
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = true;
  testsToggle.append(cb, document.createTextNode(t("cons.runTests")));
  const go = document.createElement("button");
  go.type = "button"; go.className = "cons-go"; go.textContent = t("cons.run");
  composer.append(input, testsToggle, go);

  el.append(head, body, composer);

  let running = false;
  const progressLines = new Map<string, HTMLElement>();

  function setRunning(on: boolean, label: string): void {
    running = on;
    stateEl.textContent = label;
    stateEl.dataset["s"] = on ? "running" : "idle";
    input.disabled = on; go.disabled = on; cb.disabled = on;
  }

  function start(): void {
    const prompt = input.value.trim();
    if (!prompt || running) return;
    body.replaceChildren();
    progressLines.clear();
    metaEl.textContent = "";
    discardBtn.hidden = true;
    setRunning(true, "rodando 3 variantes");
    const note = document.createElement("div");
    note.className = "cons-note";
    note.textContent = `“${prompt}”`;
    body.append(note);
    retro.send({ t: "startConsensus", taskId, prompt, cwd, runTests: cb.checked });
  }

  go.addEventListener("click", start);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || !e.shiftKey)) { e.preventDefault(); start(); }
  });
  discardBtn.addEventListener("click", () => {
    retro.send({ t: "discardConsensus", taskId });
    discardBtn.hidden = true;
    metaEl.textContent = t("cons.discarded");
  });
  setRunning(false, t("cons.ready"));

  function progressRow(variantId: string): HTMLElement {
    let row = progressLines.get(variantId);
    if (!row) {
      row = document.createElement("div");
      row.className = "cons-prog";
      body.append(row);
      progressLines.set(variantId, row);
    }
    return row;
  }

  /** One block per file: a header with the verdict, then the variants. */
  function fileBlock(f: ConsensusFile): HTMLElement {
    const v = VERDICT[f.verdict];
    const box = document.createElement("div");
    box.className = `cons-file ${v.cls}`;

    const hdr = document.createElement("button");
    hdr.type = "button";
    hdr.className = "cons-file-head";
    const badge = document.createElement("span");
    badge.className = "cons-badge";
    badge.textContent = v.label;
    const path = document.createElement("span");
    path.className = "cons-path";
    path.textContent = f.path;
    const who = document.createElement("span");
    who.className = "cons-who";
    who.textContent = `${f.touchedBy.join("")} · ${f.distinctHashes}v`;
    hdr.append(badge, path, who);

    const detail = document.createElement("div");
    detail.className = "cons-detail";
    // Divergence and minority open by default: they are what needs reading.
    // Identical and equivalent stay closed — their value is precisely that you
    // do NOT spend attention there.
    detail.hidden = f.verdict === "identical" || f.verdict === "equivalent";

    const hint = document.createElement("div");
    hint.className = "cons-hint";
    hint.textContent = v.hint + (f.uncovered ? t("cons.uncovered") : "");
    detail.append(hint);

    for (const vr of f.variants) {
      const row = document.createElement("div");
      row.className = "cons-var";
      const id = document.createElement("span");
      id.className = "cons-var-id";
      id.textContent = vr.variantId;
      const stat = document.createElement("span");
      stat.className = "cons-var-stat";
      stat.innerHTML = `<b class="add">+${vr.added}</b> <b class="del">−${vr.removed}</b>`;
      const adopt = document.createElement("button");
      adopt.type = "button";
      adopt.className = "cons-adopt";
      adopt.textContent = t("cons.adopt");
      adopt.addEventListener("click", () =>
        retro.send({ t: "adoptFile", taskId, variantId: vr.variantId, path: f.path }));

      const show = document.createElement("button");
      show.type = "button";
      show.className = "cons-show";
      show.textContent = t("cons.seeDiff");
      const patch = document.createElement("pre");
      patch.className = "cons-patch";
      patch.hidden = true;
      patch.append(...colorPatch(vr.patch));
      show.addEventListener("click", () => { patch.hidden = !patch.hidden; });

      row.append(id, stat, show, adopt);
      detail.append(row, patch);
    }

    hdr.addEventListener("click", () => { detail.hidden = !detail.hidden; });
    box.append(hdr, detail);
    return box;
  }

  return {
    el, taskId,
    focus: () => input.focus(),

    progress(variantId, phase, note) {
      progressRow(variantId).textContent = `[${variantId}] ${phase}: ${note}`;
    },

    render(r) {
      setRunning(false, t("cons.readyReview"));
      body.replaceChildren();
      progressLines.clear();
      discardBtn.hidden = false;

      const cost = `$${r.totalCostUsd.toFixed(2)}`;
      metaEl.textContent = `${r.needsReview}/${r.files.length} exigem leitura · ${cost}`;

      // Summary: the number that matters is how many files you must READ.
      const sum = document.createElement("div");
      sum.className = "cons-sum";
      sum.innerHTML = `<b class="cons-big">${r.needsReview}</b>
        <span>de ${r.files.length} arquivos exigem sua leitura</span>`;
      body.append(sum);

      if (!r.measured) {
        const warn = document.createElement("div");
        warn.className = "cons-warn";
        warn.textContent = t("cons.noTests");
        body.append(warn);
      }

      const tests = document.createElement("div");
      tests.className = "cons-tests";
      for (const tst of r.tests) {
        const s = document.createElement("span");
        s.className = "cons-test " + (!tst.ran ? "na" : tst.ok ? "ok" : "bad");
        s.textContent = !tst.ran ? `${tst.variantId}${t("cons.didNotRun")}`
          : `${tst.variantId}: ${tst.passed ?? "?"} ${t("cons.ok")}${tst.failed ? ` / ${tst.failed} ${t("cons.fail")}` : ""}`;
        s.title = tst.output;
        tests.append(s);
      }
      if (r.tests.length) body.append(tests);

      const needs = r.files.filter((f) => f.verdict === "divergent" || f.verdict === "minority");
      const rest = r.files.filter((f) => f.verdict === "identical" || f.verdict === "equivalent");

      if (needs.length) {
        body.append(section(t("cons.readThis")));
        for (const f of needs) body.append(fileBlock(f));
      }
      if (rest.length) {
        body.append(section(t("cons.noReadNeeded", { n: rest.length })));
        for (const f of rest) body.append(fileBlock(f));
      }
    },

    fail(reason) {
      setRunning(false, "falhou");
      const e = document.createElement("div");
      e.className = "cons-warn";
      e.textContent = reason;
      body.append(e);
    },

    adopted(path, ok) {
      const n = document.createElement("div");
      n.className = "cons-note";
      n.textContent = ok ? `adotado: ${path}` : `falha ao adotar: ${path}`;
      body.append(n);
    },

    dispose() { retro.send({ t: "discardConsensus", taskId }); },
  };
}

function section(text: string): HTMLElement {
  const h = document.createElement("div");
  h.className = "cons-section";
  h.textContent = text;
  return h;
}

/** Colours the patch line by line. Cheap and enough — this is reading, not editing. */
function colorPatch(patch: string): Node[] {
  return patch.split("\n").slice(0, 400).map((line) => {
    const s = document.createElement("span");
    s.className = line.startsWith("+") ? "pl-add"
      : line.startsWith("-") ? "pl-del"
      : line.startsWith("@@") ? "pl-hunk"
      : line.startsWith("diff ") || line.startsWith("index ") ? "pl-meta" : "pl-ctx";
    s.textContent = line + "\n";
    return s;
  });
}

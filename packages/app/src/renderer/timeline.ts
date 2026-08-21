import type { TimelineEvent } from "@retro/protocol";

/**
 * THE TIMELINE — the screen's X axis is TIME, not space.
 *
 * Why Canvas and not DOM: a working session produces thousands of marks, and
 * zoom/pan have to be continuous. A thousand `<div>`s repositioned every scroll
 * frame stutter; a thousand canvas rectangles do not.
 *
 * What the geometry communicates, and no IDE communicates today:
 *   · horizontal distance = real elapsed time. An agent that thought for 4min
 *     occupies 4min of screen. You SEE where the time went.
 *   · parallel bands = concurrent work, aligned on the same clock. Where three
 *     variants diverge becomes visible as shape, not as text.
 *   · a gate is not a milestone, it is a BAR that stretches until resolved.
 *     Blocked time is area on screen — impossible to miss.
 */

const LABEL_W = 92;
const RULER_H = 22;
const LANE_H = 30;
const LANE_GAP = 3;
const MIN_SPAN = 4_000;            // maximum zoom: a 4s window
const MAX_SPAN = 12 * 3600_000;    // minimum zoom: 12h

export interface Lane { id: string; label: string; kind: "you" | "agent" | "cons" | "term" }

export interface TimelineHooks {
  onSelect(ev: TimelineEvent | null): void;
  onActivate(ev: TimelineEvent): void;       // ⏎ / duplo clique
  onPlayhead(at: number, detached: boolean): void;
}

interface Palette {
  bg: string; rule: string; ink: string; dim: string; faint: string;
  signal: string; ok: string; bad: string;
  fn: string; key: string; str: string; num: string; prop: string; surface2: string;
}

export class Timeline {
  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #hooks: TimelineHooks;
  #pal: Palette;

  #events: TimelineEvent[] = [];
  #byLane = new Map<string, TimelineEvent[]>();
  #lanes: Lane[] = [];

  #spanMs = 5 * 60_000;      // visible window
  #endMs = Date.now();       // borda direita da janela
  #following = true;         // right edge pinned to NOW
  #playhead = Date.now();
  #selected: TimelineEvent | null = null;
  #hover: TimelineEvent | null = null;
  #dirty = true;
  #dragging: { x: number; end: number } | null = null;

  constructor(canvas: HTMLCanvasElement, hooks: TimelineHooks) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext("2d", { alpha: false })!;
    this.#hooks = hooks;
    this.#pal = readPalette();

    new ResizeObserver(() => { this.#resize(); }).observe(canvas);
    this.#resize();
    this.#wire();

    const loop = (): void => {
      if (this.#following) {
        this.#endMs = Date.now();
        this.#playhead = this.#endMs;
        this.#dirty = true;
      }
      if (this.#dirty) { this.#draw(); this.#dirty = false; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ── dados ────────────────────────────────────────────────────────────
  load(events: TimelineEvent[]): void {
    this.#events = [...events].sort((a, b) => a.at - b.at || a.id - b.id);
    this.#reindex();
    if (this.#events.length && this.#following) {
      const first = this.#events[0]!.at;
      const last = this.#events[this.#events.length - 1]!.at;
      // Frame the whole session on first load: you open the app and see what
      // happened while you were not looking.
      this.#spanMs = Math.min(MAX_SPAN, Math.max(MIN_SPAN, (last - first) * 1.25 + 30_000));
    }
    this.#dirty = true;
  }

  push(e: TimelineEvent): void {
    this.#events.push(e);
    this.#reindex();
    this.#dirty = true;
  }

  #reindex(): void {
    this.#byLane.clear();
    for (const e of this.#events) {
      const l = this.#byLane.get(e.lane) ?? [];
      l.push(e);
      this.#byLane.set(e.lane, l);
    }
    // Band order: you first (you are the reference), then agents and consensus
    // variants, terminals last.
    const rank = (id: string): number =>
      id === "you" ? 0 : id.startsWith("agent:") ? 1 : id.startsWith("cons:") ? 2 : 3;
    this.#lanes = [...this.#byLane.keys()]
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .map((id) => ({ id, label: laneLabel(id), kind: laneKind(id) }));
  }

  // ── navigation ───────────────────────────────────────────────────────
  zoom(factor: number): void {
    const anchor = this.#playhead;
    const rel = (this.#endMs - anchor) / this.#spanMs;
    this.#spanMs = Math.min(MAX_SPAN, Math.max(MIN_SPAN, this.#spanMs * factor));
    this.#endMs = anchor + rel * this.#spanMs;
    this.#detachIfPast();
    this.#dirty = true;
  }

  pan(deltaMs: number): void {
    this.#endMs += deltaMs;
    this.#detachIfPast();
    this.#dirty = true;
  }

  /** Moves the playhead to the previous/next event — navigation by event. */
  step(dir: 1 | -1): void {
    const at = this.#playhead;
    const pool = this.#events;
    const next = dir > 0
      ? pool.find((e) => e.at > at + 1)
      : [...pool].reverse().find((e) => e.at < at - 1);
    if (!next) return;
    this.#playhead = next.at;
    this.#selected = next;
    this.#following = false;
    // Keeps the playhead inside the window, pushing it when it leaves.
    const start = this.#endMs - this.#spanMs;
    if (next.at > this.#endMs - this.#spanMs * 0.1) this.#endMs = next.at + this.#spanMs * 0.1;
    if (next.at < start) this.#endMs = next.at + this.#spanMs * 0.9;
    this.#hooks.onSelect(next);
    this.#hooks.onPlayhead(this.#playhead, true);
    this.#dirty = true;
  }

  follow(): void {
    this.#following = true;
    this.#endMs = Date.now();
    this.#playhead = this.#endMs;
    this.#hooks.onPlayhead(this.#playhead, false);
    this.#dirty = true;
  }

  get selected(): TimelineEvent | null { return this.#selected; }
  get playheadAt(): number { return this.#playhead; }
  get detached(): boolean { return !this.#following; }

  activateSelected(): void { if (this.#selected) this.#hooks.onActivate(this.#selected); }

  #detachIfPast(): void {
    const wasFollowing = this.#following;
    this.#following = this.#endMs >= Date.now() - 1500;
    if (wasFollowing !== this.#following) this.#hooks.onPlayhead(this.#playhead, !this.#following);
  }

  // ── geometria ────────────────────────────────────────────────────────
  #plotW(): number { return this.#canvas.clientWidth - LABEL_W - 10; }
  #x(t: number): number {
    const start = this.#endMs - this.#spanMs;
    return LABEL_W + ((t - start) / this.#spanMs) * this.#plotW();
  }
  #t(x: number): number {
    const start = this.#endMs - this.#spanMs;
    return start + ((x - LABEL_W) / this.#plotW()) * this.#spanMs;
  }
  #laneY(i: number): number { return RULER_H + i * (LANE_H + LANE_GAP); }

  #resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.#canvas.clientWidth, h = this.#canvas.clientHeight;
    this.#canvas.width = Math.max(1, Math.round(w * dpr));
    this.#canvas.height = Math.max(1, Math.round(h * dpr));
    this.#ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.#dirty = true;
  }

  // ── interaction ──────────────────────────────────────────────────────
  #wire(): void {
    this.#canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      // Wheel = pan through time; with ⌘/ctrl = zoom. Like a video editor.
      if (e.metaKey || e.ctrlKey) this.zoom(e.deltaY > 0 ? 1.12 : 0.89);
      else this.pan((e.deltaX !== 0 ? e.deltaX : e.deltaY) / this.#plotW() * this.#spanMs);
    }, { passive: false });

    this.#canvas.addEventListener("mousedown", (e) => {
      const r = this.#canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const hit = this.#hit(x, y);
      this.#playhead = this.#t(x);
      this.#following = false;
      this.#selected = hit;
      this.#hooks.onSelect(hit);
      this.#hooks.onPlayhead(this.#playhead, true);
      this.#dragging = { x: e.clientX, end: this.#endMs };
      this.#dirty = true;
    });

    this.#canvas.addEventListener("dblclick", () => this.activateSelected());

    window.addEventListener("mousemove", (e) => {
      if (this.#dragging) {
        const dx = e.clientX - this.#dragging.x;
        this.#endMs = this.#dragging.end - (dx / this.#plotW()) * this.#spanMs;
        this.#detachIfPast();
        this.#dirty = true;
        return;
      }
      const r = this.#canvas.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom) { if (this.#hover) { this.#hover = null; this.#dirty = true; } return; }
      const h = this.#hit(e.clientX - r.left, e.clientY - r.top);
      if (h !== this.#hover) { this.#hover = h; this.#dirty = true; }
    });
    window.addEventListener("mouseup", () => { this.#dragging = null; });
  }

  #hit(x: number, y: number): TimelineEvent | null {
    const i = Math.floor((y - RULER_H) / (LANE_H + LANE_GAP));
    const lane = this.#lanes[i];
    if (!lane) return null;
    const t = this.#t(x);
    const tol = (12 / this.#plotW()) * this.#spanMs;
    let best: TimelineEvent | null = null, bestD = Infinity;
    for (const e of this.#byLane.get(lane.id) ?? []) {
      const d = Math.abs(e.at - t);
      if (d < tol && d < bestD) { best = e; bestD = d; }
    }
    return best;
  }

  // ── desenho ──────────────────────────────────────────────────────────
  #draw(): void {
    const c = this.#ctx, p = this.#pal;
    const w = this.#canvas.clientWidth, h = this.#canvas.clientHeight;
    c.fillStyle = p.bg;
    c.fillRect(0, 0, w, h);

    this.#drawRuler(w);

    this.#lanes.forEach((lane, i) => {
      const y = this.#laneY(i);
      if (y > h) return;
      this.#drawLane(lane, y, w);
    });

    // Playhead last: it is the reading reference and must not sit behind.
    const px = this.#x(this.#playhead);
    if (px >= LABEL_W && px <= w) {
      c.strokeStyle = this.#following ? p.ok : p.signal;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(Math.round(px) + 0.5, 0);
      c.lineTo(Math.round(px) + 0.5, h);
      c.stroke();
    }

    if (this.#hover) this.#drawTooltip(this.#hover, w, h);
  }

  #drawRuler(w: number): void {
    const c = this.#ctx, p = this.#pal;
    c.fillStyle = p.surface2;
    c.fillRect(0, 0, w, RULER_H);
    c.strokeStyle = p.rule;
    c.beginPath(); c.moveTo(0, RULER_H + 0.5); c.lineTo(w, RULER_H + 0.5); c.stroke();

    // The nearest "round" step for the current width — the same trick a chart
    // axis uses: the label has to land on a readable second or minute.
    const steps = [1e3, 5e3, 15e3, 60e3, 5 * 60e3, 15 * 60e3, 3600e3, 6 * 3600e3];
    const target = this.#spanMs / 6;
    const step = steps.find((s) => s >= target) ?? steps[steps.length - 1]!;
    const start = this.#endMs - this.#spanMs;

    c.font = '9px "SF Mono", monospace';
    c.textBaseline = "middle";
    for (let t = Math.ceil(start / step) * step; t <= this.#endMs; t += step) {
      const x = Math.round(this.#x(t)) + 0.5;
      if (x < LABEL_W) continue;
      c.strokeStyle = p.rule;
      c.beginPath(); c.moveTo(x, RULER_H - 6); c.lineTo(x, RULER_H); c.stroke();
      c.fillStyle = p.faint;
      c.fillText(clock(t), x + 3, RULER_H / 2);
    }

    if (this.#following) {
      c.fillStyle = p.ok;
      c.fillText("NOW", w - 44, RULER_H / 2);
    } else {
      c.fillStyle = p.signal;
      c.fillText("◀ passado", w - 58, RULER_H / 2);
    }
  }

  #drawLane(lane: Lane, y: number, w: number): void {
    const c = this.#ctx, p = this.#pal;
    const mid = y + LANE_H / 2;
    const events = this.#byLane.get(lane.id) ?? [];

    // label
    c.fillStyle = p.surface2;
    c.fillRect(0, y, LABEL_W - 6, LANE_H);
    c.font = '10px "SF Mono", monospace';
    c.textBaseline = "middle";
    c.fillStyle = lane.kind === "you" ? p.ink : p.dim;
    c.fillText(lane.label.slice(0, 13), 8, mid);

    // trilha
    c.strokeStyle = p.rule;
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(LABEL_W, Math.round(mid) + 0.5); c.lineTo(w, Math.round(mid) + 0.5); c.stroke();

    // Gates first: they are bars covering an interval, and the rest draws on top.
    for (const e of events) {
      if (e.kind !== "gate") continue;
      const resolved = events.find((x) => x.kind === "gate-done" && x.ref === e.ref)
        ?? this.#events.find((x) => x.kind === "gate-done" && x.ref === e.ref);
      const x0 = this.#x(e.at);
      const x1 = this.#x(resolved ? resolved.at : Date.now());
      if (x1 < LABEL_W || x0 > w) continue;
      /**
       * Blocked time is AREA, not a point. A pending gate grows on screen every
       * frame, and an agent stalled for 8 minutes is visually unbearable —
       * which is exactly the intended effect.
       */
      c.fillStyle = resolved ? "rgba(239,168,76,0.16)" : "rgba(239,168,76,0.34)";
      c.fillRect(Math.max(LABEL_W, x0), y + 3, Math.max(2, x1 - x0), LANE_H - 6);
      if (!resolved) {
        c.strokeStyle = p.signal;
        c.setLineDash([3, 3]);
        c.strokeRect(Math.max(LABEL_W, x0) + 0.5, y + 3.5, Math.max(2, x1 - x0) - 1, LANE_H - 7);
        c.setLineDash([]);
      }
    }

    for (const e of events) {
      const x = this.#x(e.at);
      if (x < LABEL_W - 8 || x > w + 8) continue;
      const sel = this.#selected?.id === e.id;
      this.#drawMark(e, x, mid, sel);
    }
  }

  #drawMark(e: TimelineEvent, x: number, mid: number, sel: boolean): void {
    const c = this.#ctx, p = this.#pal;
    const ring = (): void => {
      if (!sel) return;
      c.strokeStyle = p.signal; c.lineWidth = 1;
      c.beginPath(); c.arc(x, mid, 7, 0, Math.PI * 2); c.stroke();
    };

    switch (e.kind) {
      case "lane-start":
        c.strokeStyle = p.dim; c.lineWidth = 1.5;
        c.beginPath(); c.arc(x, mid, 3.5, 0, Math.PI * 2); c.stroke();
        break;
      case "lane-end": {
        const ok = e.label === "ok";
        c.fillStyle = ok ? p.ok : p.bad;
        c.beginPath(); c.arc(x, mid, 4, 0, Math.PI * 2); c.fill();
        break;
      }
      case "tool": {
        // A diamond, coloured by the tool's family: read, write, run.
        const fam = toolFamily(e.label);
        c.fillStyle = fam === "write" ? p.num : fam === "run" ? p.key : p.fn;
        c.beginPath();
        c.moveTo(x, mid - 4); c.lineTo(x + 4, mid); c.lineTo(x, mid + 4); c.lineTo(x - 4, mid);
        c.closePath(); c.fill();
        break;
      }
      case "tool-done":
        c.fillStyle = e.label === "ok" ? p.ok : p.bad;
        c.fillRect(x - 1, mid + 6, 2, 3);
        break;
      case "text":
        c.fillStyle = p.faint;
        c.fillRect(x - 0.5, mid - 5, 1, 10);
        break;
      case "edit":
        c.fillStyle = p.ink;
        c.beginPath(); c.arc(x, mid, 3.5, 0, Math.PI * 2); c.fill();
        break;
      case "gate": case "gate-done":
        c.fillStyle = p.signal;
        c.fillRect(x - 1.5, mid - 7, 3, 14);
        break;
      case "test":
        c.strokeStyle = e.label.includes("ok") ? p.ok : p.bad; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(x - 4, mid + 3); c.lineTo(x - 1, mid + 6); c.lineTo(x + 4, mid - 4); c.stroke();
        break;
      default:
        c.fillStyle = p.faint;
        c.fillRect(x - 1, mid - 2, 2, 4);
    }
    ring();
  }

  #drawTooltip(e: TimelineEvent, w: number, h: number): void {
    const c = this.#ctx, p = this.#pal;
    const text = `${clock(e.at)}  ${e.kind}  ${e.label}`.slice(0, 90);
    c.font = '10px "SF Mono", monospace';
    const tw = c.measureText(text).width + 14;
    let x = this.#x(e.at) + 10;
    if (x + tw > w) x = w - tw - 4;
    const y = Math.min(h - 24, this.#laneY(this.#lanes.findIndex((l) => l.id === e.lane)) - 20);
    c.fillStyle = p.surface2;
    c.fillRect(x, Math.max(0, y), tw, 18);
    c.strokeStyle = p.rule;
    c.strokeRect(x + 0.5, Math.max(0, y) + 0.5, tw - 1, 17);
    c.fillStyle = p.ink;
    c.textBaseline = "middle";
    c.fillText(text, x + 7, Math.max(0, y) + 9);
  }
}

// ── auxiliares ─────────────────────────────────────────────────────────

function laneKind(id: string): Lane["kind"] {
  return id === "you" ? "you" : id.startsWith("agent:") ? "agent"
    : id.startsWith("cons:") ? "cons" : "term";
}

function laneLabel(id: string): string {
  if (id === "you") return "you";
  if (id.startsWith("cons:")) { const p = id.split(":"); return `var·${p[2]}`; }
  if (id.startsWith("agent:")) return `ag·${id.slice(6, 12)}`;
  if (id.startsWith("term:")) return `term·${id.slice(5, 11)}`;
  return id.slice(0, 13);
}

function toolFamily(name: string): "read" | "write" | "run" {
  if (/^(Write|Edit|NotebookEdit|MultiEdit)$/.test(name)) return "write";
  if (/^(Bash|BashOutput|Task)$/.test(name)) return "run";
  return "read";
}

function clock(t: number): string {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string, f: string): string => s.getPropertyValue(n).trim() || f;
  return {
    bg: v("--bg", "#0B0E12"), rule: v("--rule", "#1E252E"),
    ink: v("--ink", "#DCE3EC"), dim: v("--ink-dim", "#94A0AF"), faint: v("--ink-faint", "#5F6B7A"),
    signal: v("--signal", "#EFA84C"), ok: v("--ok", "#6FCF97"), bad: v("--bad", "#EB7C6F"),
    fn: v("--code-fn", "#82AAFF"), key: v("--code-key", "#C792EA"),
    str: v("--code-str", "#C3E88D"), num: v("--code-num", "#F78C6C"),
    prop: v("--code-prop", "#89DDFF"), surface2: v("--surface-2", "#171C24"),
  };
}

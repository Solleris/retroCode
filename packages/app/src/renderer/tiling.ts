import {
  type PaneNode, type Surface, type Axis,
  leaf, splitLeaf, closeLeaf, findLeaf, leaves, replaceLeaf,
} from "@retro/protocol/layout";

export interface TilingOpts {
  /** Creates a surface's element. Called ONCE per leaf. */
  mount(leafId: string, surface: Surface): HTMLElement;
  /**
   * Called when a leaf leaves the tree. It receives the surface because the
   * caller needs to know WHICH resource to release — sweeping the DOM looking
   * for orphan elements works by accident and breaks the first time the order
   * of remove and re-render changes.
   */
  unmount(leafId: string, surface: Surface): void;
  onFocus(leafId: string, surface: Surface): void;
  onLayoutChange(root: PaneNode): void;
}

let seq = 0;
const nextId = (): string => `pane${++seq}`;

/**
 * Renders the pane tree into DOM.
 *
 * The invariant that makes this work: surface elements are created once and
 * **reparented** on every re-render, never recreated. Recreating an xterm on
 * each split would wipe the scrollback and kill the connection to the pty —
 * the obvious bug the naive version of this class always has.
 */
export class TilingHost {
  #root: PaneNode;
  #focused: string;
  #surfaces = new Map<string, HTMLElement>();
  #host: HTMLElement;
  #opts: TilingOpts;

  /**
   * The constructor does NOT render and does NOT call back.
   *
   * Doing it here would mean invoking `mount`/`onFocus` before
   * `const tiling = new TilingHost(...)` had bound the variable — and before
   * the other pieces (sidebar, palette) existed. Any callback touching them
   * would blow up with "undefined". A constructor that calls back into its own
   * consumer is a trap; the work belongs in `start()`.
   */
  constructor(host: HTMLElement, initial: Surface, opts: TilingOpts) {
    this.#host = host;
    this.#opts = opts;
    const id = nextId();
    this.#root = leaf(id, initial);
    this.#focused = id;
  }

  /**
   * Installs a saved tree WITHOUT rendering — `start()` takes care of that.
   *
   * Same discipline as the constructor: do not call back into the consumer
   * before it exists. That was exactly the original TilingHost bug.
   */
  restore(tree: PaneNode): void {
    this.#root = tree;
    this.#focused = leaves(tree)[0]?.id ?? this.#focused;

    /*
     * Push the counter past the highest restored id.
     *
     * `nextId()` is `pane${++seq}` with a module-level seq that starts at 0 on
     * every load. Without this, the first split after restoring "pane1..pane3"
     * would produce "pane1" again — two nodes with the same id, and `findLeaf`
     * answering for the wrong pane. It is the same mistake the sequential
     * ptyIds made, and it gives no warning: it just swaps the pane under your
     * click.
     */
    for (const l of leaves(tree)) {
      const n = Number(/^pane(\d+)$/.exec(l.id)?.[1] ?? 0);
      if (n > seq) seq = n;
    }
  }

  start(): void {
    this.render();
    const l = findLeaf(this.#root, this.#focused);
    if (l) this.#opts.onFocus(l.id, l.surface);
    this.#opts.onLayoutChange(this.#root);
  }

  get root(): PaneNode { return this.#root; }
  get focused(): string { return this.#focused; }

  split(axis: Axis, surface: Surface): void {
    const id = nextId();
    this.#root = splitLeaf(this.#root, this.#focused, axis, id, surface);
    this.#focused = id;
    this.render();
    this.#opts.onFocus(id, surface);
    this.#opts.onLayoutChange(this.#root);
  }

  closeFocused(): void {
    const all = leaves(this.#root);
    if (all.length === 1) return; // the last pane stays; an empty window is worse than an empty pane
    const dying = this.#focused;
    const dyingLeaf = findLeaf(this.#root, dying);
    const next = closeLeaf(this.#root, dying);
    if (!next || !dyingLeaf) return;
    this.#root = next;
    this.#dropSurface(dying, dyingLeaf.surface);
    const remaining = leaves(this.#root);
    const first = remaining[0];
    if (first) { this.#focused = first.id; this.#opts.onFocus(first.id, first.surface); }
    this.render();
    this.#opts.onLayoutChange(this.#root);
  }

  /**
   * Swaps a pane's surface in place, preserving its id and geometry.
   * It is the "open a file here" primitive — and the one tabs will use.
   */
  setSurface(id: string, surface: Surface): void {
    const l = findLeaf(this.#root, id);
    if (!l) return;
    this.#dropSurface(id, l.surface);
    this.#root = replaceLeaf(this.#root, id, { n: "leaf", id, surface });
    this.#focused = id;
    this.render();
    this.#opts.onFocus(id, surface);
    this.#opts.onLayoutChange(this.#root);
  }

  /** Every leaf, in tree order. Used to find an editor pane. */
  allLeaves(): Extract<PaneNode, { n: "leaf" }>[] { return leaves(this.#root); }

  focus(id: string): void {
    const l = findLeaf(this.#root, id);
    if (!l) return;
    this.#focused = id;
    this.#paintFocus();
    this.#opts.onFocus(id, l.surface);
  }

  /** Cycles in tree order — predictable, which is what a keyboard demands. */
  cycle(dir: 1 | -1): void {
    const all = leaves(this.#root);
    const i = all.findIndex((l) => l.id === this.#focused);
    const target = all[(i + dir + all.length) % all.length];
    if (target) this.focus(target.id);
  }

  #dropSurface(id: string, surface: Surface): void {
    this.#surfaces.get(id)?.remove();
    this.#surfaces.delete(id);
    this.#opts.unmount(id, surface);
  }

  #surfaceFor(id: string, surface: Surface): HTMLElement {
    let el = this.#surfaces.get(id);
    if (!el) { el = this.#opts.mount(id, surface); this.#surfaces.set(id, el); }
    return el;
  }

  render(): void {
    // Detach the children before clearing, otherwise removing them from the
    // DOM destroys the internal canvas/WebGL state of whatever was mounted.
    for (const el of this.#surfaces.values()) el.remove();
    this.#host.replaceChildren(this.#build(this.#root));
    this.#paintFocus();
  }

  #build(node: PaneNode): HTMLElement {
    if (node.n === "leaf") {
      const pane = document.createElement("div");
      pane.className = "pane";
      pane.dataset["leaf"] = node.id;
      pane.append(this.#surfaceFor(node.id, node.surface));
      pane.addEventListener("mousedown", () => this.focus(node.id), true);
      return pane;
    }

    const box = document.createElement("div");
    box.className = `split ${node.axis === "h" ? "split-h" : "split-v"}`;
    const a = this.#build(node.a);
    const b = this.#build(node.b);
    a.style.flex = `${node.ratio}`;
    b.style.flex = `${1 - node.ratio}`;

    const div = document.createElement("div");
    div.className = "divider";
    this.#wireDrag(div, box, node, a, b);

    box.append(a, div, b);
    return box;
  }

  #wireDrag(div: HTMLElement, box: HTMLElement, node: Extract<PaneNode, { n: "split" }>,
            a: HTMLElement, b: HTMLElement): void {
    div.addEventListener("mousedown", (down) => {
      down.preventDefault();
      const horiz = node.axis === "h";
      const rect = box.getBoundingClientRect();
      const total = horiz ? rect.width : rect.height;

      const move = (m: MouseEvent): void => {
        const pos = horiz ? m.clientX - rect.left : m.clientY - rect.top;
        // Clamped at 8% so dragging to the edge cannot create an unreachable pane.
        const ratio = Math.min(0.92, Math.max(0.08, pos / total));
        node.ratio = ratio;
        a.style.flex = `${ratio}`;
        b.style.flex = `${1 - ratio}`;
        window.dispatchEvent(new Event("retro:relayout"));
      };
      const up = (): void => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.classList.remove("dragging");
        this.#opts.onLayoutChange(this.#root);
      };
      document.body.classList.add("dragging");
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }

  #paintFocus(): void {
    for (const el of this.#host.querySelectorAll<HTMLElement>(".pane")) {
      el.classList.toggle("focused", el.dataset["leaf"] === this.#focused);
    }
  }
}

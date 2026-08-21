/**
 * A file tree with lazy expansion.
 *
 * Each directory asks the daemon for its own contents the first time it is
 * opened, and the result is cached. A full walk in a large monorepo would
 * freeze the UI for seconds and most of the result would never be seen.
 */

export interface TreeEntry { name: string; dir: boolean }

import { icons } from "./icons.ts";

declare const retro: { send(req: unknown): void };

interface Node {
  path: string;          // absoluto
  name: string;
  dir: boolean;
  depth: number;
  expanded: boolean;
  loading: boolean;
  children: Node[] | null;
}

export class FileTree {
  #host: HTMLElement;
  #root: Node | null = null;
  #byPath = new Map<string, Node>();
  #onOpenFile: (absPath: string) => void;
  #activePath: string | null = null;
  #gitRoot = "";

  constructor(host: HTMLElement, onOpenFile: (absPath: string) => void) {
    this.#host = host;
    this.#onOpenFile = onOpenFile;
  }

  setRoot(absPath: string, name: string): void {
    this.#byPath.clear();
    this.#root = {
      path: absPath, name, dir: true, depth: 0,
      expanded: true, loading: true, children: null,
    };
    this.#byPath.set(absPath, this.#root);
    this.#gitRoot = absPath;
    retro.send({ t: "listDir", path: absPath, root: absPath });
    this.render();
  }

  setActive(absPath: string | null): void {
    this.#activePath = absPath;
    // Reveal the active file: open every ancestor down to it.
    if (absPath && this.#root && absPath.startsWith(this.#root.path)) {
      const parts = absPath.slice(this.#root.path.length + 1).split("/");
      let cur = this.#root.path;
      for (let i = 0; i < parts.length - 1; i++) {
        cur += `/${parts[i]}`;
        const n = this.#byPath.get(cur);
        if (n && !n.expanded) { n.expanded = true; this.#ensureChildren(n); }
        else if (!n) break;
      }
    }
    this.render();
  }

  /** Resposta de `listDir`. */
  ingest(absPath: string, entries: TreeEntry[]): void {
    const node = this.#byPath.get(absPath);
    if (!node) return;
    node.loading = false;
    node.children = entries.map((e) => {
      const path = `${absPath}/${e.name}`;
      const existing = this.#byPath.get(path);
      if (existing) return existing;   // preserves expansion state across reloads
      const n: Node = {
        path, name: e.name, dir: e.dir, depth: node.depth + 1,
        expanded: false, loading: false, children: null,
      };
      this.#byPath.set(path, n);
      return n;
    });
    this.render();
  }

  #ensureChildren(n: Node): void {
    if (n.children === null && !n.loading) {
      n.loading = true;
      retro.send({ t: "listDir", path: n.path, root: this.#gitRoot });
    }
  }

  #toggle(n: Node): void {
    n.expanded = !n.expanded;
    if (n.expanded) this.#ensureChildren(n);
    this.render();
  }

  render(): void {
    this.#host.replaceChildren();
    if (!this.#root) return;
    // The root is not shown as a row: the project name is already in the
    // header, and a root row would only cost everyone an indent level.
    this.#renderChildren(this.#root);
  }

  #renderChildren(parent: Node): void {
    if (parent.loading && parent.children === null) {
      const l = document.createElement("div");
      l.className = "tree-loading";
      l.style.paddingLeft = `${14 + parent.depth * 12}px`;
      l.textContent = "…";
      this.#host.append(l);
      return;
    }
    for (const n of parent.children ?? []) {
      this.#host.append(this.#row(n));
      if (n.dir && n.expanded) this.#renderChildren(n);
    }
  }

  #row(n: Node): HTMLElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tree-row" + (n.path === this.#activePath ? " active" : "") + (n.dir ? " is-dir" : "");
    row.style.paddingLeft = `${8 + n.depth * 12}px`;

    const caret = document.createElement("span");
    caret.className = "tree-caret";
    // A directory gets the arrow; a file gets the same empty space, so the
    // names line up in the same optical column.
    caret.innerHTML = n.dir ? (n.expanded ? icons.caretDown : icons.caretRight) : "";
    row.append(caret);

    const label = document.createElement("span");
    label.className = "tree-name";
    label.textContent = n.name;
    row.append(label);

    row.addEventListener("click", () => {
      if (n.dir) this.#toggle(n);
      else this.#onOpenFile(n.path);
    });
    return row;
  }
}

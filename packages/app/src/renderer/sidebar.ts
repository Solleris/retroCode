import { FileTree } from "./filetree.ts";
import { icons } from "./icons.ts";

/**
 * The navigator: project picker, open files, file tree, tasks.
 *
 * The tree became a first-class citizen here (and not only an overlay behind
 * ⌘P) because exploring a repo you do not know by heart is navigation, not
 * search — you do not know the name of the file you are looking for.
 */

import { t } from "./i18n.ts";
export interface OpenFile { rel: string; abs: string; dirty: boolean; active: boolean }
export interface RecentProject { path: string; name: string }

export class Sidebar {
  #project: HTMLButtonElement;
  #recents: HTMLElement;
  #open: HTMLElement;
  #openSec: HTMLElement;
  #treeHost: HTMLElement;
  #tasks: HTMLElement;
  tree: FileTree;

  #onPickOpen: (rel: string) => void;
  #onOpenProject: () => void;
  #onSwitchProject: (path: string) => void;
  #recentsShown = false;

  constructor(host: HTMLElement, cb: {
    onPickOpen: (rel: string) => void;
    onOpenFileAbs: (abs: string) => void;
    onOpenProject: () => void;
    onSwitchProject: (path: string) => void;
  }) {
    this.#onPickOpen = cb.onPickOpen;
    this.#onOpenProject = cb.onOpenProject;
    this.#onSwitchProject = cb.onSwitchProject;

    host.innerHTML = `
      <div class="nav-head">
        <button class="nav-proj" type="button">
          <span class="nav-proj-name">—</span><span class="nav-proj-caret">${icons.chevron}</span>
        </button>
        <button class="nav-pin" type="button" title="${t("nav.pin")}">${icons.pin}</button>
        <div class="nav-recents" hidden></div>
      </div>
      <section class="nav-sec nav-open-sec" hidden>
        <h2>${t("nav.open")}</h2><div class="nav-open"></div>
      </section>
      <section class="nav-sec nav-grow">
        <h2>${t("nav.files")}</h2><div class="nav-tree"></div>
      </section>
      <section class="nav-sec">
        <h2>${t("nav.tasks")}</h2><div class="nav-tasks"></div>
      </section>`;

    this.#project = host.querySelector(".nav-proj")!;
    this.#recents = host.querySelector(".nav-recents")!;
    this.#open = host.querySelector(".nav-open")!;
    this.#openSec = host.querySelector(".nav-open-sec")!;
    this.#treeHost = host.querySelector(".nav-tree")!;
    this.#tasks = host.querySelector(".nav-tasks")!;

    this.tree = new FileTree(this.#treeHost, cb.onOpenFileAbs);

    this.#project.addEventListener("click", () => this.#toggleRecents());
    host.querySelector(".nav-pin")!.addEventListener("click", () =>
      window.dispatchEvent(new Event("retro:toggle-pin")));
    // Clicking outside closes the menu — never stuck open.
    document.addEventListener("mousedown", (e) => {
      if (this.#recentsShown && !this.#recents.contains(e.target as Node)
          && !this.#project.contains(e.target as Node)) this.#toggleRecents();
    });

    this.#tasks.replaceChildren(empty(t("nav.none")));
  }

  setProject(name: string): void {
    this.#project.querySelector(".nav-proj-name")!.textContent = name;
  }

  setRecents(list: RecentProject[]): void {
    this.#recents.replaceChildren();

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "nav-recent nav-recent-action";
    openBtn.textContent = t("nav.openOther");
    openBtn.addEventListener("click", () => { this.#toggleRecents(); this.#onOpenProject(); });
    this.#recents.append(openBtn);

    if (list.length) {
      const sep = document.createElement("div");
      sep.className = "nav-recent-sep";
      sep.textContent = t("nav.recents");
      this.#recents.append(sep);
    }
    for (const p of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "nav-recent";
      const n = document.createElement("span");
      n.className = "nav-recent-name";
      n.textContent = p.name;
      const d = document.createElement("span");
      d.className = "nav-recent-path";
      // ~ instead of the full home path: it becomes readable at sidebar width.
      d.textContent = p.path.replace(/^\/Users\/[^/]+/, "~");
      b.append(n, d);
      b.addEventListener("click", () => { this.#toggleRecents(); this.#onSwitchProject(p.path); });
      this.#recents.append(b);
    }
  }

  #toggleRecents(): void {
    this.#recentsShown = !this.#recentsShown;
    this.#recents.hidden = !this.#recentsShown;
    this.#project.classList.toggle("open", this.#recentsShown);
  }

  setOpenFiles(files: OpenFile[]): void {
    this.#openSec.hidden = files.length === 0;
    this.#open.replaceChildren();
    for (const f of files) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "nav-row" + (f.active ? " active" : "");
      const cut = f.rel.lastIndexOf("/");
      const name = document.createElement("span");
      name.className = "nav-name";
      name.textContent = cut >= 0 ? f.rel.slice(cut + 1) : f.rel;
      row.append(name);
      if (cut >= 0) {
        const dir = document.createElement("span");
        dir.className = "nav-meta nav-path";
        dir.textContent = f.rel.slice(0, cut);
        row.append(dir);
      }
      if (f.dirty) {
        const dot = document.createElement("span");
        dot.className = "nav-dirty";
        dot.title = t("nav.unsaved");
        row.append(dot);
      }
      row.addEventListener("click", () => this.#onPickOpen(f.rel));
      this.#open.append(row);
    }
  }
}

function empty(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "nav-empty";
  el.textContent = text;
  return el;
}

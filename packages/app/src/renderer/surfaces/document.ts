import { marked } from "marked";
import DOMPurify from "dompurify";
import { createEditor, type EditorSurface } from "./editor.ts";

/**
 * A document = header + (editor | preview).
 *
 * Editor and preview live in the same surface rather than in separate panes,
 * because toggling is a property OF THE FILE, not of the layout: you want to
 * see the same .md rendered or raw without touching the window's geometry.
 */
import { t } from "../i18n.ts";
export interface DocumentSurface {
  el: HTMLElement;
  path: string;
  setText(text: string, binary: boolean): void;
  focus(): void;
  isDirty(): boolean;
  save(): void;
  toggleView(): void;
  dispose(): void;
}

const isMarkdown = (p: string): boolean => /\.(md|mdx|markdown)$/i.test(p);

marked.setOptions({ gfm: true, breaks: false });

export function createDocument(
  path: string,
  onDirtyChange: () => void,
): DocumentSurface {
  const el = document.createElement("div");
  el.className = "surface surface-doc";

  const name = path.slice(path.lastIndexOf("/") + 1);
  const md = isMarkdown(path);
  let mode: "code" | "preview" = md ? "preview" : "code";
  let raw = "";

  // ── header ───────────────────────────────────────────────────────────
  const head = document.createElement("div");
  head.className = "doc-head";
  const title = document.createElement("span");
  title.className = "doc-name";
  title.textContent = name;
  const dot = document.createElement("span");
  dot.className = "doc-dirty";
  dot.hidden = true;
  head.append(title, dot);

  const spacer = document.createElement("span");
  spacer.className = "doc-spacer";
  head.append(spacer);

  let toggle: HTMLButtonElement | null = null;
  if (md) {
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "doc-toggle";
    head.append(toggle);
  }

  // ── corpo ────────────────────────────────────────────────────────────
  const body = document.createElement("div");
  body.className = "doc-body";

  const editorWrap = document.createElement("div");
  editorWrap.className = "doc-pane";
  const preview = document.createElement("div");
  preview.className = "doc-pane markdown";
  body.append(editorWrap, preview);
  el.append(head, body);

  const editor: EditorSurface = createEditor(path, () => {
    dot.hidden = !editor.isDirty();
    onDirtyChange();
  });
  editorWrap.append(editor.el);
  // The editor returns `.surface`; inside a document it is only the body.
  editor.el.classList.remove("surface", "surface-editor");
  editor.el.classList.add("doc-editor");

  function renderPreview(): void {
    // marked.parse is sync with these options; sanitise anyway, because the
    // content comes from a repository an agent may have written.
    const html = DOMPurify.sanitize(marked.parse(raw) as string);
    preview.innerHTML = html;
  }

  function apply(): void {
    const showPreview = mode === "preview";
    editorWrap.hidden = showPreview;
    preview.hidden = !showPreview;
    if (toggle) toggle.textContent = showPreview ? t("app.code") : "preview";
    if (showPreview) renderPreview();
  }

  toggle?.addEventListener("click", () => { mode = mode === "code" ? "preview" : "code"; apply(); });

  apply();

  return {
    el, path,
    setText(text, binary) {
      raw = text;
      editor.setText(text, binary);
      dot.hidden = true;
      if (mode === "preview") renderPreview();
    },
    focus: () => { if (mode === "code") editor.focus(); },
    isDirty: () => editor.isDirty(),
    save: () => editor.save(),
    toggleView: () => { if (md) { mode = mode === "code" ? "preview" : "code"; apply(); } },
    dispose: () => editor.dispose(),
  };
}

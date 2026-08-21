import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection,
         rectangularSelection, crosshairCursor, highlightSpecialChars } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { indentOnInput, bracketMatching, foldGutter, foldKeymap,
         indentUnit, StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { retroTheme } from "../theme.ts";

declare const retro: { send(req: unknown): void };

import { t } from "../i18n.ts";
export interface EditorSurface {
  el: HTMLElement;
  path: string;
  setText(text: string, binary: boolean): void;
  focus(): void;
  isDirty(): boolean;
  save(): void;
  dispose(): void;
}

/** Detection by extension. Enough; magic-byte sniffing does not pay here. */
function languageFor(path: string): Extension[] {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "ts": case "tsx": return [javascript({ typescript: true, jsx: ext === "tsx" })];
    case "js": case "jsx": case "mjs": case "cjs": return [javascript({ jsx: true })];
    case "py": return [python()];
    case "json": return [json()];
    case "md": case "mdx": return [markdown()];
    case "css": return [css()];
    case "html": case "htm": return [html()];
    case "rs": return [rust()];
    case "go": return [go()];
    default: return [];
  }
}

export function createEditor(path: string, onDirtyChange: (dirty: boolean) => void): EditorSurface {
  const el = document.createElement("div");
  el.className = "surface surface-editor";

  let baseline = "";
  let dirty = false;

  const markDirty = EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    const now = u.state.doc.toString() !== baseline;
    if (now !== dirty) { dirty = now; onDirtyChange(dirty); }
  });

  const save = (): void => {
    const text = view.state.doc.toString();
    retro.send({ t: "writeFile", path, text });
    baseline = text;
    if (dirty) { dirty = false; onDirtyChange(false); }
  };

  const view = new EditorView({
    parent: el,
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(),
        history(), foldGutter(), drawSelection(), indentOnInput(), bracketMatching(),
        rectangularSelection(), crosshairCursor(), highlightSelectionMatches(), search(),
        indentUnit.of("  "),
        keymap.of([
          // ⌘S saves. Without it the editor is a viewer, and the difference
          // between the two was exactly what the window was missing.
          { key: "Mod-s", run: () => { save(); return true; }, preventDefault: true },
          indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap,
        ]),
        ...languageFor(path),
        ...retroTheme(),
        markDirty,
      ],
    }),
  });

  return {
    el, path,
    setText(text, binary) {
      baseline = binary ? "" : text;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: binary ? t("app.binary") : text },
      });
      if (dirty) { dirty = false; onDirtyChange(false); }
    },
    focus: () => view.focus(),
    isDirty: () => dirty,
    save,
    dispose: () => view.destroy(),
  };
}

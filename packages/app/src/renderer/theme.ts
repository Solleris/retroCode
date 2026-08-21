import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/**
 * Editor theme derived from the SAME custom properties as the app.
 *
 * How the tension with "minimal" is resolved: the **chrome** stays
 * monochrome with a single accent; the **code** gets a full palette. Colour
 * in syntax is information — it tells you what a word IS — whereas colour on
 * a button is decoration. They are two different budgets, and treating them
 * as one is what produces either a washed-out editor or a christmas-tree UI.
 */
const v = (name: string, fallback: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export function retroTheme(): Extension[] {
  const ink = v("--ink", "#D7DEE8");
  const dim = v("--ink-dim", "#96A2B0");
  const faint = v("--ink-faint", "#5C6773");
  const bg = v("--surface", "#10151A");
  const rule = v("--rule", "#212932");
  const signal = v("--signal", "#EFA84C");
  const sel = v("--code-sel", "#243040");

  const c = {
    key:   v("--code-key", "#C792EA"),
    ctrl:  v("--code-ctrl", "#F07178"),
    str:   v("--code-str", "#C3E88D"),
    num:   v("--code-num", "#F78C6C"),
    fn:    v("--code-fn", "#82AAFF"),
    type:  v("--code-type", "#FFCB6B"),
    prop:  v("--code-prop", "#89DDFF"),
    op:    v("--code-op", "#89DDFF"),
    punct: v("--code-punct", "#6E7A8A"),
    tag:   v("--code-tag", "#F07178"),
    attr:  v("--code-attr", "#C792EA"),
    bad:   v("--bad", "#E8796D"),
  };

  const chrome = EditorView.theme({
    "&": { backgroundColor: bg, color: ink, fontSize: "12.5px", height: "100%" },
    ".cm-content": {
      fontFamily: '"SF Mono", "IBM Plex Mono", Menlo, monospace',
      lineHeight: "1.6", padding: "8px 0", caretColor: signal,
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: signal, borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: sel,
    },
    ".cm-gutters": {
      backgroundColor: bg, color: faint, border: "none", paddingRight: "10px", minWidth: "48px",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 14px" },
    ".cm-activeLine": { backgroundColor: "#ffffff06" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: dim },
    ".cm-selectionMatch": { backgroundColor: sel },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "transparent", outline: `1px solid ${c.punct}`, color: "inherit",
    },
    ".cm-foldPlaceholder": { backgroundColor: rule, border: "none", color: dim, padding: "0 6px" },
    ".cm-panels": { backgroundColor: bg, color: ink, borderTop: `1px solid ${rule}` },
    ".cm-panels input, .cm-panels button": {
      backgroundColor: "#ffffff0d", color: ink, border: `1px solid ${rule}`,
      borderRadius: "2px", padding: "2px 6px", font: "inherit",
    },
    ".cm-searchMatch": { backgroundColor: "transparent", outline: `1px solid ${signal}` },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#EFA84C33" },
    ".cm-scroller": { overflow: "auto" },
    ".cm-scroller::-webkit-scrollbar": { width: "9px", height: "9px" },
    ".cm-scroller::-webkit-scrollbar-thumb": {
      background: rule, borderRadius: "5px", border: `2px solid ${bg}`,
    },
    ".cm-scroller::-webkit-scrollbar-corner": { background: bg },
  }, { dark: true });

  const highlight = HighlightStyle.define([
    { tag: [t.comment, t.blockComment, t.lineComment, t.docComment], color: faint, fontStyle: "italic" },

    { tag: [t.keyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], color: c.key },
    { tag: [t.controlKeyword], color: c.ctrl },
    { tag: [t.self, t.null, t.bool], color: c.ctrl },

    { tag: [t.string, t.special(t.string), t.docString], color: c.str },
    { tag: [t.regexp], color: c.str, fontWeight: "600" },
    { tag: [t.escape], color: c.num, fontWeight: "600" },

    { tag: [t.number, t.integer, t.float, t.atom, t.unit], color: c.num },
    { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: c.num },

    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: c.fn },
    { tag: [t.typeName, t.className, t.namespace, t.annotation], color: c.type },
    { tag: [t.typeOperator], color: c.type },

    { tag: [t.propertyName], color: c.prop },
    { tag: [t.attributeName], color: c.attr },
    { tag: [t.attributeValue], color: c.str },
    { tag: [t.tagName], color: c.tag },

    { tag: [t.operator, t.compareOperator, t.logicOperator, t.arithmeticOperator], color: c.op },
    { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket], color: c.punct },

    { tag: [t.variableName, t.name, t.labelName], color: ink },
    { tag: [t.definition(t.variableName)], color: ink, fontWeight: "600" },

    // Markdown inside the code editor
    { tag: [t.heading], color: c.fn, fontWeight: "700" },
    { tag: [t.link, t.url], color: c.prop, textDecoration: "underline" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strong], fontWeight: "700", color: ink },
    { tag: [t.monospace], color: c.str },
    { tag: [t.quote], color: dim, fontStyle: "italic" },
    { tag: [t.list], color: c.op },

    { tag: [t.invalid], color: c.bad, textDecoration: "underline wavy" },
    { tag: [t.deleted], color: c.bad },
    { tag: [t.inserted], color: c.str },
    { tag: [t.meta, t.processingInstruction], color: dim },
  ]);

  return [chrome, syntaxHighlighting(highlight)];
}

/**
 * The terminal's full ANSI palette.
 *
 * Only four colours (as it was) leaves `ls`, `git status` and every TUI
 * washed out — a terminal uses all 16 slots. These derive from the same code
 * palette, so the terminal and the editor do not look like two apps.
 */
export function terminalTheme(): Record<string, string> {
  return {
    background: v("--term-bg", "#10151A"),
    foreground: v("--term-fg", "#D7DEE8"),
    cursor: v("--signal", "#EFA84C"),
    cursorAccent: v("--term-bg", "#10151A"),
    selectionBackground: v("--code-sel", "#243040"),
    selectionForeground: v("--ink", "#D7DEE8"),

    black: "#1C2128",         brightBlack: "#5C6773",
    red: v("--code-ctrl", "#F07178"),   brightRed: "#FF8A94",
    green: v("--code-str", "#C3E88D"),  brightGreen: "#D7F5A8",
    yellow: v("--code-type", "#FFCB6B"), brightYellow: "#FFDD94",
    blue: v("--code-fn", "#82AAFF"),    brightBlue: "#A6C4FF",
    magenta: v("--code-key", "#C792EA"), brightMagenta: "#DDB4F5",
    cyan: v("--code-prop", "#89DDFF"),  brightCyan: "#AEEAFF",
    white: "#C5CDD9",         brightWhite: "#F0F4F8",
  };
}

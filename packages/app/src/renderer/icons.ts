/**
 * An icon set, not a collection of found glyphs.
 *
 * What was here before: ⌖ ± ↻ ◫ ▤ — five different Unicode families, with
 * weights, optical sizes and baselines that do not match. `◫` and `▤` (Linear
 * and Notion) were the worst: nobody recognises those squares, and they inherit
 * the mono font's metrics, so they float relative to the text.
 *
 * SVG solves all three at once: one viewBox, one stroke width, controlled
 * alignment — and the colour comes from `currentColor`, so the icon follows the
 * element's state with no extra CSS.
 */

const SVG = (body: string, size = 13): string =>
  `<svg class="ic" viewBox="0 0 16 16" width="${size}" height="${size}" fill="none"
     stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
     aria-hidden="true">${body}</svg>`;

export const icons = {
  /** pin / unpin the tree */
  pin: SVG('<path d="M8 10v4"/><path d="M5 10h6l-1-4 1.5-2h-7L6 6z"/>'),
  /** atualizar */
  refresh: SVG('<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5V5h-2.5"/>'),
  /** diff / comparar */
  diff: SVG('<path d="M4 3v7a2 2 0 0 0 2 2h6"/><path d="M10 10l2 2-2 2"/><path d="M12 13V6a2 2 0 0 0-2-2H4"/><path d="M6 7L4 5l2-2"/>'),
  /** issue tracker (Linear) — a diamond, the shape the product itself uses */
  issue: SVG('<path d="M8 2l6 6-6 6-6-6z"/>'),
  /** documento (Notion) */
  doc: SVG('<path d="M4 2.5h5l3 3V13a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 13z"/><path d="M9 2.5V6h3"/><path d="M6.5 9h3"/><path d="M6.5 11h3"/>'),
  /** ramo do git */
  branch: SVG('<circle cx="5" cy="4" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="11" cy="7" r="1.6"/><path d="M5 5.6v4.8"/><path d="M5 8.5h3.2A2.4 2.4 0 0 0 10.6 8"/>'),
  /** disclosure arrow (tree) — replaces ▸ ▾ */
  caretRight: SVG('<path d="M6.5 4l4 4-4 4"/>', 11),
  caretDown: SVG('<path d="M4 6.5l4 4 4-4"/>', 11),
  /** menu de projeto */
  chevron: SVG('<path d="M4 6.5l4 4 4-4"/>', 11),
} as const;

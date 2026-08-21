/**
 * The pane tree. It lives in the protocol because it is persisted alongside
 * the Task: reopening a Task has to restore the exact geometry, with the ptys
 * still alive in the daemon.
 *
 * Mental model: i3/tmux, not VS Code's fixed layout. Splits are born and die
 * by keyboard shortcut, dozens of times an hour.
 */

export type Axis = "h" | "v";

export type Surface =
  | { s: "terminal"; ptyId: string }
  | { s: "editor"; path: string }
  | { s: "agent"; taskId: string }
  | { s: "diff"; taskId: string }
  | { s: "consensus"; taskId: string }
  /*
   * Settings is a PANE, not a modal. In an app whose whole model is splitting
   * the screen, a modal would be the one thing that steals focus from
   * everything — and you cannot watch the theme change while a window covers
   * the editor.
   */
  | { s: "settings" }
  | { s: "empty" };

export type PaneNode =
  | { n: "leaf"; id: string; surface: Surface }
  | { n: "split"; axis: Axis; ratio: number; a: PaneNode; b: PaneNode };

export function leaf(id: string, surface: Surface): PaneNode {
  return { n: "leaf", id, surface };
}

/** Finds the path to a leaf, as a sequence of "a"|"b". */
export function pathTo(root: PaneNode, id: string): ("a" | "b")[] | null {
  if (root.n === "leaf") return root.id === id ? [] : null;
  const left = pathTo(root.a, id);
  if (left) return ["a", ...left];
  const right = pathTo(root.b, id);
  if (right) return ["b", ...right];
  return null;
}

/** Replaces leaf `id` with node `replacement`. Returns a new tree. */
export function replaceLeaf(root: PaneNode, id: string, replacement: PaneNode): PaneNode {
  if (root.n === "leaf") return root.id === id ? replacement : root;
  return { ...root, a: replaceLeaf(root.a, id, replacement), b: replaceLeaf(root.b, id, replacement) };
}

/** Splits leaf `id`, putting `surface` on the new side. */
export function splitLeaf(
  root: PaneNode, id: string, axis: Axis, newId: string, surface: Surface,
): PaneNode {
  const target = findLeaf(root, id);
  if (!target) return root;
  return replaceLeaf(root, id, {
    n: "split", axis, ratio: 0.5, a: target, b: leaf(newId, surface),
  });
}

/**
 * Removes leaf `id`, promoting its sibling into the split's place — which is
 * the behaviour that makes closing a pane feel right. Returns null if `id`
 * was the last leaf (the caller decides: close the window, or an empty pane).
 */
export function closeLeaf(root: PaneNode, id: string): PaneNode | null {
  if (root.n === "leaf") return root.id === id ? null : root;
  const a = closeLeaf(root.a, id);
  const b = closeLeaf(root.b, id);
  if (a === null) return b;
  if (b === null) return a;
  return { ...root, a, b };
}

export function findLeaf(root: PaneNode, id: string): Extract<PaneNode, { n: "leaf" }> | null {
  if (root.n === "leaf") return root.id === id ? root : null;
  return findLeaf(root.a, id) ?? findLeaf(root.b, id);
}

export function leaves(root: PaneNode): Extract<PaneNode, { n: "leaf" }>[] {
  return root.n === "leaf" ? [root] : [...leaves(root.a), ...leaves(root.b)];
}

/**
 * Validates a tree that came from outside (localStorage, a file, the socket).
 *
 * Persisted state is untrusted input like any other: an older version of the
 * app may have written a shape that no longer exists, and truncated JSON is
 * indistinguishable from valid JSON until you reach for `.surface`. Without
 * this, a corrupted saved layout leaves the window blank at startup — the
 * worst possible place for an error, because there is no UI yet to report it.
 *
 * `allowed` lets the caller refuse surfaces that make no sense to resurrect
 * (an agent run that already finished, for example).
 */
export function isPaneNode(v: unknown, allowed?: ReadonlySet<Surface["s"]>): v is PaneNode {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  if (n["n"] === "leaf") {
    if (typeof n["id"] !== "string" || !n["id"]) return false;
    const sf = n["surface"] as Record<string, unknown> | undefined;
    if (!sf || typeof sf["s"] !== "string") return false;
    if (allowed && !allowed.has(sf["s"] as Surface["s"])) return false;
    return true;
  }
  if (n["n"] === "split") {
    if (n["axis"] !== "h" && n["axis"] !== "v") return false;
    if (typeof n["ratio"] !== "number" || !(n["ratio"] > 0 && n["ratio"] < 1)) return false;
    return isPaneNode(n["a"], allowed) && isPaneNode(n["b"], allowed);
  }
  return false;
}

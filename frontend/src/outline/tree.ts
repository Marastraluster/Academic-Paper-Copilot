import type { QaSection } from "@/stores/workspace";

type OutlineNode = QaSection;

/**
 * Turning the flat outline into a tree, without inventing structure.
 *
 * The backend returns sections in **canonical reading order** and states each
 * node's `parent_id`. This builds the nesting from that statement and makes no
 * decisions of its own about hierarchy — a second opinion here would be a second
 * answer to a settled question, which is the mistake `api/documents.ts` already
 * names.
 *
 * The one thing it does decide is **display order among siblings**, because
 * reading order and display order are not always the same thing. Measured on
 * Diffusion Policy: the heading for `C.2` is printed before the heading for `C`
 * itself, so in reading order a child precedes its parent. Nesting `C.2` under
 * `C` is right; rendering `C.2` before `C.1` is not. Where siblings both carry a
 * number, the number decides — the same principle that decides parentage on the
 * backend. Where they do not, reading order stands.
 */
export interface OutlineTree {
  /** Roots in display order. */
  roots: OutlineNode[];
  /** `section_id` -> its children, in display order. */
  childrenOf: Map<string, OutlineNode[]>;
  /** `section_id` -> the node. */
  byId: Map<string, OutlineNode>;
}

/** The dotted number a heading starts with, if any: `3.2`, `A.1`, `C`. */
function headingNumber(title: string): string | null {
  const match = /^(?:appendix\s+)?([A-Z]|\d+)(?:\.(?:[A-Z]|\d+)){0,3}\.?\s/i.exec(
    title.trim(),
  );
  return match ? match[0].trim() : null;
}

/** Compare two section numbers the way a table of contents orders them. */
function compareNumbers(left: string, right: string): number {
  const parts = (value: string) =>
    value.replace(/\.$/, "").split(".").map((part) => part.trim().toUpperCase());
  const a = parts(left);
  const b = parts(right);
  for (let at = 0; at < Math.max(a.length, b.length); at += 1) {
    const x = a[at];
    const y = b[at];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    // Numbers before letters, then numeric order, then lexical.
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function buildOutlineTree(nodes: OutlineNode[]): OutlineTree {
  const byId = new Map<string, OutlineNode>();
  for (const node of nodes) byId.set(node.id, node);

  const childrenOf = new Map<string, OutlineNode[]>();
  const roots: OutlineNode[] = [];

  for (const node of nodes) {
    // A parent that is not in the list — a dropped heading — would otherwise
    // make the node unreachable. It becomes a root instead, which is the same
    // choice the backend makes when it cannot resolve a parent.
    const parentId = node.parentId !== null && byId.has(node.parentId)
      ? node.parentId
      : null;
    if (parentId === null) {
      roots.push(node);
      continue;
    }
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(node);
    else childrenOf.set(parentId, [node]);
  }

  const order = (group: OutlineNode[]) => {
    // Reading order is the tie-breaker, so a stable sort over the input order
    // keeps unnumbered siblings exactly where the document put them.
    group.sort((a, b) => {
      const left = headingNumber(a.title);
      const right = headingNumber(b.title);
      if (left !== null && right !== null) {
        const compared = compareNumbers(left, right);
        if (compared !== 0) return compared;
      }
      return nodes.indexOf(a) - nodes.indexOf(b);
    });
    return group;
  };

  order(roots);
  for (const [id, group] of childrenOf) childrenOf.set(id, order(group));

  return { roots, childrenOf, byId };
}

/** Every ancestor of `id`, nearest first — used to reveal the active node. */
export function ancestorsOf(tree: OutlineTree, id: string): string[] {
  const chain: string[] = [];
  let current = tree.byId.get(id)?.parentId ?? null;
  const guard = new Set<string>();
  while (current !== null && !guard.has(current)) {
    guard.add(current);
    chain.push(current);
    current = tree.byId.get(current)?.parentId ?? null;
  }
  return chain;
}

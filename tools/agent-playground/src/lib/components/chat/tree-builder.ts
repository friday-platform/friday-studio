/**
 * Pure tree builder that converts a flat `Map` of `ToolCallDisplay` entries
 * (each carrying an optional `parentToolCallId`) into a forest of trees.
 *
 * Replaces the previous string-splitting approach (`buildNestedChildren` in
 * `extract-tool-calls.ts`) with explicit parent pointers. Parentage is now
 * unambiguous regardless of `toolCallId` formatting.
 *
 * @module
 */

import type { ToolCallDisplay } from "./types.ts";

/**
 * Build a forest of `ToolCallDisplay` trees from a flat map.
 *
 * - Entries with a missing or unmatched `parentToolCallId` become roots.
 * - Circular parent pointers are broken at first re-visit (the cycle node
 *   is returned without children so the tree stays finite).
 * - Map insertion order is preserved for both roots and sibling lists.
 */
export function buildToolCallTree(
  flat: Map<string, ToolCallDisplay & { parentToolCallId?: string }>,
): ToolCallDisplay[] {
  if (flat.size === 0) return [];

  // Index children by parentToolCallId, preserving insertion order.
  const childrenByParent = new Map<string, (ToolCallDisplay & { parentToolCallId?: string })[]>();
  for (const entry of flat.values()) {
    const parentId = entry.parentToolCallId;
    if (!parentId) continue;
    const list = childrenByParent.get(parentId);
    if (list) {
      list.push(entry);
    } else {
      childrenByParent.set(parentId, [entry]);
    }
  }

  // Identify roots by following parent chains. Nodes whose chain leads to a
  // missing parent are under a valid root. Nodes whose chain leads to a cycle
  // have the lexicographically-smallest node in the cycle promoted to root.
  const visited = new Set<string>();
  const roots: (ToolCallDisplay & { parentToolCallId?: string })[] = [];

  for (const entry of flat.values()) {
    if (visited.has(entry.toolCallId)) continue;

    const path: (ToolCallDisplay & { parentToolCallId?: string })[] = [];
    const pathIds = new Set<string>();
    let current: (ToolCallDisplay & { parentToolCallId?: string }) | undefined = entry;

    while (current) {
      if (visited.has(current.toolCallId)) {
        for (const e of path) visited.add(e.toolCallId);
        break;
      }

      if (pathIds.has(current.toolCallId)) {
        const cycleStart = path.findIndex((e) => e.toolCallId === current!.toolCallId);
        const cycle = path.slice(cycleStart);
        const promoted = cycle.reduce((a, b) => (a.toolCallId < b.toolCallId ? a : b));
        if (!roots.includes(promoted)) {
          roots.push(promoted);
        }
        for (const e of path) visited.add(e.toolCallId);
        break;
      }

      path.push(current);
      pathIds.add(current.toolCallId);

      const parentId = current.parentToolCallId;
      if (!parentId || !flat.has(parentId)) {
        const root = current;
        if (!roots.includes(root)) {
          roots.push(root);
        }
        for (const e of path) visited.add(e.toolCallId);
        break;
      }

      current = flat.get(parentId);
    }
  }

  // Recursive builder — breaks cycles by skipping children already seen on the
  // current path.
  function build(
    node: ToolCallDisplay & { parentToolCallId?: string },
    seenInPath: Set<string>,
  ): ToolCallDisplay {
    const id = node.toolCallId;
    const childEntries = childrenByParent.get(id) ?? [];

    // Strip the transient parentToolCallId before returning.
    const { parentToolCallId: _drop, ...rest } = node;

    if (childEntries.length === 0 || seenInPath.has(id)) {
      return rest;
    }

    const nextSeen = new Set(seenInPath);
    nextSeen.add(id);

    const children = childEntries
      .filter((child) => !nextSeen.has(child.toolCallId))
      .map((child) => build(child, nextSeen));

    return children.length > 0 ? { ...rest, children } : rest;
  }

  return roots.map((root) => build(root, new Set()));
}

import { describe, expect, it } from "vitest";
import type { ToolCallDisplay } from "./types.ts";
import { buildToolCallTree } from "./tree-builder.ts";

function makeEntry(
  toolCallId: string,
  parentToolCallId?: string,
  overrides: Partial<ToolCallDisplay> = {},
): ToolCallDisplay & { parentToolCallId?: string } {
  return {
    toolCallId,
    toolName: "delegate",
    state: "input-available",
    ...overrides,
    parentToolCallId,
  };
}

describe("buildToolCallTree", () => {
  it("returns an empty array for an empty map", () => {
    expect(buildToolCallTree(new Map())).toEqual([]);
  });

  it("single parent with multiple children", () => {
    const flat = new Map([
      ["d1", makeEntry("d1")],
      ["d1-c1", makeEntry("d1-c1", "d1", { toolName: "web_fetch" })],
      ["d1-c2", makeEntry("d1-c2", "d1", { toolName: "run_code" })],
    ]);

    const result = buildToolCallTree(flat);
    expect(result).toHaveLength(1);

    const [root] = result;
    expect(root?.toolCallId).toBe("d1");
    expect(root?.children).toHaveLength(2);

    const [c1, c2] = root?.children ?? [];
    expect(c1?.toolCallId).toBe("d1-c1");
    expect(c1?.toolName).toBe("web_fetch");
    expect(c2?.toolCallId).toBe("d1-c2");
    expect(c2?.toolName).toBe("run_code");
  });

  it("three-deep nesting", () => {
    const flat = new Map([
      ["d1", makeEntry("d1")],
      ["d1-aw1", makeEntry("d1-aw1", "d1", { toolName: "agent_web" })],
      ["d1-aw1-f1", makeEntry("d1-aw1-f1", "d1-aw1", { toolName: "fetch" })],
    ]);

    const result = buildToolCallTree(flat);
    expect(result).toHaveLength(1);

    const [root] = result;
    expect(root?.toolCallId).toBe("d1");
    expect(root?.children).toHaveLength(1);

    const [aw1] = root?.children ?? [];
    expect(aw1?.toolCallId).toBe("d1-aw1");
    expect(aw1?.toolName).toBe("agent_web");
    expect(aw1?.children).toHaveLength(1);

    const [f1] = aw1?.children ?? [];
    expect(f1?.toolCallId).toBe("d1-aw1-f1");
    expect(f1?.toolName).toBe("fetch");
    expect(f1?.children).toBeUndefined();
  });

  it("orphaned children promoted to root", () => {
    const flat = new Map([
      ["d1", makeEntry("d1")],
      ["orphan-c1", makeEntry("orphan-c1", "missing-parent", { toolName: "web_fetch" })],
    ]);

    const result = buildToolCallTree(flat);
    expect(result).toHaveLength(2);

    const ids = result.map((r) => r.toolCallId);
    expect(ids).toContain("d1");
    expect(ids).toContain("orphan-c1");

    const orphan = result.find((r) => r.toolCallId === "orphan-c1");
    expect(orphan).toBeDefined();
    expect(orphan?.toolName).toBe("web_fetch");
    // parentToolCallId is stripped from the output shape.
    expect("parentToolCallId" in orphan!).toBe(false);
  });

  it("circular parent pointers — break at first re-visit", () => {
    const flat = new Map([
      ["a", makeEntry("a", "b")],
      ["b", makeEntry("b", "a")],
    ]);

    const result = buildToolCallTree(flat);
    expect(result).toHaveLength(1);

    const [root] = result;
    // Lexicographically smallest node in the cycle is promoted to root.
    expect(root?.toolCallId).toBe("a");
    expect(root?.children).toHaveLength(1);

    const [child] = root?.children ?? [];
    expect(child?.toolCallId).toBe("b");
    // Cycle is broken: b would recurse back to a, but a is already on the
    // path, so b is returned without children.
    expect(child?.children).toBeUndefined();
  });

  it("circular parent pointers with chain — break at first re-visit", () => {
    const flat = new Map([
      ["a", makeEntry("a", "b")],
      ["b", makeEntry("b", "c")],
      ["c", makeEntry("c", "b")],
    ]);

    const result = buildToolCallTree(flat);
    expect(result).toHaveLength(1);

    const [root] = result;
    expect(root?.toolCallId).toBe("b");
    expect(root?.children).toHaveLength(2);

    const childIds = (root?.children ?? []).map((c) => c.toolCallId);
    expect(childIds).toContain("a");
    expect(childIds).toContain("c");

    const cChild = root?.children?.find((c) => c.toolCallId === "c");
    expect(cChild?.children).toBeUndefined();
  });

  it("preserves map insertion order for roots and siblings", () => {
    const flat = new Map([
      ["z", makeEntry("z")],
      ["a", makeEntry("a")],
      ["a-c1", makeEntry("a-c1", "a")],
      ["z-c1", makeEntry("z-c1", "z")],
    ]);

    const result = buildToolCallTree(flat);
    expect(result.map((r) => r.toolCallId)).toEqual(["z", "a"]);
    expect(result[0]?.children?.[0]?.toolCallId).toBe("z-c1");
    expect(result[1]?.children?.[0]?.toolCallId).toBe("a-c1");
  });

  it("promotes a node with missing parent to root even when it has children", () => {
    const flat = new Map([
      ["orphan", makeEntry("orphan", "nonexistent")],
      ["child-of-orphan", makeEntry("child-of-orphan", "orphan")],
    ]);

    const result = buildToolCallTree(flat);
    expect(result).toHaveLength(1);

    const [root] = result;
    expect(root?.toolCallId).toBe("orphan");
    expect(root?.children).toHaveLength(1);

    const [child] = root?.children ?? [];
    expect(child?.toolCallId).toBe("child-of-orphan");
  });
});

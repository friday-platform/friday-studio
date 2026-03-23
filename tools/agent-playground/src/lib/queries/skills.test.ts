import { describe, expect, test, vi } from "vitest";

vi.mock("@tanstack/svelte-query", () => ({ createQuery: vi.fn() }));
vi.mock("../daemon-client.ts", () => ({ getDaemonClient: vi.fn() }));

const { deriveWorkspaceSkills } = await import("./skills.ts");

describe("deriveWorkspaceSkills", () => {
  test("separates global refs from inline skills", () => {
    const result = deriveWorkspaceSkills([
      { name: "@atlas/pr-review", version: 2 },
      { name: "my-inline", inline: true, description: "Inline desc", instructions: "Do stuff" },
      { name: "@friday/code-gen" },
    ]);

    expect(result.globalRefs).toEqual([
      { ref: "@atlas/pr-review", namespace: "atlas", name: "pr-review", version: 2 },
      { ref: "@friday/code-gen", namespace: "friday", name: "code-gen", version: undefined },
    ]);
    expect(result.inlineSkills).toEqual([
      { name: "my-inline", description: "Inline desc", instructions: "Do stuff" },
    ]);
  });

  test("returns empty arrays for undefined input", () => {
    const result = deriveWorkspaceSkills(undefined);

    expect(result.globalRefs).toHaveLength(0);
    expect(result.inlineSkills).toHaveLength(0);
  });

  test("returns empty arrays for empty input", () => {
    const result = deriveWorkspaceSkills([]);

    expect(result.globalRefs).toHaveLength(0);
    expect(result.inlineSkills).toHaveLength(0);
  });
});

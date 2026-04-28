import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const SKILL_PATH = fileURLToPath(new URL("./SKILL.md", import.meta.url));

describe("workspace-api SKILL.md content", () => {
  let content = "";

  beforeAll(async () => {
    content = await readFile(SKILL_PATH, "utf8");
  });

  it("does not contain the deprecated 'two agent types' claim", () => {
    expect(content).not.toContain("two agent types");
  });

  it("mentions 'type: atlas' at least three times (cheat sheet, recipe, gotchas)", () => {
    const matches = content.match(/type: atlas/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("references the new 'list_capabilities' discovery tool", () => {
    expect(content).toContain("list_capabilities");
  });

  it("does not reference the removed 'list_mcp_servers' tool", () => {
    expect(content).not.toContain("list_mcp_servers");
  });
});

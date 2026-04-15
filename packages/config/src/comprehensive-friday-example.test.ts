import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "@std/yaml";
import { describe, expect, it } from "vitest";
import { AtlasConfigSchema } from "./workspace.ts";

const EXAMPLE_PATH = fileURLToPath(
  new URL("../../../docs/COMPREHENSIVE_FRIDAY_EXAMPLE.yml", import.meta.url),
);

describe("docs/COMPREHENSIVE_FRIDAY_EXAMPLE.yml", () => {
  it("parses as yaml and validates against AtlasConfigSchema", () => {
    const raw = readFileSync(EXAMPLE_PATH, "utf-8");
    const parsed = AtlasConfigSchema.parse(parseYaml(raw));
    expect(parsed.version).toBe("1.0");
    expect(parsed.workspace.name).toBe("comprehensive-example");
  });

  it("demonstrates all four platform model archetypes", () => {
    const raw = readFileSync(EXAMPLE_PATH, "utf-8");
    const parsed = AtlasConfigSchema.parse(parseYaml(raw));
    expect(parsed.models).toBeDefined();
    expect(parsed.models?.labels).toBeDefined();
    expect(parsed.models?.classifier).toBeDefined();
    expect(parsed.models?.planner).toBeDefined();
    expect(parsed.models?.conversational).toBeDefined();
  });
});

import { readFile } from "node:fs/promises";
import { parse } from "@std/yaml";
import { describe, expect, it } from "vitest";
import { validateWorkspace } from "./validate-workspace.ts";

describe("validateWorkspace structural layer", () => {
  it("returns ok for a minimal valid config", () => {
    const result = validateWorkspace({ version: "1.0", workspace: { name: "Test Workspace" } });
    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("returns error for missing required field", () => {
    const result = validateWorkspace({ workspace: { name: "Test Workspace" } });
    expect(result.status).toBe("error");
    expect(result.errors.length).toBeGreaterThan(0);
    const missingVersion = result.errors.find((e) => e.path === "version");
    expect(missingVersion).toBeDefined();
    expect(missingVersion?.code).toBe("invalid_value");
    expect(missingVersion?.message).toMatch(/expected "1\.0"/i);
  });

  it("returns error for wrong type", () => {
    const result = validateWorkspace({ version: 1.0, workspace: { name: "Test Workspace" } });
    expect(result.status).toBe("error");
    expect(result.errors.length).toBeGreaterThan(0);
    const wrongType = result.errors.find((e) => e.path === "version");
    expect(wrongType).toBeDefined();
    expect(wrongType?.code).toBe("invalid_value");
  });

  it("returns error for invalid enum value", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test Workspace" },
      improvement: "bananas",
    });
    expect(result.status).toBe("error");
    expect(result.errors.length).toBe(1);
    const enumError = result.errors[0];
    expect(enumError).toBeDefined();
    expect(enumError!.path).toBe("improvement");
    expect(enumError!.code).toBe("invalid_value");
    expect(enumError!.message).toMatch(/surface/i);
  });

  it("returns error for unknown extra key", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test Workspace" },
      unknown_extra_key: "hello",
    });
    expect(result.status).toBe("error");
    expect(result.errors.length).toBe(1);
    const unknownKey = result.errors[0];
    expect(unknownKey).toBeDefined();
    expect(unknownKey!.path).toBe("");
    expect(unknownKey!.code).toBe("unrecognized_keys");
    expect(unknownKey!.message).toMatch(/unknown_extra_key/i);
  });

  it("produces distinct Issue objects for multiple Zod issues", () => {
    const result = validateWorkspace({
      version: 2.0,
      workspace: { name: "Test" },
      improvement: "bananas",
      bad_key: "value",
    });
    expect(result.status).toBe("error");
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    // Each issue should have a unique combination of path + code + message
    const signatures = result.errors.map((e) => `${e.path}|${e.code}|${e.message}`);
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("produces dot-notation path for nested issues", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test" },
      signals: { "my-signal": { provider: "http", description: "Test", config: { path: 123 } } },
    });
    expect(result.status).toBe("error");
    const pathError = result.errors.find((e) => e.path.includes("path"));
    expect(pathError).toBeDefined();
    expect(pathError?.path).toMatch(/^signals\.my-signal\.config\.path$/);
  });

  it("produces warnings array empty for structural-only validation", () => {
    const result = validateWorkspace({ version: "1.0", workspace: { name: "Test" } });
    expect(result.warnings).toEqual([]);
  });

  it("validates Ken's Inbox-Zero workspace as clean", async () => {
    const yaml = await readFile("/Users/ericskram/Desktop/Inbox-Zero/workspace.yml", "utf-8");
    const parsed: unknown = parse(yaml);
    const result = validateWorkspace(parsed);
    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

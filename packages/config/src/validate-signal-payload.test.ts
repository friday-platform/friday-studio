import { describe, expect, it } from "vitest";
import { validateSignalPayload } from "../mod.ts";
import type { WorkspaceSignalConfig } from "./signals.ts";

describe("validateSignalPayload", () => {
  const baseSignal: WorkspaceSignalConfig = {
    provider: "http",
    description: "test signal",
    config: { path: "/test" },
  };

  it("passes when signal has no schema", () => {
    const result = validateSignalPayload(baseSignal, { anything: "goes" });
    expect(result).toMatchObject({ success: true, data: { anything: "goes" } });
  });

  it("passes when payload matches schema", () => {
    const signal: WorkspaceSignalConfig = {
      ...baseSignal,
      schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    };
    const result = validateSignalPayload(signal, { name: "test" });
    expect(result).toMatchObject({ success: true });
  });

  it("fails when required field is missing", () => {
    const signal: WorkspaceSignalConfig = {
      ...baseSignal,
      schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    };
    const result = validateSignalPayload(signal, {});
    expect(result.success).toBe(false);
  });

  it("fails when field has wrong type", () => {
    const signal: WorkspaceSignalConfig = {
      ...baseSignal,
      schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
    };
    const result = validateSignalPayload(signal, { count: "not-a-number" });
    expect(result.success).toBe(false);
  });

  it("returns error message on failure", () => {
    const signal: WorkspaceSignalConfig = {
      ...baseSignal,
      schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    };
    const result = validateSignalPayload(signal, {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeTruthy();
    }
  });
});

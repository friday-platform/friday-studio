import { describe, expect, it } from "vitest";
import { PermissionsConfigSchema, WorkspaceConfigSchema } from "./workspace.ts";

describe("PermissionsConfigSchema", () => {
  it("accepts an empty object", () => {
    const parsed = PermissionsConfigSchema.parse({});
    expect(parsed).toEqual({});
  });

  it("accepts dangerouslySkipAllowlist: true", () => {
    const parsed = PermissionsConfigSchema.parse({ dangerouslySkipAllowlist: true });
    expect(parsed.dangerouslySkipAllowlist).toBe(true);
  });

  it("accepts dangerouslySkipAllowlist: false", () => {
    const parsed = PermissionsConfigSchema.parse({ dangerouslySkipAllowlist: false });
    expect(parsed.dangerouslySkipAllowlist).toBe(false);
  });

  it("rejects unknown fields (strict object)", () => {
    expect(() =>
      PermissionsConfigSchema.parse({ dangerouslySkipAllowlist: true, unknownField: "x" }),
    ).toThrow();
  });

  it("rejects non-boolean dangerouslySkipAllowlist", () => {
    expect(() => PermissionsConfigSchema.parse({ dangerouslySkipAllowlist: "yes" })).toThrow();
  });
});

describe("WorkspaceConfigSchema with permissions block", () => {
  const minimalWorkspace = {
    version: "1.0" as const,
    workspace: { name: "test", id: "test", description: "test workspace" },
  };

  it("accepts a workspace without a permissions block (back-compat)", () => {
    const parsed = WorkspaceConfigSchema.parse(minimalWorkspace);
    expect(parsed.permissions).toBeUndefined();
  });

  it("accepts a workspace with permissions.dangerouslySkipAllowlist: true", () => {
    const parsed = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      permissions: { dangerouslySkipAllowlist: true },
    });
    expect(parsed.permissions?.dangerouslySkipAllowlist).toBe(true);
  });

  it("rejects an unknown key inside permissions", () => {
    expect(() =>
      WorkspaceConfigSchema.parse({ ...minimalWorkspace, permissions: { unknownField: 1 } }),
    ).toThrow();
  });
});

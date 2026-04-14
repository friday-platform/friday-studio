/**
 * Tests for workspace route Zod schemas — updateWorkspaceConfigSchema force field.
 */

import { describe, expect, it } from "vitest";
import { updateWorkspaceConfigSchema } from "./schemas.ts";

describe("updateWorkspaceConfigSchema — force field", () => {
  const validBase = { config: { version: "1.0", workspace: { name: "test" } } };

  it("accepts force: true", () => {
    const result = updateWorkspaceConfigSchema.safeParse({ ...validBase, force: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.force).toBe(true);
    }
  });

  it("accepts force: false", () => {
    const result = updateWorkspaceConfigSchema.safeParse({ ...validBase, force: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.force).toBe(false);
    }
  });

  it("accepts omitted force (optional)", () => {
    const result = updateWorkspaceConfigSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.force).toBeUndefined();
    }
  });

  it("rejects non-boolean force values", () => {
    const result = updateWorkspaceConfigSchema.safeParse({ ...validBase, force: "true" });
    expect(result.success).toBe(false);
  });

  it("rejects force as number", () => {
    const result = updateWorkspaceConfigSchema.safeParse({ ...validBase, force: 1 });
    expect(result.success).toBe(false);
  });
});

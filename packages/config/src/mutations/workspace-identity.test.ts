/**
 * Tests for the workspace identity mutation.
 */

import { describe, expect, test } from "vitest";
import { createTestConfig, expectError } from "./test-fixtures.ts";
import { updateWorkspaceIdentity, WorkspaceIdentityPatchSchema } from "./workspace-identity.ts";

describe("updateWorkspaceIdentity", () => {
  test("updates name and leaves other identity fields untouched", () => {
    const config = createTestConfig({
      workspace: { id: "ws-1", name: "Old Name", version: "2.0", description: "keep me" },
    });

    const result = updateWorkspaceIdentity(config, { name: "New Name" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.workspace.name).toBe("New Name");
      expect(result.value.workspace.id).toBe("ws-1");
      expect(result.value.workspace.version).toBe("2.0");
      expect(result.value.workspace.description).toBe("keep me");
    }
  });

  test("updates description and timeout together", () => {
    const config = createTestConfig({ workspace: { id: "ws-1", name: "Test Workspace" } });

    const result = updateWorkspaceIdentity(config, {
      description: "now described",
      timeout: { progressTimeout: "5m", maxTotalTimeout: "1h" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.workspace.description).toBe("now described");
      expect(result.value.workspace.timeout).toEqual({
        progressTimeout: "5m",
        maxTotalTimeout: "1h",
      });
    }
  });

  test("does not mutate the input config", () => {
    const config = createTestConfig({ workspace: { id: "ws-1", name: "Original" } });

    updateWorkspaceIdentity(config, { name: "Changed" });

    expect(config.workspace.name).toBe("Original");
  });

  test("rejects an empty name", () => {
    const config = createTestConfig();

    const result = updateWorkspaceIdentity(config, { name: "" });

    // Empty string fails the schema-level patch validation when routed
    // through the patch schema; the mutation's own re-validation also
    // catches it defensively.
    expectError(result, "validation");
  });
});

describe("WorkspaceIdentityPatchSchema", () => {
  test("rejects an empty patch", () => {
    const result = WorkspaceIdentityPatchSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects unknown fields", () => {
    const result = WorkspaceIdentityPatchSchema.safeParse({ id: "ws-2" });
    expect(result.success).toBe(false);
  });

  test("accepts a single-field patch", () => {
    const result = WorkspaceIdentityPatchSchema.safeParse({ description: "hi" });
    expect(result.success).toBe(true);
  });
});

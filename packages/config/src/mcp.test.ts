/**
 * Schema tests for the workspace MCP server config.
 *
 * Covers the per-MCP `validation:` override that lets workspace authors mark a
 * server as fully read-only or mutating. The validate-classifier uses this to
 * short-circuit the default regex / allowlist matching.
 */
import { describe, expect, it } from "vitest";
import { WorkspaceConfigSchema } from "./workspace.ts";

describe("per-MCP validation override (workspace.yml)", () => {
  it("accepts validation: 'read-only' on a server config", () => {
    const result = WorkspaceConfigSchema.safeParse({
      version: "1.0",
      workspace: { name: "Test" },
      tools: {
        mcp: {
          servers: {
            "graph-db": {
              transport: { type: "http", url: "http://localhost:8003/mcp" },
              validation: "read-only",
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools?.mcp?.servers?.["graph-db"]?.validation).toBe("read-only");
    }
  });

  it("accepts validation: 'mutating' on a server config", () => {
    const result = WorkspaceConfigSchema.safeParse({
      version: "1.0",
      workspace: { name: "Test" },
      tools: {
        mcp: {
          servers: {
            "approval-bot": {
              transport: { type: "stdio", command: "approval-mcp" },
              validation: "mutating",
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools?.mcp?.servers?.["approval-bot"]?.validation).toBe("mutating");
    }
  });

  it("validation field is optional (omitted servers parse cleanly)", () => {
    const result = WorkspaceConfigSchema.safeParse({
      version: "1.0",
      workspace: { name: "Test" },
      tools: {
        mcp: {
          servers: {
            "google-gmail": { transport: { type: "http", url: "http://localhost:8002/mcp" } },
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools?.mcp?.servers?.["google-gmail"]?.validation).toBeUndefined();
    }
  });

  it("rejects validation values outside the enum", () => {
    const result = WorkspaceConfigSchema.safeParse({
      version: "1.0",
      workspace: { name: "Test" },
      tools: {
        mcp: {
          servers: {
            "graph-db": {
              transport: { type: "http", url: "http://localhost:8003/mcp" },
              validation: "sometimes-mutating",
            },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

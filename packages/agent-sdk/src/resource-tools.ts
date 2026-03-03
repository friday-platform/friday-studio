import { stringifyError } from "@atlas/utils";
import { jsonSchema, tool } from "ai";
import type { ResourceToolkit } from "./resource-toolkit.ts";

/** Creates a resource_read tool. SELECT queries against a resource's draft via the Ledger. */
export function createResourceReadTool(toolkit: ResourceToolkit, workspaceId: string) {
  return tool({
    description:
      "Read from a workspace resource. SELECT queries only. Returns rows as JSON. " +
      "SQL runs against a CTE called `draft` — see resource skill for patterns.",
    inputSchema: jsonSchema<{ slug: string; sql: string; params?: unknown[] }>({
      type: "object",
      properties: {
        slug: { type: "string", description: "Resource slug to query" },
        sql: { type: "string", description: "SQL SELECT query to execute against the draft CTE" },
        params: {
          type: "array",
          items: {},
          description: "Bind parameters for the query (optional)",
        },
      },
      required: ["slug", "sql"],
    }),
    execute: async ({ slug, sql, params }) => {
      try {
        return await toolkit.query(workspaceId, slug, sql, params);
      } catch (err) {
        return { error: stringifyError(err) };
      }
    },
  });
}

/** Creates a resource_write tool. Agent's SELECT computes new data; Ledger applies it to the draft. */
export function createResourceWriteTool(toolkit: ResourceToolkit, workspaceId: string) {
  return tool({
    description:
      "Write to a workspace resource. Your SELECT query computes the new value for the draft — " +
      "the system applies it. See resource skill for mutation patterns.",
    inputSchema: jsonSchema<{ slug: string; sql: string; params?: unknown[] }>({
      type: "object",
      properties: {
        slug: { type: "string", description: "Resource slug to mutate" },
        sql: {
          type: "string",
          description: "SQL SELECT that returns the new data value for the draft",
        },
        params: {
          type: "array",
          items: {},
          description: "Bind parameters for the statement (optional)",
        },
      },
      required: ["slug", "sql"],
    }),
    execute: async ({ slug, sql, params }) => {
      try {
        return await toolkit.mutate(workspaceId, slug, sql, params);
      } catch (err) {
        return { error: stringifyError(err) };
      }
    },
  });
}

/** Creates a resource_save tool. Publishes current draft as a new immutable version. */
export function createResourceSaveTool(toolkit: ResourceToolkit, workspaceId: string) {
  return tool({
    description:
      "Publish the current draft as a new immutable version. No-op if nothing changed. " +
      "The system auto-publishes at end of turn — only call for mid-turn checkpoints.",
    inputSchema: jsonSchema<{ slug: string }>({
      type: "object",
      properties: { slug: { type: "string", description: "Resource slug to publish" } },
      required: ["slug"],
    }),
    execute: async ({ slug }) => {
      try {
        return await toolkit.publish(workspaceId, slug);
      } catch (err) {
        return { error: stringifyError(err) };
      }
    },
  });
}

/** Creates a resource_link_ref tool. Sets external reference URL/ID after agent creates the resource. */
export function createResourceLinkRefTool(toolkit: ResourceToolkit, workspaceId: string) {
  return tool({
    description:
      "Register an external ref for an unregistered external resource. " +
      "Called after agent creates the external resource via MCP tools.",
    inputSchema: jsonSchema<{ slug: string; ref: string }>({
      type: "object",
      properties: {
        slug: { type: "string", description: "Resource slug to link" },
        ref: { type: "string", description: "External reference URL or ID" },
      },
      required: ["slug", "ref"],
    }),
    execute: async ({ slug, ref }) => {
      try {
        return await toolkit.linkRef(workspaceId, slug, ref);
      } catch (err) {
        return { error: stringifyError(err) };
      }
    },
  });
}

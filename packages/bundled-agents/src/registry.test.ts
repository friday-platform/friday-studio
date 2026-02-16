/**
 * Bundled Agent Registry Tests
 *
 * Ensures all bundled agent schemas are FSM-engine-compatible.
 * If an agent declares a Zod schema that produces JSON Schema keywords
 * the engine can't handle (anyOf, oneOf, allOf, etc.), the sanitization
 * step silently strips them. These tests catch that at CI time.
 */

import { sanitizeJsonSchema } from "@atlas/schemas/json-schema";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { bundledAgents } from "./registry.ts";

/** JSON Schema meta-keywords — not data-carrying, safe to strip. */
const META_KEYS = new Set(["$schema", "$id", "$ref", "$defs"]);

/**
 * Deep-compare raw JSON Schema against its sanitized version.
 * Returns paths where information was lost during sanitization.
 */
function findStrippedPaths(
  raw: Record<string, unknown>,
  sanitized: Record<string, unknown>,
  path = "$",
): string[] {
  const stripped: string[] = [];

  for (const key of Object.keys(raw)) {
    if (META_KEYS.has(key)) continue;

    const rawVal = raw[key];
    const sanVal = sanitized[key];

    if (sanVal === undefined) {
      stripped.push(`${path}.${key}`);
      continue;
    }

    if (
      typeof rawVal === "object" &&
      rawVal !== null &&
      typeof sanVal === "object" &&
      sanVal !== null &&
      !Array.isArray(rawVal)
    ) {
      stripped.push(
        ...findStrippedPaths(
          rawVal as Record<string, unknown>,
          sanVal as Record<string, unknown>,
          `${path}.${key}`,
        ),
      );
    }
  }

  return stripped;
}

const agentsWithSchemas = bundledAgents
  .map((agent) => ({
    id: agent.metadata.id,
    inputSchema: agent.metadata.inputSchema as z.ZodType | undefined,
    outputSchema: agent.metadata.outputSchema as z.ZodType | undefined,
  }))
  .filter((a) => a.inputSchema || a.outputSchema);

describe("bundled agent schema engine compatibility", () => {
  test.each(agentsWithSchemas)("$id schemas survive sanitization without data loss", ({
    id,
    inputSchema,
    outputSchema,
  }) => {
    for (const [label, schema] of [
      ["inputSchema", inputSchema],
      ["outputSchema", outputSchema],
    ] as const) {
      if (!schema) continue;

      const raw = z.toJSONSchema(schema) as Record<string, unknown>;
      const sanitized = sanitizeJsonSchema(raw) as Record<string, unknown>;
      const strippedPaths = findStrippedPaths(raw, sanitized);

      expect(
        strippedPaths,
        [
          `Agent "${id}" ${label} uses JSON Schema keywords unsupported by the FSM engine.`,
          `Stripped paths: ${strippedPaths.join(", ")}`,
          `Fix the Zod schema to avoid constructs that produce these keywords`,
          `(e.g., use .optional() instead of .nullable(), avoid .union()/.or()).`,
        ].join("\n"),
      ).toEqual([]);
    }
  });
});

describe("findStrippedPaths", () => {
  test("detects union schemas that produce anyOf", () => {
    const schemaWithUnion = z.object({ to: z.union([z.string(), z.array(z.string())]) });
    const raw = z.toJSONSchema(schemaWithUnion) as Record<string, unknown>;
    const sanitized = sanitizeJsonSchema(raw) as Record<string, unknown>;
    const strippedPaths = findStrippedPaths(raw, sanitized);

    expect(strippedPaths).toContain("$.properties.to.anyOf");
  });

  test("detects nullable schemas that produce anyOf", () => {
    const schemaWithNullable = z.object({ value: z.string().nullable() });
    const raw = z.toJSONSchema(schemaWithNullable) as Record<string, unknown>;
    const sanitized = sanitizeJsonSchema(raw) as Record<string, unknown>;
    const strippedPaths = findStrippedPaths(raw, sanitized);

    expect(strippedPaths).toContain("$.properties.value.anyOf");
  });

  test("passes clean schemas without stripping", () => {
    const cleanSchema = z.object({
      name: z.string(),
      count: z.number().optional(),
      items: z.array(z.string()),
    });
    const raw = z.toJSONSchema(cleanSchema) as Record<string, unknown>;
    const sanitized = sanitizeJsonSchema(raw) as Record<string, unknown>;
    const strippedPaths = findStrippedPaths(raw, sanitized);

    expect(strippedPaths).toEqual([]);
  });
});

/**
 * Helpers for deriving form field metadata from JSON Schema properties.
 * Adapted from apps/web-client for the agent-playground.
 *
 * @module
 */

import { z } from "zod";

export type FieldDef = { type?: string; title?: string; description?: string; format?: string };

const FieldDefSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  format: z.string().optional(),
});

/** Safely parse a JSON Schema property into a FieldDef. */
export function parseFieldDef(value: unknown): FieldDef {
  const result = FieldDefSchema.safeParse(value);
  return result.success ? result.data : {};
}

/** Converts a raw field key like "csv_artifact" to "CSV Artifact". */
export function humanizeFieldName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

export type FieldRendering = "boolean" | "number" | "text";

/** Determines which input control a schema field should render. */
export function getFieldRendering(fieldDef: FieldDef): FieldRendering {
  if (fieldDef.type === "boolean") return "boolean";
  if (fieldDef.type === "number" || fieldDef.type === "integer") return "number";
  return "text";
}

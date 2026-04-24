import { z } from "zod";

export type FieldDef = { type?: string; title?: string; description?: string; format?: string };

const FieldDefSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  format: z.string().optional(),
});

export function parseFieldDef(value: unknown): FieldDef {
  const result = FieldDefSchema.safeParse(value);
  return result.success ? result.data : {};
}

/** Words that should be fully uppercased when displayed in field labels. */
const UPPERCASE_WORDS = new Set([
  "csv",
  "json",
  "txt",
  "md",
  "yml",
  "yaml",
  "pdf",
  "docx",
  "pptx",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
]);

/** Converts a raw field key like "csv_artifact" to "CSV Artifact". */
export function humanizeFieldName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w+/g, (word) =>
      UPPERCASE_WORDS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    );
}

export type FieldRendering = "boolean" | "artifact-ref" | "number" | "text";

/**
 * Determines which input control a schema field should render.
 * Mirrors the if/else-if chain in the run-job-dialog template.
 */
export function getFieldRendering(fieldDef: FieldDef): FieldRendering {
  if (fieldDef.type === "boolean") return "boolean";
  if (fieldDef.format === "artifact-ref" && fieldDef.type !== "array") return "artifact-ref";
  if (fieldDef.type === "number" || fieldDef.type === "integer") return "number";
  return "text";
}

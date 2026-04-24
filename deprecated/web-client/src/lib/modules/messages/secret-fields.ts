import { z } from "zod";

export type SecretField = { key: string; label: string; required: boolean };

const UPPER_WORDS = new Set(["api", "id", "url", "uri", "sql", "ssh"]);

function secretKeyToLabel(key: string): string {
  return key
    .split("_")
    .map((w) =>
      UPPER_WORDS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

export const SecretSchemaShape = z.object({
  properties: z.record(z.string(), z.object({}).passthrough()).optional(),
  required: z.array(z.string()).optional(),
});

export function schemaToSecretFields(schema: z.infer<typeof SecretSchemaShape>): SecretField[] {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  return Object.keys(properties).map((key) => ({
    key,
    label: secretKeyToLabel(key),
    required: required.has(key),
  }));
}

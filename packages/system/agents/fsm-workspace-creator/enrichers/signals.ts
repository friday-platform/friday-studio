/**
 * File/artifact reference keywords used to detect fields that should have
 * format: "artifact-ref". Matched against the property description (lowercase).
 */
const ARTIFACT_REF_KEYWORDS = [
  "uploaded file",
  "uploaded csv",
  "uploaded document",
  "uploaded image",
  "uploaded spreadsheet",
  "file to analyze",
  "file to process",
  "file upload",
  "artifact",
];

/**
 * Scans a JSON Schema's top-level string properties and adds
 * `format: "artifact-ref"` to any whose description suggests a file/artifact
 * reference. This is deterministic post-processing that compensates for the
 * workspace-planner LLM not reliably emitting the format annotation.
 */
export function injectArtifactRefFormat(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return schema;

  let changed = false;
  const patched = { ...(properties as Record<string, Record<string, unknown>>) };

  for (const [key, prop] of Object.entries(patched)) {
    if (!prop || typeof prop !== "object") continue;
    // Skip if already annotated
    if (prop.format === "artifact-ref") continue;

    const type = prop.type;
    const desc = typeof prop.description === "string" ? prop.description.toLowerCase() : "";

    const isFileField =
      ARTIFACT_REF_KEYWORDS.some((kw) => desc.includes(kw)) || /(?:^|_)file(?:$|_)/.test(key);

    if (!isFileField) continue;

    if (type === "string") {
      patched[key] = { ...prop, format: "artifact-ref" };
      changed = true;
    } else if (
      type === "array" &&
      prop.items &&
      typeof prop.items === "object" &&
      (prop.items as Record<string, unknown>).type === "string"
    ) {
      patched[key] = {
        ...prop,
        items: { ...(prop.items as Record<string, unknown>), format: "artifact-ref" },
      };
      changed = true;
    }
  }

  return changed ? { ...schema, properties: patched } : schema;
}

/** Recursively parse string values that are valid JSON. */
export function deepParseJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return deepParseJson(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(deepParseJson);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = deepParseJson(v);
    }
    return result;
  }
  return value;
}

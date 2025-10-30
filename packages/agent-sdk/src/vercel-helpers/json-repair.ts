import type { RepairTextFunction } from "ai";
import { jsonrepair } from "jsonrepair";

/**
 * Recursively detects and parses stringified JSON within object fields.
 *
 * Handles LLM responses where objects are serialized as strings:
 * {"plan": "{\"workspace\": {...}}"} → {"plan": {"workspace": {...}}}
 */
function unstringifyNestedJson(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(unstringifyNestedJson);
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = unstringifyNestedJson(val);
    }
    return result;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return unstringifyNestedJson(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
  }

  return value;
}

/**
 * Validates that value is an object or array, not a primitive.
 */
function isObjectOrArray(value: unknown): boolean {
  return value !== null && (typeof value === "object" || Array.isArray(value));
}

/**
 * Three-tier JSON repair strategy for LLM responses:
 * 1. Try standard JSON.parse (handles valid JSON)
 * 2. Try jsonrepair (handles syntax errors like trailing commas)
 * 3. Return null if unrepairable or not an object/array
 *
 * After successful parse, always check for and unstringify nested JSON fields.
 */
export const repairJson: RepairTextFunction = ({ text }) => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      const repaired = jsonrepair(text);
      parsed = JSON.parse(repaired);
    } catch {
      return Promise.resolve(null);
    }
  }

  if (!isObjectOrArray(parsed)) {
    return Promise.resolve(null);
  }

  const unstringified = unstringifyNestedJson(parsed);
  return Promise.resolve(JSON.stringify(unstringified));
};

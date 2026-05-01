/**
 * Pure function for comparing data contracts between adjacent pipeline steps.
 *
 * Compares a producer's output schema against a consumer's input schema,
 * returning field-level match/missing/extra/type_mismatch results.
 *
 * @module
 */

import { z } from "zod";
import { JsonSchemaObjectShape, JsonSchemaPropertyShape } from "./schema-utils.ts";

export interface ContractField {
  /** Dot-notation path (e.g. "data.path" for nested) */
  field: string;
  /** Producer type label, null if field only in consumer */
  producerType: string | null;
  /** Consumer type label, null if field only in producer */
  consumerType: string | null;
  /** Whether the consumer requires this field */
  required: boolean;
  /** Comparison status */
  status: "match" | "missing" | "extra" | "type_mismatch";
}

export interface ContractComparison {
  fields: ContractField[];
  summary: {
    total: number;
    matched: number;
    /** Required by consumer, absent from producer */
    missing: number;
    /** In producer, not in consumer */
    extra: number;
    /** Present in both, types differ */
    mismatched: number;
  };
  /** True when missing === 0 && mismatched === 0 */
  satisfied: boolean;
}

interface FlatField {
  field: string;
  type: string;
  required: boolean;
}

/**
 * Resolve a JSON Schema property's type label.
 * Arrays become "itemType[]" to match existing schema-utils convention.
 */
function resolveType(def: z.infer<typeof JsonSchemaPropertyShape>): string {
  const rawType = def.type ?? "unknown";
  if (rawType === "array") {
    const itemType = def.items?.type ?? "unknown";
    return `${itemType}[]`;
  }
  return rawType;
}

/**
 * Flatten a JSON Schema into dot-notated field entries.
 * Recurses into nested objects (one level, matching flattenSchema in schema-utils).
 */
function flatten(
  schema: Record<string, unknown>,
  prefix: string,
  requiredSet: Set<string>,
  depth: number,
): FlatField[] {
  const parsed = JsonSchemaObjectShape.safeParse(schema);
  if (!parsed.success || !parsed.data.properties) return [];

  const fields: FlatField[] = [];
  for (const [key, rawDef] of Object.entries(parsed.data.properties)) {
    const propResult = JsonSchemaPropertyShape.safeParse(rawDef);
    const def = propResult.success ? propResult.data : undefined;

    const fullName = prefix ? `${prefix}.${key}` : key;
    const isRequired = requiredSet.has(key);
    const rawType = def?.type ?? "unknown";

    if (rawType === "object" && def?.properties && depth < 1) {
      const nestedRequired = new Set<string>(def.required ?? []);
      fields.push(
        ...flatten(
          { properties: def.properties, required: def.required },
          fullName,
          nestedRequired,
          depth + 1,
        ),
      );
    } else {
      fields.push({
        field: fullName,
        type: def ? resolveType(def) : "unknown",
        required: isRequired,
      });
    }
  }
  return fields;
}

/**
 * Flatten a top-level JSON Schema into field entries.
 */
function flattenTopLevel(schema: object): FlatField[] {
  const parsed = JsonSchemaObjectShape.safeParse(schema);
  if (!parsed.success || !parsed.data.properties) return [];

  const requiredSet = new Set<string>(parsed.data.required ?? []);
  return flatten({ ...parsed.data }, "", requiredSet, 0);
}

/**
 * Compare a producer's output schema against a consumer's input schema.
 *
 * @param producerSchema - JSON Schema describing what the producer outputs
 * @param consumerSchema - JSON Schema describing what the consumer expects
 * @returns Field-level comparison with summary counts
 */
export function compareContracts(
  producerSchema: object | null,
  consumerSchema: object | null,
): ContractComparison {
  const producer = producerSchema ? flattenTopLevel(producerSchema) : [];
  const consumer = consumerSchema ? flattenTopLevel(consumerSchema) : [];

  const producerMap = new Map<string, FlatField>();
  for (const f of producer) producerMap.set(f.field, f);

  const consumerMap = new Map<string, FlatField>();
  for (const f of consumer) consumerMap.set(f.field, f);

  const allFields = new Set([...producerMap.keys(), ...consumerMap.keys()]);
  const fields: ContractField[] = [];

  for (const field of allFields) {
    const p = producerMap.get(field);
    const c = consumerMap.get(field);

    if (p && c) {
      // Field in both — check type match
      const status = p.type === c.type ? ("match" as const) : ("type_mismatch" as const);
      fields.push({
        field,
        producerType: p.type,
        consumerType: c.type,
        required: c.required,
        status,
      });
    } else if (p && !c) {
      // In producer only — extra
      fields.push({
        field,
        producerType: p.type,
        consumerType: null,
        required: false,
        status: "extra",
      });
    } else if (!p && c) {
      // In consumer only — missing if required, extra if optional
      fields.push({
        field,
        producerType: null,
        consumerType: c.type,
        required: c.required,
        status: c.required ? "missing" : "extra",
      });
    }
  }

  const summary = {
    total: fields.length,
    matched: fields.filter((f) => f.status === "match").length,
    missing: fields.filter((f) => f.status === "missing").length,
    extra: fields.filter((f) => f.status === "extra").length,
    mismatched: fields.filter((f) => f.status === "type_mismatch").length,
  };

  return { fields, summary, satisfied: summary.missing === 0 && summary.mismatched === 0 };
}

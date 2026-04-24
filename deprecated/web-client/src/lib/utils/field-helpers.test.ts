import { describe, expect, test } from "vitest";
import { getFieldRendering, humanizeFieldName, parseFieldDef } from "./field-helpers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Tests — imports real functions from $lib/utils/field-helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("field routing", () => {
  test("renders artifact-ref input for format: artifact-ref string fields", () => {
    const fieldDef = parseFieldDef({
      type: "string",
      format: "artifact-ref",
      description: "Upload a CSV",
    });
    expect(getFieldRendering(fieldDef)).toBe("artifact-ref");
  });

  test("renders text input for string fields without format", () => {
    const fieldDef = parseFieldDef({ type: "string" });
    expect(getFieldRendering(fieldDef)).toBe("text");
  });

  test("renders text input for array fields with format: artifact-ref (fallback)", () => {
    const fieldDef = parseFieldDef({ type: "array", format: "artifact-ref" });
    expect(getFieldRendering(fieldDef)).toBe("text");
  });

  test("renders boolean input for boolean fields", () => {
    const fieldDef = parseFieldDef({ type: "boolean" });
    expect(getFieldRendering(fieldDef)).toBe("boolean");
  });

  test("renders number input for number fields", () => {
    const fieldDef = parseFieldDef({ type: "number" });
    expect(getFieldRendering(fieldDef)).toBe("number");
  });

  test("renders number input for integer fields", () => {
    const fieldDef = parseFieldDef({ type: "integer" });
    expect(getFieldRendering(fieldDef)).toBe("number");
  });

  test("renders artifact-ref for fields with no explicit type but artifact-ref format", () => {
    const fieldDef = parseFieldDef({ format: "artifact-ref" });
    expect(getFieldRendering(fieldDef)).toBe("artifact-ref");
  });

  test("parses unknown schema values to empty FieldDef", () => {
    const fieldDef = parseFieldDef(42);
    expect(getFieldRendering(fieldDef)).toBe("text");
  });
});

describe("humanizeFieldName", () => {
  test("uppercases known format words and title-cases the rest", () => {
    expect(humanizeFieldName("csv_artifact")).toBe("CSV Artifact");
  });

  test("handles single word", () => {
    expect(humanizeFieldName("name")).toBe("Name");
  });

  test("handles multiple underscores", () => {
    expect(humanizeFieldName("input_data_file")).toBe("Input Data File");
  });

  test("handles empty string", () => {
    expect(humanizeFieldName("")).toBe("");
  });

  test("handles already capitalized words", () => {
    expect(humanizeFieldName("CSV_file")).toBe("CSV File");
  });
});

import { describe, expect, it } from "vitest";
import { hasArtifactRefFields, stripArtifactIdPrefix } from "./resolve-artifact-refs.ts";

describe("hasArtifactRefFields", () => {
  it("returns true for single artifact-ref field", () => {
    const schema = {
      type: "object",
      properties: { file_path: { type: "string", format: "artifact-ref" } },
    };
    expect(hasArtifactRefFields(schema)).toBe(true);
  });

  it("returns true for array artifact-ref field", () => {
    const schema = {
      type: "object",
      properties: { files: { type: "array", items: { type: "string", format: "artifact-ref" } } },
    };
    expect(hasArtifactRefFields(schema)).toBe(true);
  });

  it("returns false for non-artifact-ref fields", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    expect(hasArtifactRefFields(schema)).toBe(false);
  });

  it("returns false for schema with no properties", () => {
    expect(hasArtifactRefFields({ type: "object" })).toBe(false);
  });
});

describe("stripArtifactIdPrefix", () => {
  it("strips artifact: prefix", () => {
    expect(stripArtifactIdPrefix("artifact:abc-123")).toBe("abc-123");
  });

  it("strips cortex:// prefix", () => {
    expect(stripArtifactIdPrefix("cortex://abc-123")).toBe("abc-123");
  });

  it("leaves bare UUIDs unchanged", () => {
    expect(stripArtifactIdPrefix("abc-123")).toBe("abc-123");
  });

  it("leaves unknown prefixes unchanged", () => {
    expect(stripArtifactIdPrefix("file://abc-123")).toBe("file://abc-123");
  });
});

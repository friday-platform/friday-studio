import type { ValidatedJSONSchema } from "@atlas/core/artifacts";
import { describe, expect, it } from "vitest";
import { injectArtifactRefFormat } from "./enrich-signals.ts";

describe("injectArtifactRefFormat", () => {
  it("annotates string property with key matching 'file' pattern", () => {
    const result = injectArtifactRefFormat({
      type: "object",
      properties: { file_path: { type: "string", description: "Path to data" } },
    });
    expect(result).toEqual({
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to data", format: "artifact-ref" },
      },
    });
  });

  it("annotates string property with file-related description", () => {
    const result = injectArtifactRefFormat({
      type: "object",
      properties: {
        data_input: { type: "string", description: "The uploaded CSV file to analyze" },
      },
    });
    expect(result).toEqual({
      type: "object",
      properties: {
        data_input: {
          type: "string",
          description: "The uploaded CSV file to analyze",
          format: "artifact-ref",
        },
      },
    });
  });

  it("annotates array-of-strings property with file-like key", () => {
    const result = injectArtifactRefFormat({
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Uploaded documents to process",
        },
      },
    });
    expect(result).toEqual({
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string", format: "artifact-ref" },
          description: "Uploaded documents to process",
        },
      },
    });
  });

  it("does not double-annotate fields with existing format: artifact-ref", () => {
    const schema: ValidatedJSONSchema = {
      type: "object",
      properties: {
        csv_file: { type: "string", format: "artifact-ref", description: "Uploaded file" },
      },
    };
    expect(injectArtifactRefFormat(schema)).toBe(schema);
  });

  it("does not annotate non-file property", () => {
    const schema: ValidatedJSONSchema = {
      type: "object",
      properties: { profile: { type: "string", description: "user profile" } },
    };
    expect(injectArtifactRefFormat(schema)).toBe(schema);
  });

  it("returns schema unchanged when no properties field", () => {
    const schema: ValidatedJSONSchema = { type: "object" };
    expect(injectArtifactRefFormat(schema)).toBe(schema);
  });

  it("does not annotate non-string, non-array-of-string file fields", () => {
    const schema: ValidatedJSONSchema = {
      type: "object",
      properties: { file_count: { type: "number", description: "Number of uploaded files" } },
    };
    expect(injectArtifactRefFormat(schema)).toBe(schema);
  });

  it("does not mutate the original schema", () => {
    const original: ValidatedJSONSchema = {
      type: "object",
      properties: { input_file: { type: "string", description: "Data file" } },
    };
    const result = injectArtifactRefFormat(original);

    expect(result).not.toBe(original);
    expect(original.properties).toEqual({
      input_file: { type: "string", description: "Data file" },
    });
    expect(result).toEqual({
      type: "object",
      properties: {
        input_file: { type: "string", description: "Data file", format: "artifact-ref" },
      },
    });
  });
});

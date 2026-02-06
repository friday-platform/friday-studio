import { describe, expect, it } from "vitest";
import { injectArtifactRefFormat } from "./signals.ts";

describe("injectArtifactRefFormat", () => {
  it("adds format: artifact-ref to string fields with file-related descriptions", () => {
    const schema = {
      type: "object",
      properties: { csv_file: { type: "string", description: "Uploaded CSV file to analyze" } },
      required: ["csv_file"],
    };
    const result = injectArtifactRefFormat(schema);
    expect(result.properties).toHaveProperty("csv_file.format", "artifact-ref");
  });

  it("adds format: artifact-ref to fields with 'file' in the key name", () => {
    const schema = {
      type: "object",
      properties: { input_file: { type: "string", description: "The data to process" } },
    };
    const result = injectArtifactRefFormat(schema);
    expect(result.properties).toHaveProperty("input_file.format", "artifact-ref");
  });

  it("does not add format to non-file string fields", () => {
    const schema = {
      type: "object",
      properties: { user_input: { type: "string", description: "User text input or description" } },
    };
    const result = injectArtifactRefFormat(schema);
    expect(result.properties).not.toHaveProperty("user_input.format");
  });

  it("skips fields that already have format: artifact-ref", () => {
    const schema = {
      type: "object",
      properties: {
        csv_file: { type: "string", format: "artifact-ref", description: "Uploaded file" },
      },
    };
    const result = injectArtifactRefFormat(schema);
    expect(result).toBe(schema);
  });

  it("handles array fields with string items", () => {
    const schema = {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Uploaded documents to process",
        },
      },
    };
    const result = injectArtifactRefFormat(schema);
    expect(result.properties).toHaveProperty("files.items.format", "artifact-ref");
  });

  it("returns schema unchanged when no properties match", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Number of results" },
      },
    };
    const result = injectArtifactRefFormat(schema);
    expect(result).toBe(schema); // same reference, not copied
  });

  it("returns schema unchanged when no properties field", () => {
    const schema = { type: "object" };
    const result = injectArtifactRefFormat(schema);
    expect(result).toBe(schema);
  });

  it("matches description keyword 'file upload'", () => {
    const schema = {
      type: "object",
      properties: { document: { type: "string", description: "File upload for processing" } },
    };
    const result = injectArtifactRefFormat(schema);
    expect(result.properties).toHaveProperty("document.format", "artifact-ref");
  });
});

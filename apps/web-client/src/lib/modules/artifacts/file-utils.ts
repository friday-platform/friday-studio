import { parse as parseYaml } from "@std/yaml";
import Papa from "papaparse";

export type ParsedContent =
  | { type: "markdown"; content: string }
  | { type: "csv"; headers: string[]; rows: Record<string, string | number>[] }
  | { type: "json"; content: string }
  | { type: "yaml"; content: string }
  | { type: "plaintext"; content: string }
  | { type: "code"; content: string }
  | { type: "error"; message: string; raw: string };

export function parseFileContents(contents: string, mimeType: string): ParsedContent {
  // Markdown
  if (mimeType === "text/markdown" || mimeType === "text/x-markdown") {
    return { type: "markdown", content: contents };
  }

  // CSV
  if (mimeType === "text/csv") {
    try {
      const result = Papa.parse<Record<string, string | number>>(contents, {
        header: true,
        skipEmptyLines: true,
      });
      if (result.errors.length > 0) {
        return {
          type: "error",
          message: `CSV parsing error: ${result.errors[0]?.message ?? "Unknown error"}`,
          raw: contents,
        };
      }
      const headers = result.meta.fields ?? [];
      return { type: "csv", headers, rows: result.data };
    } catch (e) {
      return {
        type: "error",
        message: `CSV parsing failed: ${e instanceof Error ? e.message : "Unknown error"}`,
        raw: contents,
      };
    }
  }

  // JSON
  if (mimeType === "application/json") {
    try {
      const parsed = JSON.parse(contents) as unknown;
      return { type: "json", content: JSON.stringify(parsed, null, 2) };
    } catch (e) {
      return {
        type: "error",
        message: `JSON parsing failed: ${e instanceof Error ? e.message : "Unknown error"}`,
        raw: contents,
      };
    }
  }

  // YAML
  if (mimeType === "text/yaml" || mimeType === "application/x-yaml") {
    try {
      // Validate YAML is parseable, but display original content
      parseYaml(contents);
      return { type: "yaml", content: contents };
    } catch (e) {
      return {
        type: "error",
        message: `YAML parsing failed: ${e instanceof Error ? e.message : "Unknown error"}`,
        raw: contents,
      };
    }
  }

  // Plain text
  if (mimeType === "text/plain") {
    return { type: "plaintext", content: contents };
  }

  // Default: treat as code
  return { type: "code", content: contents };
}

import { describe, expect, it } from "vitest";
import { generateExamplePayload } from "./generate-example-payload.ts";

describe("generateExamplePayload", () => {
  it("returns empty object for undefined schema", () => {
    expect(generateExamplePayload(undefined)).toEqual({});
  });

  it("returns empty object for non-object schema", () => {
    expect(generateExamplePayload({ type: "string" })).toEqual({});
  });

  it("generates example from object schema with typed properties", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", description: "Full name of the user" },
        count: { type: "integer" },
        active: { type: "boolean" },
        tags: { type: "array" },
      },
      required: ["name"],
    };

    const result = generateExamplePayload(schema);
    expect(result).toEqual({ name: "<full name of the user>", count: 0, active: false, tags: [] });
  });

  it("uses description text before parenthetical as placeholder", () => {
    const schema = {
      type: "object",
      properties: {
        pr_url: {
          type: "string",
          description:
            "Full GitHub pull request URL (e.g., https://github.com/owner/repo/pull/123)",
        },
      },
    };

    const result = generateExamplePayload(schema);
    expect(result.pr_url).toBe("<full github pull request url>");
  });

  it("uses default value when present", () => {
    const schema = { type: "object", properties: { mode: { type: "string", default: "auto" } } };

    expect(generateExamplePayload(schema)).toEqual({ mode: "auto" });
  });

  it("generates nested objects", () => {
    const schema = {
      type: "object",
      properties: { config: { type: "object", properties: { verbose: { type: "boolean" } } } },
    };

    expect(generateExamplePayload(schema)).toEqual({ config: { verbose: false } });
  });

  it("returns empty object when properties is missing", () => {
    expect(generateExamplePayload({ type: "object" })).toEqual({});
  });
});

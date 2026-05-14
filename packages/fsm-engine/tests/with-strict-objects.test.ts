import { describe, expect, it } from "vitest";
import { withStrictObjects } from "../fsm-engine.ts";
import type { JSONSchema } from "../types.ts";

describe("withStrictObjects", () => {
  it("adds additionalProperties: false to a plain object schema", () => {
    const out = withStrictObjects({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(out).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("preserves a pre-existing additionalProperties value (does not overwrite)", () => {
    const out = withStrictObjects({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: true,
    });
    expect(out.additionalProperties).toBe(true);
  });

  it("recurses into nested objects under properties", () => {
    const out = withStrictObjects({
      type: "object",
      properties: { meta: { type: "object", properties: { id: { type: "string" } } } },
    });
    expect(out).toMatchObject({ properties: { meta: { additionalProperties: false } } });
  });

  it("recurses into array items that are objects", () => {
    const out = withStrictObjects({
      type: "array",
      items: { type: "object", properties: { id: { type: "string" } } },
    });
    expect(out.items).toMatchObject({ additionalProperties: false });
  });

  it("recurses into deeply nested array-of-objects-with-objects", () => {
    const out = withStrictObjects({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { detail: { type: "object", properties: { kind: { type: "string" } } } },
          },
        },
      },
    });
    expect(out).toMatchObject({
      properties: {
        items: {
          items: {
            additionalProperties: false,
            properties: { detail: { additionalProperties: false } },
          },
        },
      },
    });
  });

  it("treats nodes with `properties` but no `type` as implicit objects", () => {
    const out = withStrictObjects({ properties: { name: { type: "string" } } });
    expect(out.additionalProperties).toBe(false);
  });

  it("does not mutate the input schema", () => {
    const input: JSONSchema = { type: "object", properties: { name: { type: "string" } } };
    const snapshot = JSON.stringify(input);
    withStrictObjects(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("returns non-record inputs unchanged (null, array, primitive)", () => {
    expect(withStrictObjects(null as unknown as JSONSchema)).toBe(null);
    const arr = [{ type: "string" }] as unknown as JSONSchema;
    expect(withStrictObjects(arr)).toBe(arr);
  });

  it("leaves leaf string/number schemas untouched", () => {
    expect(withStrictObjects({ type: "string" })).toEqual({ type: "string" });
    expect(withStrictObjects({ type: "number", minimum: 0 })).toEqual({
      type: "number",
      minimum: 0,
    });
  });
});

import { describe, expect, it } from "vitest";
import { deepParseJson } from "./deep-parse-json.ts";

describe("deepParseJson", () => {
  it("parses a JSON string value into an object", () => {
    expect(deepParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("recursively parses nested JSON strings", () => {
    const input = {
      content: [{ type: "text", text: '{"results":[],"type":"workspace_search"}' }],
      isError: false,
    };
    expect(deepParseJson(input)).toEqual({
      content: [{ type: "text", text: { results: [], type: "workspace_search" } }],
      isError: false,
    });
  });

  it("parses double-encoded JSON strings", () => {
    const doubleEncoded = JSON.stringify({ key: "value" });
    expect(deepParseJson(doubleEncoded)).toEqual({ key: "value" });
  });

  it("leaves markdown strings as-is", () => {
    const markdown = "# Hello\n\n- item 1\n- item 2\n\n```js\nconsole.log('hi')\n```";
    expect(deepParseJson(markdown)).toBe(markdown);
  });

  it("leaves plain text strings as-is", () => {
    expect(deepParseJson("just some regular text")).toBe("just some regular text");
  });

  it("leaves empty string as-is", () => {
    expect(deepParseJson("")).toBe("");
  });

  it("passes through numbers", () => {
    expect(deepParseJson(42)).toBe(42);
  });

  it("passes through booleans", () => {
    expect(deepParseJson(true)).toBe(true);
  });

  it("passes through null", () => {
    expect(deepParseJson(null)).toBe(null);
  });

  it("passes through undefined", () => {
    expect(deepParseJson(undefined)).toBe(undefined);
  });

  it("handles arrays with mixed parseable and non-parseable strings", () => {
    const input = ['{"parsed":true}', "plain text", 42];
    expect(deepParseJson(input)).toEqual([{ parsed: true }, "plain text", 42]);
  });

  it("handles deeply nested objects", () => {
    const input = { level1: { level2: '{"level3":{"value":"deep"}}' } };
    expect(deepParseJson(input)).toEqual({ level1: { level2: { level3: { value: "deep" } } } });
  });

  it("leaves strings that look like JSON but are invalid", () => {
    const broken = '{not: "valid json"';
    expect(deepParseJson(broken)).toBe(broken);
  });

  it("handles a string that is just a JSON number", () => {
    expect(deepParseJson("123")).toBe(123);
  });

  it("handles a string that is just a JSON boolean", () => {
    expect(deepParseJson("true")).toBe(true);
  });
});

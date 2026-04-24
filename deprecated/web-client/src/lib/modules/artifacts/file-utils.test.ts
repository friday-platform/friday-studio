import { describe, expect, it } from "vitest";
import { parseFileContents } from "./file-utils.ts";

describe("parseFileContents", () => {
  // Markdown tests
  it("markdown text/markdown", () => {
    const content = "# Hello World\n\nSome **bold** text";
    const result = parseFileContents(content, "text/markdown");
    expect(result).toEqual({ type: "markdown", content });
  });

  it("markdown text/x-markdown", () => {
    const content = "## Heading\n- list item";
    const result = parseFileContents(content, "text/x-markdown");
    expect(result).toEqual({ type: "markdown", content });
  });

  // CSV tests
  it("csv valid", () => {
    const content = "name,age,city\nAlice,30,NYC\nBob,25,LA";
    const result = parseFileContents(content, "text/csv");
    expect(result.type).toEqual("csv");
    if (result.type === "csv") {
      expect(result.headers).toEqual(["name", "age", "city"]);
      expect(result.rows.length).toEqual(2);
      expect(result.rows[0]).toEqual({ name: "Alice", age: "30", city: "NYC" });
      expect(result.rows[1]).toEqual({ name: "Bob", age: "25", city: "LA" });
    }
  });

  it("csv empty returns error", () => {
    const content = "";
    const result = parseFileContents(content, "text/csv");
    // Papa.parse returns an error for empty content
    expect(result.type).toEqual("error");
    if (result.type === "error") {
      expect(result.raw).toEqual(content);
    }
  });

  it("csv skips empty lines", () => {
    const content = "a,b\n1,2\n\n3,4\n";
    const result = parseFileContents(content, "text/csv");
    expect(result.type).toEqual("csv");
    if (result.type === "csv") {
      expect(result.rows.length).toEqual(2);
    }
  });

  it("csv single column returns error", () => {
    const content = "item\napple\nbanana";
    const result = parseFileContents(content, "text/csv");
    // Papa.parse treats headerless single-column data as an error
    expect(result.type).toEqual("error");
    if (result.type === "error") {
      expect(result.raw).toEqual(content);
    }
  });

  // JSON tests
  it("json object", () => {
    const content = '{"name":"test","value":42}';
    const result = parseFileContents(content, "application/json");
    expect(result.type).toEqual("json");
    if (result.type === "json") {
      expect(result.content).toEqual('{\n  "name": "test",\n  "value": 42\n}');
    }
  });

  it("json array", () => {
    const content = "[1,2,3]";
    const result = parseFileContents(content, "application/json");
    expect(result.type).toEqual("json");
    if (result.type === "json") {
      expect(result.content).toEqual("[\n  1,\n  2,\n  3\n]");
    }
  });

  it("json primitive string", () => {
    const content = '"hello"';
    const result = parseFileContents(content, "application/json");
    expect(result.type).toEqual("json");
    if (result.type === "json") {
      expect(result.content).toEqual('"hello"');
    }
  });

  it("json primitive number", () => {
    const content = "123";
    const result = parseFileContents(content, "application/json");
    expect(result.type).toEqual("json");
    if (result.type === "json") {
      expect(result.content).toEqual("123");
    }
  });

  it("json null", () => {
    const content = "null";
    const result = parseFileContents(content, "application/json");
    expect(result.type).toEqual("json");
    if (result.type === "json") {
      expect(result.content).toEqual("null");
    }
  });

  it("json invalid returns error", () => {
    const content = "{invalid json}";
    const result = parseFileContents(content, "application/json");
    expect(result.type).toEqual("error");
    if (result.type === "error") {
      expect(result.message.startsWith("JSON parsing failed:")).toEqual(true);
      expect(result.raw).toEqual(content);
    }
  });

  it("json incomplete returns error", () => {
    const content = '{"name": "test"';
    const result = parseFileContents(content, "application/json");
    expect(result.type).toEqual("error");
    if (result.type === "error") {
      expect(result.raw).toEqual(content);
    }
  });

  // YAML tests
  it("yaml text/yaml", () => {
    const content = "name: test\nvalue: 42";
    const result = parseFileContents(content, "text/yaml");
    expect(result).toEqual({ type: "yaml", content });
  });

  it("yaml application/x-yaml", () => {
    const content = "items:\n  - apple\n  - banana";
    const result = parseFileContents(content, "application/x-yaml");
    expect(result).toEqual({ type: "yaml", content });
  });

  it("yaml complex structure", () => {
    const content = `server:
  host: localhost
  port: 8080
database:
  name: mydb
  connection:
    timeout: 30`;
    const result = parseFileContents(content, "text/yaml");
    expect(result.type).toEqual("yaml");
    if (result.type === "yaml") {
      expect(result.content).toEqual(content);
    }
  });

  it("yaml invalid returns error", () => {
    const content = "invalid: yaml: content: here:";
    const result = parseFileContents(content, "text/yaml");
    expect(result.type).toEqual("error");
    if (result.type === "error") {
      expect(result.message.startsWith("YAML parsing failed:")).toEqual(true);
      expect(result.raw).toEqual(content);
    }
  });

  it("yaml with tabs is valid", () => {
    const content = "items:\n\t- item1";
    const result = parseFileContents(content, "text/yaml");
    // @std/yaml parser accepts tabs as indentation
    expect(result).toEqual({ type: "yaml", content });
  });

  // Plain text tests
  it("plaintext", () => {
    const content = "Just some plain text\nwith multiple lines";
    const result = parseFileContents(content, "text/plain");
    expect(result).toEqual({ type: "plaintext", content });
  });

  it("plaintext empty", () => {
    const content = "";
    const result = parseFileContents(content, "text/plain");
    expect(result).toEqual({ type: "plaintext", content: "" });
  });

  // Code (default) tests
  it("unknown mime type returns code", () => {
    const content = "function foo() { return 42; }";
    const result = parseFileContents(content, "application/octet-stream");
    expect(result).toEqual({ type: "code", content });
  });

  it("javascript mime returns code", () => {
    const content = "const x = 1;";
    const result = parseFileContents(content, "text/javascript");
    expect(result).toEqual({ type: "code", content });
  });

  it("typescript mime returns code", () => {
    const content = "const x: number = 1;";
    const result = parseFileContents(content, "text/typescript");
    expect(result).toEqual({ type: "code", content });
  });

  it("html mime returns code", () => {
    const content = "<html><body>Hello</body></html>";
    const result = parseFileContents(content, "text/html");
    expect(result).toEqual({ type: "code", content });
  });

  it("xml mime returns code", () => {
    const content = '<?xml version="1.0"?><root/>';
    const result = parseFileContents(content, "application/xml");
    expect(result).toEqual({ type: "code", content });
  });
});

import { assertEquals } from "@std/assert";
import { parseFileContents } from "./file-utils.ts";

// Markdown tests
Deno.test("parseFileContents - markdown text/markdown", () => {
  const content = "# Hello World\n\nSome **bold** text";
  const result = parseFileContents(content, "text/markdown");
  assertEquals(result, { type: "markdown", content });
});

Deno.test("parseFileContents - markdown text/x-markdown", () => {
  const content = "## Heading\n- list item";
  const result = parseFileContents(content, "text/x-markdown");
  assertEquals(result, { type: "markdown", content });
});

// CSV tests
Deno.test("parseFileContents - csv valid", () => {
  const content = "name,age,city\nAlice,30,NYC\nBob,25,LA";
  const result = parseFileContents(content, "text/csv");
  assertEquals(result.type, "csv");
  if (result.type === "csv") {
    assertEquals(result.headers, ["name", "age", "city"]);
    assertEquals(result.rows.length, 2);
    assertEquals(result.rows[0], { name: "Alice", age: "30", city: "NYC" });
    assertEquals(result.rows[1], { name: "Bob", age: "25", city: "LA" });
  }
});

Deno.test("parseFileContents - csv empty returns error", () => {
  const content = "";
  const result = parseFileContents(content, "text/csv");
  // Papa.parse returns an error for empty content
  assertEquals(result.type, "error");
  if (result.type === "error") {
    assertEquals(result.raw, content);
  }
});

Deno.test("parseFileContents - csv skips empty lines", () => {
  const content = "a,b\n1,2\n\n3,4\n";
  const result = parseFileContents(content, "text/csv");
  assertEquals(result.type, "csv");
  if (result.type === "csv") {
    assertEquals(result.rows.length, 2);
  }
});

Deno.test("parseFileContents - csv single column returns error", () => {
  const content = "item\napple\nbanana";
  const result = parseFileContents(content, "text/csv");
  // Papa.parse treats headerless single-column data as an error
  assertEquals(result.type, "error");
  if (result.type === "error") {
    assertEquals(result.raw, content);
  }
});

// JSON tests
Deno.test("parseFileContents - json object", () => {
  const content = '{"name":"test","value":42}';
  const result = parseFileContents(content, "application/json");
  assertEquals(result.type, "json");
  if (result.type === "json") {
    assertEquals(result.content, '{\n  "name": "test",\n  "value": 42\n}');
  }
});

Deno.test("parseFileContents - json array", () => {
  const content = "[1,2,3]";
  const result = parseFileContents(content, "application/json");
  assertEquals(result.type, "json");
  if (result.type === "json") {
    assertEquals(result.content, "[\n  1,\n  2,\n  3\n]");
  }
});

Deno.test("parseFileContents - json primitive string", () => {
  const content = '"hello"';
  const result = parseFileContents(content, "application/json");
  assertEquals(result.type, "json");
  if (result.type === "json") {
    assertEquals(result.content, '"hello"');
  }
});

Deno.test("parseFileContents - json primitive number", () => {
  const content = "123";
  const result = parseFileContents(content, "application/json");
  assertEquals(result.type, "json");
  if (result.type === "json") {
    assertEquals(result.content, "123");
  }
});

Deno.test("parseFileContents - json null", () => {
  const content = "null";
  const result = parseFileContents(content, "application/json");
  assertEquals(result.type, "json");
  if (result.type === "json") {
    assertEquals(result.content, "null");
  }
});

Deno.test("parseFileContents - json invalid returns error", () => {
  const content = "{invalid json}";
  const result = parseFileContents(content, "application/json");
  assertEquals(result.type, "error");
  if (result.type === "error") {
    assertEquals(result.message.startsWith("JSON parsing failed:"), true);
    assertEquals(result.raw, content);
  }
});

Deno.test("parseFileContents - json incomplete returns error", () => {
  const content = '{"name": "test"';
  const result = parseFileContents(content, "application/json");
  assertEquals(result.type, "error");
  if (result.type === "error") {
    assertEquals(result.raw, content);
  }
});

// YAML tests
Deno.test("parseFileContents - yaml text/yaml", () => {
  const content = "name: test\nvalue: 42";
  const result = parseFileContents(content, "text/yaml");
  assertEquals(result, { type: "yaml", content });
});

Deno.test("parseFileContents - yaml application/x-yaml", () => {
  const content = "items:\n  - apple\n  - banana";
  const result = parseFileContents(content, "application/x-yaml");
  assertEquals(result, { type: "yaml", content });
});

Deno.test("parseFileContents - yaml complex structure", () => {
  const content = `
server:
  host: localhost
  port: 8080
database:
  name: mydb
  connection:
    timeout: 30
`;
  const result = parseFileContents(content.trim(), "text/yaml");
  assertEquals(result.type, "yaml");
  if (result.type === "yaml") {
    assertEquals(result.content, content.trim());
  }
});

Deno.test("parseFileContents - yaml invalid returns error", () => {
  const content = "invalid: yaml: content: here:";
  const result = parseFileContents(content, "text/yaml");
  assertEquals(result.type, "error");
  if (result.type === "error") {
    assertEquals(result.message.startsWith("YAML parsing failed:"), true);
    assertEquals(result.raw, content);
  }
});

Deno.test("parseFileContents - yaml with tabs is valid", () => {
  const content = "items:\n\t- item1";
  const result = parseFileContents(content, "text/yaml");
  // @std/yaml parser accepts tabs as indentation
  assertEquals(result, { type: "yaml", content });
});

// Plain text tests
Deno.test("parseFileContents - plaintext", () => {
  const content = "Just some plain text\nwith multiple lines";
  const result = parseFileContents(content, "text/plain");
  assertEquals(result, { type: "plaintext", content });
});

Deno.test("parseFileContents - plaintext empty", () => {
  const content = "";
  const result = parseFileContents(content, "text/plain");
  assertEquals(result, { type: "plaintext", content: "" });
});

// Code (default) tests
Deno.test("parseFileContents - unknown mime type returns code", () => {
  const content = "function foo() { return 42; }";
  const result = parseFileContents(content, "application/octet-stream");
  assertEquals(result, { type: "code", content });
});

Deno.test("parseFileContents - javascript mime returns code", () => {
  const content = "const x = 1;";
  const result = parseFileContents(content, "text/javascript");
  assertEquals(result, { type: "code", content });
});

Deno.test("parseFileContents - typescript mime returns code", () => {
  const content = "const x: number = 1;";
  const result = parseFileContents(content, "text/typescript");
  assertEquals(result, { type: "code", content });
});

Deno.test("parseFileContents - html mime returns code", () => {
  const content = "<html><body>Hello</body></html>";
  const result = parseFileContents(content, "text/html");
  assertEquals(result, { type: "code", content });
});

Deno.test("parseFileContents - xml mime returns code", () => {
  const content = '<?xml version="1.0"?><root/>';
  const result = parseFileContents(content, "application/xml");
  assertEquals(result, { type: "code", content });
});

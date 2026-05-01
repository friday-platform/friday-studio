import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFetchTool } from "./fetch.ts";

const fetchTool = createFetchTool();

/** Helper: extract the execute function and call it with typed input. */
async function executeFetch(input: { url: string; format?: "markdown" | "text" | "html" }) {
  // AI SDK tool().execute expects the parsed input
  const execute = (
    fetchTool as unknown as { execute: (input: { url: string; format: string }) => Promise<string> }
  ).execute;
  return await execute({ format: "markdown", ...input });
}

/** Creates a minimal Response with the given body and content-type. */
function fakeResponse(body: string, contentType = "text/html", status = 200): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

describe("createFetchTool", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("converts HTML to markdown with TurndownService", async () => {
    const html = "<h1>Hello</h1><p>World</p>";
    fetchSpy.mockResolvedValueOnce(fakeResponse(html));

    const result = await executeFetch({ url: "https://example.com" });

    expect(result).toContain("# Hello");
    expect(result).toContain("World");
  });

  test("strips script, style, meta, and link tags in markdown conversion", async () => {
    const html = `
      <html>
        <head><meta charset="utf-8"><link rel="stylesheet" href="style.css"><style>body{}</style></head>
        <body><script>alert('xss')</script><h1>Clean</h1></body>
      </html>
    `;
    fetchSpy.mockResolvedValueOnce(fakeResponse(html));

    const result = await executeFetch({ url: "https://example.com" });

    expect(result).toContain("# Clean");
    expect(result).not.toContain("alert");
    expect(result).not.toContain("body{}");
    expect(result).not.toContain("stylesheet");
  });

  test("returns raw text for text format", async () => {
    const body = "Just some plain text content.";
    fetchSpy.mockResolvedValueOnce(fakeResponse(body, "text/plain"));

    const result = await executeFetch({ url: "https://example.com/readme.txt", format: "text" });

    expect(result).toBe(body);
  });

  test("returns raw HTML for html format", async () => {
    const html = "<h1>Raw</h1>";
    fetchSpy.mockResolvedValueOnce(fakeResponse(html));

    const result = await executeFetch({ url: "https://example.com", format: "html" });

    expect(result).toBe(html);
  });

  test("returns error string for non-OK response", async () => {
    fetchSpy.mockResolvedValueOnce(fakeResponse("Not Found", "text/plain", 404));

    const result = await executeFetch({ url: "https://example.com/missing" });

    expect(result).toContain("404");
  });

  test("returns error string when fetch throws", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network failure"));

    const result = await executeFetch({ url: "https://example.com" });

    expect(result).toContain("network failure");
  });

  test("rejects responses exceeding 5MB via content-length header", async () => {
    const response = new Response("small body", {
      status: 200,
      headers: { "content-type": "text/html", "content-length": String(6 * 1024 * 1024) },
    });
    fetchSpy.mockResolvedValueOnce(response);

    const result = await executeFetch({ url: "https://example.com/huge" });

    expect(result).toContain("5MB");
  });

  test("sets Chrome desktop User-Agent header", async () => {
    fetchSpy.mockResolvedValueOnce(fakeResponse("<p>ok</p>"));

    await executeFetch({ url: "https://example.com" });

    const callArgs = fetchSpy.mock.calls[0];
    const options = callArgs[1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("Chrome");
  });

  test("passes AbortSignal for timeout", async () => {
    fetchSpy.mockResolvedValueOnce(fakeResponse("<p>ok</p>"));

    await executeFetch({ url: "https://example.com" });

    const callArgs = fetchSpy.mock.calls[0];
    const options = callArgs[1] as RequestInit;
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  test("converts HTML to markdown even for text format when content-type is html", async () => {
    // When format is "text" but the response is HTML, extract text
    const html = "<h1>Title</h1><p>Paragraph text</p>";
    fetchSpy.mockResolvedValueOnce(fakeResponse(html, "text/html"));

    const result = await executeFetch({ url: "https://example.com", format: "text" });

    // Should strip HTML tags for plain text output
    expect(result).toContain("Title");
    expect(result).toContain("Paragraph text");
    expect(result).not.toContain("<h1>");
  });
});

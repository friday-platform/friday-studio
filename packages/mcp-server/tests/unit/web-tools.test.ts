/**
 * Unit tests for web tools
 * Tests web-related operations with mocked HTTP calls
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { createSuccessResponse } from "../../src/tools/types.ts";

// Mock logger for testing
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT = 30 * 1000; // 30 seconds
const MAX_TIMEOUT = 120 * 1000; // 2 minutes

// Extract core logic from web fetch tool for testing
async function webFetchToolLogic(params: {
  url: string;
  format: "text" | "markdown" | "html";
  timeout?: number;
}, fetchImpl: typeof fetch = fetch) {
  // Validate URL
  if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://");
  }

  const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetchImpl(params.url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Request failed with status code: ${response.status}`);
    }

    // Check content length
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 5MB limit)");
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 5MB limit)");
    }

    const content = new TextDecoder().decode(arrayBuffer);
    const contentType = response.headers.get("content-type") || "";

    const title = `${params.url} (${contentType})`;
    let output: string;

    switch (params.format) {
      case "text":
        if (contentType.includes("text/html")) {
          // Simple HTML text extraction for testing
          output = content
            .replace(/<[^>]*>/g, " ") // Replace tags with spaces
            .replace(/\s+/g, " ") // Normalize whitespace
            .trim();
        } else {
          output = content;
        }
        break;

      case "markdown":
        if (contentType.includes("text/html")) {
          // Simple HTML to markdown conversion for testing
          output = content
            .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "# $1\n")
            .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
            .replace(/<[^>]*>/g, "")
            .replace(/\s+/g, " ")
            .trim();
        } else {
          output = "```\n" + content + "\n```";
        }
        break;

      default:
        output = content;
        break;
    }

    return createSuccessResponse({
      output,
      title,
      metadata: {
        url: params.url,
        contentType,
        format: params.format,
        contentLength: arrayBuffer.byteLength,
      },
    });
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeout}ms: ${params.url}`);
    }

    throw error;
  }
}

// Mock fetch function for testing
function createMockFetch(mockResponse: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  content?: string;
  shouldThrow?: boolean;
  throwError?: Error;
  arrayBuffer?: ArrayBuffer;
}) {
  return async (url: string, options?: any) => {
    if (mockResponse.shouldThrow) {
      throw mockResponse.throwError || new Error("Network error");
    }

    const headers = new Map(Object.entries(mockResponse.headers || {}));
    const content = mockResponse.content || "";
    const arrayBuffer = mockResponse.arrayBuffer || new TextEncoder().encode(content);

    return {
      ok: mockResponse.ok !== false,
      status: mockResponse.status || 200,
      statusText: mockResponse.statusText || "OK",
      headers: {
        get: (key: string) => headers.get(key.toLowerCase()) || null,
      },
      arrayBuffer: async () => arrayBuffer,
    };
  };
}

Deno.test("web fetch tool - fetches URL successfully", async () => {
  const mockFetch = createMockFetch({
    content: "Hello, World!",
    headers: { "content-type": "text/plain" },
  });

  const result = await webFetchToolLogic({
    url: "https://example.com",
    format: "text",
  }, mockFetch as any);

  // Check response structure
  assertExists(result.content);
  assertEquals(Array.isArray(result.content), true);
  assertEquals(result.content.length, 1);
  assertEquals(result.content[0].type, "text");

  // Parse the response
  const response = JSON.parse(result.content[0].text);

  // Check response data
  assertEquals(response.title, "https://example.com (text/plain)");
  assertEquals(response.output, "Hello, World!");
  assertEquals(response.metadata.url, "https://example.com");
  assertEquals(response.metadata.contentType, "text/plain");
  assertEquals(response.metadata.format, "text");
});

Deno.test("web fetch tool - handles HTML responses as text", async () => {
  const mockFetch = createMockFetch({
    content: "<html><body><h1>Test Title</h1><p>Test content</p></body></html>",
    headers: { "content-type": "text/html" },
  });

  const result = await webFetchToolLogic({
    url: "https://example.com",
    format: "text",
  }, mockFetch as any);

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that HTML tags are stripped and content is extracted
  assertEquals(response.output, "Test Title Test content");
  assertEquals(response.metadata.contentType, "text/html");
});

Deno.test("web fetch tool - handles HTML responses as markdown", async () => {
  const mockFetch = createMockFetch({
    content: "<html><body><h1>Test Title</h1><p>Test paragraph</p></body></html>",
    headers: { "content-type": "text/html" },
  });

  const result = await webFetchToolLogic({
    url: "https://example.com",
    format: "markdown",
  }, mockFetch as any);

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that HTML is converted to markdown
  assert(response.output.includes("# Test Title"));
  assert(response.output.includes("Test paragraph"));
  assertEquals(response.metadata.format, "markdown");
});

Deno.test("web fetch tool - handles non-HTML responses as markdown", async () => {
  const mockFetch = createMockFetch({
    content: "function test() { return 'hello'; }",
    headers: { "content-type": "application/javascript" },
  });

  const result = await webFetchToolLogic({
    url: "https://example.com/script.js",
    format: "markdown",
  }, mockFetch as any);

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that non-HTML content is wrapped in code blocks
  assert(response.output.startsWith("```\n"));
  assert(response.output.endsWith("\n```"));
  assert(response.output.includes("function test()"));
});

Deno.test("web fetch tool - handles HTML responses as raw HTML", async () => {
  const htmlContent = "<html><body><h1>Test Title</h1><p>Test content</p></body></html>";
  const mockFetch = createMockFetch({
    content: htmlContent,
    headers: { "content-type": "text/html" },
  });

  const result = await webFetchToolLogic({
    url: "https://example.com",
    format: "html",
  }, mockFetch as any);

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that HTML is returned as-is
  assertEquals(response.output, htmlContent);
  assertEquals(response.metadata.format, "html");
});

Deno.test("web fetch tool - handles HTTP errors", async () => {
  const mockFetch = createMockFetch({
    ok: false,
    status: 404,
    statusText: "Not Found",
  });

  // Should throw an error
  let errorThrown = false;
  try {
    await webFetchToolLogic({
      url: "https://example.com/notfound",
      format: "text",
    }, mockFetch as any);
  } catch (error) {
    errorThrown = true;
    assert(error.message.includes("Request failed with status code: 404"));
  }

  assert(errorThrown, "Expected error to be thrown");
});

Deno.test("web fetch tool - handles network errors", async () => {
  const mockFetch = createMockFetch({
    shouldThrow: true,
    throwError: new Error("Network connection failed"),
  });

  // Should throw an error
  let errorThrown = false;
  try {
    await webFetchToolLogic({
      url: "https://example.com",
      format: "text",
    }, mockFetch as any);
  } catch (error) {
    errorThrown = true;
    assert(error.message.includes("Network connection failed"));
  }

  assert(errorThrown, "Expected error to be thrown");
});

Deno.test("web fetch tool - validates URL format", async () => {
  const mockFetch = createMockFetch({
    content: "test",
  });

  // Test invalid URL (missing protocol)
  let errorThrown = false;
  try {
    await webFetchToolLogic({
      url: "example.com",
      format: "text",
    }, mockFetch as any);
  } catch (error) {
    errorThrown = true;
    assert(error.message.includes("URL must start with http:// or https://"));
  }

  assert(errorThrown, "Expected error to be thrown");
});

Deno.test("web fetch tool - handles timeout parameter", async () => {
  const mockFetch = createMockFetch({
    content: "Quick response",
    headers: { "content-type": "text/plain" },
  });

  const result = await webFetchToolLogic({
    url: "https://example.com",
    format: "text",
    timeout: 10, // 10 seconds
  }, mockFetch as any);

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that request succeeded despite timeout setting
  assertEquals(response.output, "Quick response");
});

Deno.test("web fetch tool - handles large responses", async () => {
  // Create content just under the limit
  const largeContent = "x".repeat(1024 * 1024); // 1MB
  const mockFetch = createMockFetch({
    content: largeContent,
    headers: { "content-type": "text/plain" },
  });

  const result = await webFetchToolLogic({
    url: "https://example.com",
    format: "text",
  }, mockFetch as any);

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that large content is handled
  assertEquals(response.output, largeContent);
  assertEquals(response.metadata.contentLength, 1024 * 1024);
});

Deno.test("web fetch tool - handles content-length header", async () => {
  const mockFetch = createMockFetch({
    content: "test content",
    headers: {
      "content-type": "text/plain",
      "content-length": "12",
    },
  });

  const result = await webFetchToolLogic({
    url: "https://example.com",
    format: "text",
  }, mockFetch as any);

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that content-length is handled
  assertEquals(response.output, "test content");
  assertEquals(response.metadata.contentType, "text/plain");
});

Deno.test("web fetch tool - handles missing content-type", async () => {
  const mockFetch = createMockFetch({
    content: "test content",
    headers: {}, // No content-type header
  });

  const result = await webFetchToolLogic({
    url: "https://example.com",
    format: "text",
  }, mockFetch as any);

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that missing content-type is handled
  assertEquals(response.output, "test content");
  assertEquals(response.metadata.contentType, "");
  assertEquals(response.title, "https://example.com ()");
});

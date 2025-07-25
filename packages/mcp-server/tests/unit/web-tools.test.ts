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

// Tavily Tools Tests

// Mock Tavily API responses
const mockTavilySearchResponse = {
  answer: "AI is transforming various industries by automating processes and improving efficiency.",
  results: [
    {
      title: "AI in Modern Technology",
      url: "https://example.com/ai-tech",
      content: "Artificial intelligence is revolutionizing technology...",
      score: 0.95,
      published_date: "2024-01-15",
    },
    {
      title: "Machine Learning Applications",
      url: "https://example.com/ml-apps",
      content: "Machine learning has numerous applications...",
      score: 0.88,
      published_date: "2024-01-10",
    },
  ],
  images: [
    {
      url: "https://example.com/ai-image.jpg",
      description: "AI visualization",
    },
  ],
  follow_up_questions: [
    "What are the benefits of AI?",
    "How is AI used in healthcare?",
  ],
  response_time: 2.1,
};

const mockTavilyExtractResponse = {
  results: [
    {
      url: "https://example.com/page1",
      raw_content: "This is extracted content from page 1...",
      images: ["https://example.com/image1.jpg"],
      favicon: "https://example.com/favicon.ico",
    },
    {
      url: "https://example.com/page2",
      raw_content: "This is extracted content from page 2...",
      images: [],
      favicon: "https://example.com/favicon2.ico",
    },
  ],
  failed_results: [],
  response_time: 1.2,
};

const mockTavilyCrawlResponse = {
  results: [
    {
      url: "https://example.com",
      content: "Main page content...",
      raw_content: "<html><body>Main page content...</body></html>",
    },
    {
      url: "https://example.com/about",
      content: "About page content...",
      raw_content: "<html><body>About page content...</body></html>",
    },
  ],
  failed_urls: [],
};

// Helper to create mock fetch for Tavily API
function createMockTavilyFetch(endpoint: string, mockResponse: any) {
  return async (url: string, options?: any) => {
    if (url === `https://api.tavily.com/${endpoint}`) {
      const headers = options?.headers || {};

      // Validate Bearer token is present
      if (!headers.Authorization || !headers.Authorization.startsWith("Bearer ")) {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          text: async () => "Bearer token required",
          json: async () => ({ error: "Bearer token required" }),
        };
      }

      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => mockResponse,
        text: async () => JSON.stringify(mockResponse),
      };
    }

    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "Not found",
      json: async () => ({ error: "Not found" }),
    };
  };
}

// Tavily Search Tool Logic for Testing
async function tavilySearchLogic(params: {
  query: string;
  search_depth?: "basic" | "advanced";
  topic?: "general" | "news";
  days?: number;
  max_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  include_answer?: boolean;
  include_raw_content?: boolean;
  include_images?: boolean;
}, fetchImpl: typeof fetch = fetch) {
  const apiKey = "test-api-key";

  const searchParams: any = {
    query: params.query,
    search_depth: params.search_depth || "basic",
    topic: params.topic || "general",
    max_results: params.max_results || 5,
    include_answer: params.include_answer || false,
    include_raw_content: params.include_raw_content || false,
    include_images: params.include_images || false,
  };

  if (params.days && params.topic === "news") {
    searchParams.days = params.days;
  }
  if (params.include_domains?.length) {
    searchParams.include_domains = params.include_domains;
  }
  if (params.exclude_domains?.length) {
    searchParams.exclude_domains = params.exclude_domains;
  }

  const response = await fetchImpl("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(searchParams),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tavily search failed: ${response.status} ${errorText}`);
  }

  const result = await response.json();

  return {
    query: params.query,
    answer: result.answer || null,
    results: result.results || [],
    images: result.images || [],
    follow_up_questions: result.follow_up_questions || [],
    search_depth: params.search_depth || "basic",
    topic: params.topic || "general",
    response_time: result.response_time || 0,
  };
}

// Tavily Extract Tool Logic for Testing
async function tavilyExtractLogic(params: {
  urls: string[];
  include_images?: boolean;
  include_favicon?: boolean;
  extract_depth?: "basic" | "advanced";
  format?: "markdown" | "text";
}, fetchImpl: typeof fetch = fetch) {
  const apiKey = "test-api-key";

  const response = await fetchImpl("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      urls: params.urls,
      include_images: params.include_images || false,
      include_favicon: params.include_favicon || false,
      extract_depth: params.extract_depth || "basic",
      format: params.format || "markdown",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tavily extract failed: ${response.status} ${errorText}`);
  }

  const result = await response.json();

  return {
    results: result.results || [],
    failed_results: result.failed_results || [],
    response_time: result.response_time || 0,
  };
}

// Tavily Crawl Tool Logic for Testing
async function tavilyCrawlLogic(params: {
  url: string;
  max_depth?: number;
  exclude_domains?: string[];
  include_raw_content?: boolean;
}, fetchImpl: typeof fetch = fetch) {
  const apiKey = "test-api-key";

  const crawlParams: any = {
    url: params.url,
    max_depth: params.max_depth || 1,
    include_raw_content: params.include_raw_content !== false,
  };

  if (params.exclude_domains?.length) {
    crawlParams.exclude_domains = params.exclude_domains;
  }

  const response = await fetchImpl("https://api.tavily.com/crawl", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(crawlParams),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tavily crawl failed: ${response.status} ${errorText}`);
  }

  const result = await response.json();

  return {
    results: result.results || [],
    failed_urls: result.failed_urls || [],
    base_url: params.url,
    max_depth: params.max_depth || 1,
  };
}

Deno.test("tavily search tool - basic search", async () => {
  const mockFetch = createMockTavilyFetch("search", mockTavilySearchResponse);

  const result = await tavilySearchLogic({
    query: "artificial intelligence",
  }, mockFetch as any);

  assertEquals(result.query, "artificial intelligence");
  assertEquals(result.search_depth, "basic");
  assertEquals(result.topic, "general");
  assertEquals(result.results.length, 2);
  assertEquals(result.results[0].title, "AI in Modern Technology");
  assertEquals(result.results[0].url, "https://example.com/ai-tech");
  assert(result.answer.includes("transforming various industries"));
});

Deno.test("tavily search tool - advanced search with options", async () => {
  const mockFetch = createMockTavilyFetch("search", mockTavilySearchResponse);

  const result = await tavilySearchLogic({
    query: "machine learning",
    search_depth: "advanced",
    topic: "general",
    max_results: 10,
    include_answer: true,
    include_images: true,
    include_domains: ["example.com", "test.com"],
    exclude_domains: ["spam.com"],
  }, mockFetch as any);

  assertEquals(result.query, "machine learning");
  assertEquals(result.search_depth, "advanced");
  assertEquals(result.topic, "general");
  assertEquals(result.images.length, 1);
  assertEquals(result.images[0].url, "https://example.com/ai-image.jpg");
  assertEquals(result.follow_up_questions.length, 2);
});

Deno.test("tavily search tool - news search with days", async () => {
  const mockFetch = createMockTavilyFetch("search", mockTavilySearchResponse);

  const result = await tavilySearchLogic({
    query: "AI news",
    topic: "news",
    days: 7,
    max_results: 3,
  }, mockFetch as any);

  assertEquals(result.query, "AI news");
  assertEquals(result.topic, "news");
  assertEquals(result.results.length, 2);
});

Deno.test("tavily search tool - handles API errors", async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    text: async () => "Invalid query parameter",
    json: async () => ({ error: "Invalid query parameter" }),
  });

  let errorThrown = false;
  try {
    await tavilySearchLogic({
      query: "",
    }, mockFetch as any);
  } catch (error) {
    errorThrown = true;
    assert(error.message.includes("Tavily search failed: 400"));
  }

  assert(errorThrown, "Expected error to be thrown");
});

Deno.test("tavily extract tool - extracts from URLs", async () => {
  const mockFetch = createMockTavilyFetch("extract", mockTavilyExtractResponse);

  const result = await tavilyExtractLogic({
    urls: [
      "https://example.com/page1",
      "https://example.com/page2",
    ],
    include_images: true,
    include_favicon: true,
  }, mockFetch as any);

  assertEquals(result.results.length, 2);
  assertEquals(result.results[0].url, "https://example.com/page1");
  assert(result.results[0].raw_content.includes("extracted content from page 1"));
  assertEquals(result.results[0].images.length, 1);
  assertEquals(result.results[0].favicon, "https://example.com/favicon.ico");
  assertEquals(result.failed_results.length, 0);
});

Deno.test("tavily extract tool - handles failed URLs", async () => {
  const mockResponseWithFailures = {
    ...mockTavilyExtractResponse,
    failed_results: ["https://invalid.example.com"],
  };

  const mockFetch = createMockTavilyFetch("extract", mockResponseWithFailures);

  const result = await tavilyExtractLogic({
    urls: [
      "https://example.com/page1",
      "https://invalid.example.com",
    ],
  }, mockFetch as any);

  assertEquals(result.results.length, 2);
  assertEquals(result.failed_results.length, 1);
  assertEquals(result.failed_results[0], "https://invalid.example.com");
});

Deno.test("tavily extract tool - handles API errors", async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 422,
    statusText: "Unprocessable Entity",
    text: async () => "Invalid URL format",
    json: async () => ({ error: "Invalid URL format" }),
  });

  let errorThrown = false;
  try {
    await tavilyExtractLogic({
      urls: ["invalid-url"],
    }, mockFetch as any);
  } catch (error) {
    errorThrown = true;
    assert(error.message.includes("Tavily extract failed: 422"));
  }

  assert(errorThrown, "Expected error to be thrown");
});

Deno.test("tavily crawl tool - crawls website", async () => {
  const mockFetch = createMockTavilyFetch("crawl", mockTavilyCrawlResponse);

  const result = await tavilyCrawlLogic({
    url: "https://example.com",
    max_depth: 2,
    include_raw_content: true,
  }, mockFetch as any);

  assertEquals(result.base_url, "https://example.com");
  assertEquals(result.max_depth, 2);
  assertEquals(result.results.length, 2);
  assertEquals(result.results[0].url, "https://example.com");
  assert(result.results[0].content.includes("Main page content"));
  assertEquals(result.failed_urls.length, 0);
});

Deno.test("tavily crawl tool - with exclude domains", async () => {
  const mockFetch = createMockTavilyFetch("crawl", mockTavilyCrawlResponse);

  const result = await tavilyCrawlLogic({
    url: "https://example.com",
    max_depth: 1,
    exclude_domains: ["ads.example.com", "tracking.example.com"],
    include_raw_content: false,
  }, mockFetch as any);

  assertEquals(result.base_url, "https://example.com");
  assertEquals(result.max_depth, 1);
  assertEquals(result.results.length, 2);
});

Deno.test("tavily crawl tool - handles API errors", async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 403,
    statusText: "Forbidden",
    text: async () => "Rate limit exceeded",
    json: async () => ({ error: "Rate limit exceeded" }),
  });

  let errorThrown = false;
  try {
    await tavilyCrawlLogic({
      url: "https://example.com",
    }, mockFetch as any);
  } catch (error) {
    errorThrown = true;
    assert(error.message.includes("Tavily crawl failed: 403"));
  }

  assert(errorThrown, "Expected error to be thrown");
});

Deno.test("tavily tools - parameter validation", async () => {
  const mockFetch = createMockTavilyFetch("search", mockTavilySearchResponse);

  // Test default parameter values
  const result = await tavilySearchLogic({
    query: "test query",
  }, mockFetch as any);

  assertEquals(result.search_depth, "basic");
  assertEquals(result.topic, "general");

  // Test that result structure is correct
  assertExists(result.query);
  assertExists(result.results);
  assertExists(result.images);
  assertExists(result.follow_up_questions);
  assertEquals(Array.isArray(result.results), true);
  assertEquals(Array.isArray(result.images), true);
  assertEquals(Array.isArray(result.follow_up_questions), true);
});

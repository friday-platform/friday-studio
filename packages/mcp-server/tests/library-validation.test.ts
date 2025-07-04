/**
 * Unit tests for library validation and helper functions
 * Tests the core business logic without MCP server dependencies
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { type Logger, PlatformMCPServer } from "../src/platform-server.ts";

// Mock logger
const mockLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Test helper to access private methods
class TestPlatformMCPServer extends PlatformMCPServer {
  constructor() {
    super({
      logger: mockLogger,
      daemonUrl: "http://localhost:8080",
    });
  }

  // Expose private methods for testing
  public testBuildLibraryQueryParams(options: any) {
    return (this as any).buildLibraryQueryParams(options);
  }

  public testIsRetryableError(status: number) {
    return (this as any).isRetryableError(status);
  }

  public testCalculateRetryDelay(retryCount: number) {
    return (this as any).calculateRetryDelay(retryCount);
  }
}

let testServer: TestPlatformMCPServer;

function setupTest() {
  testServer = new TestPlatformMCPServer();
}

// =====================================
// QUERY PARAMETER VALIDATION TESTS
// =====================================

Deno.test("buildLibraryQueryParams should validate limits correctly", () => {
  setupTest();

  // Valid limits
  const validParams1 = testServer.testBuildLibraryQueryParams({ limit: 1 });
  assertEquals(validParams1.get("limit"), "1");

  const validParams2 = testServer.testBuildLibraryQueryParams({ limit: 1000 });
  assertEquals(validParams2.get("limit"), "1000");

  // Invalid limits should throw
  assertThrows(
    () => testServer.testBuildLibraryQueryParams({ limit: 0 }),
    Error,
    "Limit must be between 1 and 1000",
  );

  assertThrows(
    () => testServer.testBuildLibraryQueryParams({ limit: 1001 }),
    Error,
    "Limit must be between 1 and 1000",
  );
});

Deno.test("buildLibraryQueryParams should validate offsets correctly", () => {
  setupTest();

  // Valid offsets
  const validParams1 = testServer.testBuildLibraryQueryParams({ offset: 0 });
  assertEquals(validParams1.get("offset"), "0");

  const validParams2 = testServer.testBuildLibraryQueryParams({ offset: 999 });
  assertEquals(validParams2.get("offset"), "999");

  // Invalid offset should throw
  assertThrows(
    () => testServer.testBuildLibraryQueryParams({ offset: -1 }),
    Error,
    "Offset must be non-negative",
  );
});

Deno.test("buildLibraryQueryParams should validate ISO 8601 dates", () => {
  setupTest();

  // Valid ISO 8601 dates
  const validDates = [
    "2024-01-01T00:00:00Z",
    "2024-01-01T00:00:00.000Z",
    "2024-12-31T23:59:59.999Z",
  ];

  validDates.forEach((date) => {
    const params = testServer.testBuildLibraryQueryParams({ since: date });
    assertEquals(params.get("since"), date);
  });

  // Invalid dates should throw
  const invalidDates = [
    "invalid-date",
    "2024-13-01T00:00:00Z", // Invalid month
    "2024-01-32T00:00:00Z", // Invalid day
    "2024-01-01T25:00:00Z", // Invalid hour
    "2024/01/01", // Wrong format
  ];

  invalidDates.forEach((date) => {
    assertThrows(
      () => testServer.testBuildLibraryQueryParams({ since: date }),
      Error,
      "Invalid since date",
    );
  });
});

Deno.test("buildLibraryQueryParams should validate date ranges", () => {
  setupTest();

  // Valid date range
  const validParams = testServer.testBuildLibraryQueryParams({
    since: "2024-01-01T00:00:00Z",
    until: "2024-12-31T23:59:59Z",
  });
  assertEquals(validParams.get("since"), "2024-01-01T00:00:00Z");
  assertEquals(validParams.get("until"), "2024-12-31T23:59:59Z");

  // Invalid date range (since >= until)
  assertThrows(
    () =>
      testServer.testBuildLibraryQueryParams({
        since: "2024-12-31T23:59:59Z",
        until: "2024-01-01T00:00:00Z",
      }),
    Error,
    "Since date must be before until date",
  );

  // Same date should also fail
  assertThrows(
    () =>
      testServer.testBuildLibraryQueryParams({
        since: "2024-01-01T00:00:00Z",
        until: "2024-01-01T00:00:00Z",
      }),
    Error,
    "Since date must be before until date",
  );
});

Deno.test("buildLibraryQueryParams should validate query strings", () => {
  setupTest();

  // Valid query strings
  const validParams1 = testServer.testBuildLibraryQueryParams({ query: "test query" });
  assertEquals(validParams1.get("q"), "test query");

  const validParams2 = testServer.testBuildLibraryQueryParams({ query: "a".repeat(1000) });
  assertEquals(validParams2.get("q"), "a".repeat(1000));

  // Empty/whitespace query should throw
  assertThrows(
    () => testServer.testBuildLibraryQueryParams({ query: "" }),
    Error,
    "Query string cannot be empty",
  );

  assertThrows(
    () => testServer.testBuildLibraryQueryParams({ query: "   " }),
    Error,
    "Query string cannot be empty",
  );

  // Oversized query should throw
  assertThrows(
    () => testServer.testBuildLibraryQueryParams({ query: "a".repeat(1001) }),
    Error,
    "Query string cannot exceed 1000 characters",
  );
});

Deno.test("buildLibraryQueryParams should normalize arrays correctly", () => {
  setupTest();

  // Valid arrays
  const validParams1 = testServer.testBuildLibraryQueryParams({
    type: ["Report", "TEMPLATE", "session_Archive"],
    tags: ["Test", "PRODUCTION", "analytics"],
  });
  assertEquals(validParams1.get("type"), "report,template,session_archive");
  assertEquals(validParams1.get("tags"), "test,production,analytics");

  // Empty/invalid arrays should throw
  assertThrows(
    () => testServer.testBuildLibraryQueryParams({ type: ["", "  "] }),
    Error,
    "At least one valid type must be specified",
  );

  assertThrows(
    () => testServer.testBuildLibraryQueryParams({ tags: ["", "  "] }),
    Error,
    "At least one valid tag must be specified",
  );

  // Too many items should throw
  const manyTypes = Array(21).fill("type").map((t, i) => `${t}${i}`);
  assertThrows(
    () => testServer.testBuildLibraryQueryParams({ type: manyTypes }),
    Error,
    "Cannot specify more than 20 types",
  );

  const manyTags = Array(51).fill("tag").map((t, i) => `${t}${i}`);
  assertThrows(
    () => testServer.testBuildLibraryQueryParams({ tags: manyTags }),
    Error,
    "Cannot specify more than 50 tags",
  );
});

Deno.test("buildLibraryQueryParams should handle special characters in queries", () => {
  setupTest();

  const specialCharQueries = [
    "test & query with special chars: @#$%",
    "unicode: 测试中文查询",
    "emoji: 🚀📊💾",
    "symbols: <>[]{}|\\`~",
  ];

  specialCharQueries.forEach((query) => {
    const params = testServer.testBuildLibraryQueryParams({ query });
    assertEquals(params.get("q"), query);
  });
});

// =====================================
// RETRY LOGIC TESTS
// =====================================

Deno.test("isRetryableError should identify retryable status codes", () => {
  setupTest();

  // Retryable errors
  const retryableStatuses = [408, 429, 500, 502, 503, 504, 599];
  retryableStatuses.forEach((status) => {
    assertEquals(testServer.testIsRetryableError(status), true);
  });

  // Non-retryable errors
  const nonRetryableStatuses = [400, 401, 403, 404, 422];
  nonRetryableStatuses.forEach((status) => {
    assertEquals(testServer.testIsRetryableError(status), false);
  });
});

Deno.test("calculateRetryDelay should implement exponential backoff", () => {
  setupTest();

  // Test exponential backoff progression
  const delay0 = testServer.testCalculateRetryDelay(0);
  const delay1 = testServer.testCalculateRetryDelay(1);
  const delay2 = testServer.testCalculateRetryDelay(2);

  // Should roughly double each time (with jitter)
  assertEquals(delay0 >= 700, true); // ~1000ms with jitter
  assertEquals(delay0 <= 1300, true);

  assertEquals(delay1 >= 1400, true); // ~2000ms with jitter
  assertEquals(delay1 <= 2600, true);

  assertEquals(delay2 >= 2800, true); // ~4000ms with jitter
  assertEquals(delay2 <= 5200, true);

  // Should cap at 30 seconds
  const longDelay = testServer.testCalculateRetryDelay(10);
  assertEquals(longDelay <= 30000, true);
});

// =====================================
// PARAMETER COMBINATION TESTS
// =====================================

Deno.test("buildLibraryQueryParams should handle complex valid combinations", () => {
  setupTest();

  const complexParams = testServer.testBuildLibraryQueryParams({
    query: "complex search with multiple terms",
    type: ["report", "template", "session_archive"],
    tags: ["production", "test", "analytics"],
    since: "2024-01-01T00:00:00Z",
    until: "2024-12-31T23:59:59Z",
    limit: 100,
    offset: 50,
  });

  assertEquals(complexParams.get("q"), "complex search with multiple terms");
  assertEquals(complexParams.get("type"), "report,template,session_archive");
  assertEquals(complexParams.get("tags"), "production,test,analytics");
  assertEquals(complexParams.get("since"), "2024-01-01T00:00:00Z");
  assertEquals(complexParams.get("until"), "2024-12-31T23:59:59Z");
  assertEquals(complexParams.get("limit"), "100");
  assertEquals(complexParams.get("offset"), "50");
});

Deno.test("buildLibraryQueryParams should handle minimal valid parameters", () => {
  setupTest();

  const minimalParams = testServer.testBuildLibraryQueryParams({});

  // Should not set any parameters for empty input
  assertEquals(minimalParams.toString(), "");
});

// =====================================
// EDGE CASE BOUNDARY TESTS
// =====================================

Deno.test("buildLibraryQueryParams should handle boundary values correctly", () => {
  setupTest();

  // Test exact boundary values
  const boundaryParams = testServer.testBuildLibraryQueryParams({
    limit: 1, // Minimum valid limit
    offset: 0, // Minimum valid offset
    query: "a", // Minimum valid query length
    type: ["x"], // Minimum valid type array
    tags: ["y"], // Minimum valid tag array
  });

  assertEquals(boundaryParams.get("limit"), "1");
  assertEquals(boundaryParams.get("offset"), "0");
  assertEquals(boundaryParams.get("q"), "a");
  assertEquals(boundaryParams.get("type"), "x");
  assertEquals(boundaryParams.get("tags"), "y");

  // Test maximum boundary values
  const maxBoundaryParams = testServer.testBuildLibraryQueryParams({
    limit: 1000, // Maximum valid limit
    query: "a".repeat(1000), // Maximum valid query length
    type: Array(20).fill("type").map((t, i) => `${t}${i}`), // Maximum valid type array
    tags: Array(50).fill("tag").map((t, i) => `${t}${i}`), // Maximum valid tag array
  });

  assertEquals(maxBoundaryParams.get("limit"), "1000");
  assertEquals(maxBoundaryParams.get("q"), "a".repeat(1000));
  assertEquals(maxBoundaryParams.get("type")?.split(",").length, 20);
  assertEquals(maxBoundaryParams.get("tags")?.split(",").length, 50);
});

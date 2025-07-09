/**
 * Unit tests for library validation and helper functions
 * Tests the core business logic without MCP server dependencies
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  buildLibraryQueryParams,
  calculateRetryDelay,
  isRetryableError,
} from "../src/tools/utils.ts";

// =====================================
// QUERY PARAMETER VALIDATION TESTS
// =====================================

Deno.test("buildLibraryQueryParams should validate limits correctly", () => {
  // Valid limits
  const validParams1 = buildLibraryQueryParams({ limit: 1 });
  assertEquals(validParams1.get("limit"), "1");

  const validParams2 = buildLibraryQueryParams({ limit: 1000 });
  assertEquals(validParams2.get("limit"), "1000");

  // Invalid limits should throw
  assertThrows(
    () => buildLibraryQueryParams({ limit: 0 }),
    Error,
    "Limit must be between 1 and 1000",
  );

  assertThrows(
    () => buildLibraryQueryParams({ limit: 1001 }),
    Error,
    "Limit must be between 1 and 1000",
  );
});

Deno.test("buildLibraryQueryParams should validate offsets correctly", () => {
  // Valid offsets
  const validParams1 = buildLibraryQueryParams({ offset: 0 });
  assertEquals(validParams1.get("offset"), "0");

  const validParams2 = buildLibraryQueryParams({ offset: 999 });
  assertEquals(validParams2.get("offset"), "999");

  // Invalid offset should throw
  assertThrows(
    () => buildLibraryQueryParams({ offset: -1 }),
    Error,
    "Offset must be non-negative",
  );
});

Deno.test("buildLibraryQueryParams should validate ISO 8601 dates", () => {
  // Valid ISO 8601 dates
  const validDates = [
    "2024-01-01T00:00:00Z",
    "2024-01-01T00:00:00.000Z",
    "2024-12-31T23:59:59.999Z",
  ];

  validDates.forEach((date) => {
    const params = buildLibraryQueryParams({ since: date });
    // The function converts dates to ISO strings
    const expectedDate = new Date(date).toISOString();
    assertEquals(params.get("since"), expectedDate);
  });

  // Invalid dates should throw
  const invalidDates = [
    "invalid-date",
    "2024-13-01T00:00:00Z", // Invalid month
    "2024-01-32T00:00:00Z", // Invalid day
    "2024-01-01T25:00:00Z", // Invalid hour
  ];

  invalidDates.forEach((date) => {
    assertThrows(
      () => buildLibraryQueryParams({ since: date }),
      Error,
      "Invalid since date format. Use ISO 8601 format",
    );
  });
});

Deno.test("buildLibraryQueryParams should validate date ranges", () => {
  // Valid date range
  const validParams = buildLibraryQueryParams({
    since: "2024-01-01T00:00:00Z",
    until: "2024-12-31T23:59:59Z",
  });
  // Dates are converted to ISO strings
  assertEquals(validParams.get("since"), new Date("2024-01-01T00:00:00Z").toISOString());
  assertEquals(validParams.get("until"), new Date("2024-12-31T23:59:59Z").toISOString());

  // Invalid date range (since >= until)
  assertThrows(
    () =>
      buildLibraryQueryParams({
        since: "2024-12-31T23:59:59Z",
        until: "2024-01-01T00:00:00Z",
      }),
    Error,
    "'since' date must be before 'until' date",
  );

  // Same date should also fail
  assertThrows(
    () =>
      buildLibraryQueryParams({
        since: "2024-01-01T00:00:00Z",
        until: "2024-01-01T00:00:00Z",
      }),
    Error,
    "'since' date must be before 'until' date",
  );
});

Deno.test("buildLibraryQueryParams should validate query strings", () => {
  // Valid query strings
  const validParams1 = buildLibraryQueryParams({ query: "test query" });
  assertEquals(validParams1.get("q"), "test query");

  const validParams2 = buildLibraryQueryParams({ query: "a".repeat(1000) });
  assertEquals(validParams2.get("q"), "a".repeat(1000));

  // Empty/whitespace query doesn't throw - it's just not set
  const emptyQueryParams = buildLibraryQueryParams({ query: "" });
  assertEquals(emptyQueryParams.has("q"), false, "Empty query should not be set");

  const whitespaceQueryParams = buildLibraryQueryParams({ query: "   " });
  assertEquals(whitespaceQueryParams.get("q"), "   ", "Whitespace query should be preserved");

  // Oversized query should throw
  assertThrows(
    () => buildLibraryQueryParams({ query: "a".repeat(1001) }),
    Error,
    "Query string too long (max 1000 characters)",
  );
});

Deno.test("buildLibraryQueryParams should normalize arrays correctly", () => {
  // Valid arrays
  const validParams1 = buildLibraryQueryParams({
    type: ["Report", "TEMPLATE", "session_Archive"],
    tags: ["Test", "PRODUCTION", "analytics"],
  });
  assertEquals(validParams1.get("type"), "report,template,session_archive");
  assertEquals(validParams1.get("tags"), "test,production,analytics");

  // Empty arrays are handled by normalizing (lowercasing) and joining
  const emptyArrayParams = buildLibraryQueryParams({ type: ["", "  "] });
  assertEquals(
    emptyArrayParams.get("type"),
    ",  ",
    "Empty array items should still be joined with whitespace preserved",
  );

  const emptyTagsParams = buildLibraryQueryParams({ tags: ["", "  "] });
  assertEquals(
    emptyTagsParams.get("tags"),
    ",  ",
    "Empty tag items should still be joined with whitespace preserved",
  );

  // Too many items should throw
  const manyTypes = Array(21).fill("type").map((t, i) => `${t}${i}`);
  assertThrows(
    () => buildLibraryQueryParams({ type: manyTypes }),
    Error,
    "Too many type filters (max 20)",
  );

  const manyTags = Array(51).fill("tag").map((t, i) => `${t}${i}`);
  assertThrows(
    () => buildLibraryQueryParams({ tags: manyTags }),
    Error,
    "Too many tag filters (max 50)",
  );
});

Deno.test("buildLibraryQueryParams should handle special characters in queries", () => {
  const specialCharQueries = [
    "test & query with special chars: @#$%",
    "unicode: 测试中文查询",
    "emoji: 🚀📊💾",
    "symbols: <>[]{}|\\`~",
  ];

  specialCharQueries.forEach((query) => {
    const params = buildLibraryQueryParams({ query });
    assertEquals(params.get("q"), query);
  });
});

// =====================================
// RETRY LOGIC TESTS
// =====================================

Deno.test("isRetryableError should identify retryable status codes", () => {
  // Retryable errors
  const retryableStatuses = [408, 429, 500, 502, 503, 504, 599];
  retryableStatuses.forEach((status) => {
    assertEquals(isRetryableError(status), true);
  });

  // Non-retryable errors
  const nonRetryableStatuses = [400, 401, 403, 404, 422];
  nonRetryableStatuses.forEach((status) => {
    assertEquals(isRetryableError(status), false);
  });
});

Deno.test("calculateRetryDelay should implement exponential backoff", () => {
  // Test exponential backoff progression
  const delay0 = calculateRetryDelay(0);
  const delay1 = calculateRetryDelay(1);
  const delay2 = calculateRetryDelay(2);

  // Should roughly double each time (with jitter)
  assertEquals(delay0 >= 700, true); // ~1000ms with jitter
  assertEquals(delay0 <= 1300, true);

  assertEquals(delay1 >= 1400, true); // ~2000ms with jitter
  assertEquals(delay1 <= 2600, true);

  assertEquals(delay2 >= 2800, true); // ~4000ms with jitter
  assertEquals(delay2 <= 5200, true);

  // Should cap at 30 seconds
  const longDelay = calculateRetryDelay(10);
  assertEquals(longDelay <= 30000, true);
});

// =====================================
// PARAMETER COMBINATION TESTS
// =====================================

Deno.test("buildLibraryQueryParams should handle complex valid combinations", () => {
  const complexParams = buildLibraryQueryParams({
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
  // Dates are converted to ISO strings
  assertEquals(complexParams.get("since"), new Date("2024-01-01T00:00:00Z").toISOString());
  assertEquals(complexParams.get("until"), new Date("2024-12-31T23:59:59Z").toISOString());
  assertEquals(complexParams.get("limit"), "100");
  assertEquals(complexParams.get("offset"), "50");
});

Deno.test("buildLibraryQueryParams should handle minimal valid parameters", () => {
  const minimalParams = buildLibraryQueryParams({});

  // Should not set any parameters for empty input
  assertEquals(minimalParams.toString(), "");
});

// =====================================
// EDGE CASE BOUNDARY TESTS
// =====================================

Deno.test("buildLibraryQueryParams should handle boundary values correctly", () => {
  // Test exact boundary values
  const boundaryParams = buildLibraryQueryParams({
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
  const maxBoundaryParams = buildLibraryQueryParams({
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

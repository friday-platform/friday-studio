/**
 * Unit tests for job discoverability logic
 * Tests the pattern matching and filtering logic in isolation
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

/**
 * Extracted job discoverability logic for unit testing
 * This mirrors the logic in Platform MCP Server
 */
function checkJobDiscoverableSync(discoverableJobs: string[], jobName: string): boolean {
  // Check if job matches any discoverable pattern
  for (const pattern of discoverableJobs) {
    const isWildcard = pattern.endsWith("*");
    const basePattern = isWildcard ? pattern.slice(0, -1) : pattern;

    if (isWildcard ? jobName.startsWith(basePattern) : jobName === pattern) {
      return true;
    }
  }

  return false;
}

Deno.test("Job Discoverability Pattern Matching", async (t) => {
  await t.step("Exact matches work correctly", () => {
    const discoverableJobs = ["telephone", "admin_task", "public_demo"];

    assertEquals(checkJobDiscoverableSync(discoverableJobs, "telephone"), true);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "admin_task"), true);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "public_demo"), true);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "telephone_not"), false);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "random_job"), false);
  });

  await t.step("Wildcard patterns work correctly", () => {
    const discoverableJobs = ["public_*", "admin_*"];

    assertEquals(checkJobDiscoverableSync(discoverableJobs, "public_test"), true);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "public_demo"), true);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "public_"), true); // Edge case
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "admin_cleanup"), true);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "admin_backup"), true);

    assertEquals(checkJobDiscoverableSync(discoverableJobs, "private_test"), false);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "user_task"), false);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "publictest"), false); // No underscore
  });

  await t.step("Mixed exact and wildcard patterns", () => {
    const discoverableJobs = ["telephone", "public_*", "exact_match"];

    assertEquals(checkJobDiscoverableSync(discoverableJobs, "telephone"), true);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "exact_match"), true);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "public_anything"), true);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "public_"), true);

    assertEquals(checkJobDiscoverableSync(discoverableJobs, "telephone_extended"), false);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "exact_match_not"), false);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "private_secret"), false);
  });

  await t.step("Empty discoverable list blocks everything", () => {
    const discoverableJobs: string[] = [];

    assertEquals(checkJobDiscoverableSync(discoverableJobs, "any_job"), false);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "public_test"), false);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "admin_task"), false);
  });

  await t.step("Complex patterns", () => {
    const discoverableJobs = ["test_*_end", "*_middle_*", "start_*"];

    // Note: Our current implementation only supports suffix wildcards (pattern*)
    // These complex patterns would need enhanced logic
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "test_something_end"), false); // Current logic doesn't support this
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "start_anything"), true);

    // Only suffix wildcards work with current implementation
    assertEquals(checkJobDiscoverableSync(["*_suffix"], "prefix_suffix"), false); // Prefix wildcards not supported
  });

  await t.step("Edge cases", () => {
    const _discoverableJobs = ["*", "", "a*", "*a"];

    assertEquals(checkJobDiscoverableSync(["*"], "anything"), true); // Global wildcard
    assertEquals(checkJobDiscoverableSync([""], ""), true); // Empty exact match
    assertEquals(checkJobDiscoverableSync([""], "nonempty"), false);
    assertEquals(checkJobDiscoverableSync(["a*"], "abc"), true);
    assertEquals(checkJobDiscoverableSync(["a*"], "a"), true);
    assertEquals(checkJobDiscoverableSync(["a*"], "bcd"), false);

    // Prefix wildcards not supported by current implementation
    assertEquals(checkJobDiscoverableSync(["*a"], "ba"), false);
  });

  await t.step("Case sensitivity", () => {
    const discoverableJobs = ["Public_*", "ADMIN_*", "telephone"];

    // Pattern matching should be case-sensitive
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "Public_test"), true);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "public_test"), false);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "ADMIN_task"), true);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "admin_task"), false);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "telephone"), true);
    assertEquals(checkJobDiscoverableSync(discoverableJobs, "TELEPHONE"), false);
  });
});

// Test the actual filtering function that would be used in workspace_jobs_list
function filterJobsByDiscoverability(
  allJobs: Array<{ name: string; description?: string }>,
  discoverableJobs: string[],
): Array<{ name: string; description?: string }> {
  return allJobs.filter((job) => checkJobDiscoverableSync(discoverableJobs, job.name));
}

Deno.test("Job List Filtering", async (t) => {
  const allJobs = [
    { name: "telephone", description: "Telephone game" },
    { name: "public_demo", description: "Public demo" },
    { name: "public_test", description: "Public test" },
    { name: "admin_cleanup", description: "Admin cleanup" },
    { name: "private_secret", description: "Private secret" },
    { name: "user_task", description: "User task" },
  ];

  await t.step("Filter with exact matches", () => {
    const discoverableJobs = ["telephone", "admin_cleanup"];
    const filtered = filterJobsByDiscoverability(allJobs, discoverableJobs);

    assertEquals(filtered.length, 2);
    assertEquals(filtered.map((j) => j.name).sort(), ["admin_cleanup", "telephone"]);
  });

  await t.step("Filter with wildcard patterns", () => {
    const discoverableJobs = ["public_*"];
    const filtered = filterJobsByDiscoverability(allJobs, discoverableJobs);

    assertEquals(filtered.length, 2);
    assertEquals(filtered.map((j) => j.name).sort(), ["public_demo", "public_test"]);
  });

  await t.step("Filter with mixed patterns", () => {
    const discoverableJobs = ["telephone", "public_*"];
    const filtered = filterJobsByDiscoverability(allJobs, discoverableJobs);

    assertEquals(filtered.length, 3);
    assertEquals(filtered.map((j) => j.name).sort(), ["public_demo", "public_test", "telephone"]);
  });

  await t.step("Filter with no matches", () => {
    const discoverableJobs = ["nonexistent", "missing_*"];
    const filtered = filterJobsByDiscoverability(allJobs, discoverableJobs);

    assertEquals(filtered.length, 0);
  });

  await t.step("Filter with empty discoverable list", () => {
    const discoverableJobs: string[] = [];
    const filtered = filterJobsByDiscoverability(allJobs, discoverableJobs);

    assertEquals(filtered.length, 0);
  });

  await t.step("Filter with global wildcard", () => {
    const discoverableJobs = ["*"];
    const filtered = filterJobsByDiscoverability(allJobs, discoverableJobs);

    assertEquals(filtered.length, allJobs.length);
  });
});

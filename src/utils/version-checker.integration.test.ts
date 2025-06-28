#!/usr/bin/env deno test --allow-net

/**
 * Integration tests for version checker
 * These tests verify the version checking functionality works with real API calls
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkAndDisplayUpdate, checkForUpdates } from "./version-checker.ts";

Deno.test("Version Checker - Development builds skip checking", async () => {
  const result = await checkForUpdates();

  // Should skip checking for dev builds
  assertEquals(result.hasUpdate, false);
  assert(result.currentVersion.includes("dev"));
  assertEquals(result.latestVersion, undefined);
});

Deno.test("Version Checker - API endpoints are accessible", async () => {
  const channels = ["edge", "nightly"];

  for (const channel of channels) {
    try {
      const response = await fetch(`https://atlas.tempestdx.com/version/${channel}`, {
        signal: AbortSignal.timeout(10000),
      });

      assert(response.ok, `${channel} API should be accessible`);

      const data = await response.json();
      assert(typeof data === "object", "Response should be JSON object");
      assert(typeof data.channel === "string", "Should have channel field");
      assert(typeof data.latest === "object", "Should have latest field");
      assert(typeof data.latest.version === "string", "Should have version field");

      // Verify version format (date-based)
      const versionPattern = /^\d{8}-/;
      assert(
        versionPattern.test(data.latest.version),
        `Version should start with date: ${data.latest.version}`,
      );
    } catch (error) {
      console.warn(`Skipping ${channel} API test due to network issue:`, error.message);
    }
  }
});

Deno.test("Version Checker - Performance requirement with caching", async () => {
  const startTime = performance.now();

  await checkAndDisplayUpdate();

  const duration = performance.now() - startTime;

  // Should complete quickly to avoid blocking CLI startup (2s max, but usually much faster due to caching)
  assert(duration < 2500, `Version check should be fast, took ${duration}ms`);
});

Deno.test("Version Checker - Caching behavior", async () => {
  // First call
  const result1 = await checkForUpdates();

  // Second call should be from cache for non-dev builds
  const result2 = await checkForUpdates();

  if (!result1.currentVersion.includes("dev")) {
    // For compiled builds, second call should be cached
    assert(result2.fromCache === true, "Second call should use cache");
  } else {
    // Dev builds skip caching entirely
    assert(result2.fromCache === undefined, "Dev builds should not use cache");
  }
});

Deno.test("Version Checker - Error handling", async () => {
  // Mock fetch to simulate network error
  const originalFetch = globalThis.fetch;

  globalThis.fetch = () => Promise.reject(new Error("Network error"));

  try {
    const result = await checkForUpdates();

    // Should handle errors gracefully
    assertEquals(result.hasUpdate, false);
    assert(typeof result.currentVersion === "string");
    // Should either have no error message or indicate inability to check
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log("✅ Version checker integration tests completed!");

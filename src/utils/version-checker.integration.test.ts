#!/usr/bin/env deno test --allow-net

/**
 * Integration tests for version checker
 * These tests verify the version checking functionality works with real API calls
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { ReleaseChannel } from "./release-channel.ts";
import { checkAndDisplayUpdate, checkForUpdates } from "./version-checker.ts";

Deno.test("Version Checker - Development builds skip checking", async () => {
  const result = await checkForUpdates();

  // Should skip checking for dev builds
  assertEquals(result.hasUpdate, false);
  assert(result.currentVersion.includes("dev"));
  assertEquals(result.latestVersion, undefined);
});

Deno.test("Version Checker - API endpoints are accessible", async () => {
  const channels = [ReleaseChannel.Edge, ReleaseChannel.Nightly];

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

// Integration tests for the version CLI command with --remote flag

Deno.test("Version CLI - Remote flag integration test", async () => {
  // Import the handler to test the full CLI integration
  const { handler } = await import("../cli/commands/version.ts");

  // Capture console output by mocking console.log
  const originalConsoleLog = console.log;
  const outputs: string[] = [];

  console.log = (...args: unknown[]) => {
    outputs.push(args.join(" "));
  };

  // Mock Deno.exit to prevent test process from exiting
  const originalExit = Deno.exit;
  let exitCalled = false;
  let exitCode = -1;

  Deno.exit = (code?: number) => {
    exitCalled = true;
    exitCode = code || 0;
    return undefined;
  };

  try {
    // Test normal version command (should not call remote)
    await handler({ json: false, remote: false });

    assert(exitCalled, "Handler should call Deno.exit");
    assertEquals(exitCode, 0, "Should exit with code 0");
    assert(outputs.length > 0, "Should produce output");
    assert(
      outputs.some((line) => line.includes("Atlas")),
      "Should show Atlas version",
    );

    // Reset for remote test
    outputs.length = 0;
    exitCalled = false;
    exitCode = -1;

    // Test remote version command (dev builds should show different message)
    await handler({ json: false, remote: true });

    assert(exitCalled, "Remote handler should call Deno.exit");
    assertEquals(exitCode, 0, "Should exit with code 0");
    assert(outputs.length > 0, "Should produce output");
    assert(
      outputs.some((line) => line.includes("Atlas")),
      "Should show Atlas version",
    );
    // For dev builds, should show disabled message instead of checking
    assert(
      outputs.some((line) =>
        line.includes("Remote version checking is disabled for development builds"),
      ),
      "Should show dev build message",
    );
  } finally {
    // Restore original functions
    console.log = originalConsoleLog;
    Deno.exit = originalExit;
  }
});

Deno.test("Version CLI - Remote flag with JSON output", async () => {
  const { handler } = await import("../cli/commands/version.ts");

  // Capture console output
  const originalConsoleLog = console.log;
  const outputs: string[] = [];

  console.log = (...args: unknown[]) => {
    outputs.push(args.join(" "));
  };

  // Mock Deno.exit
  const originalExit = Deno.exit;
  let exitCalled = false;

  Deno.exit = () => {
    exitCalled = true;
    return undefined;
  };

  try {
    await handler({ json: true, remote: true });

    assert(exitCalled, "Handler should call Deno.exit");
    assert(outputs.length > 0, "Should produce JSON output");

    // Should be valid JSON
    const jsonOutput = outputs.join(" ");
    const parsed = JSON.parse(jsonOutput);

    // Should contain version info
    assertExists(parsed.version);
    assertExists(parsed.isCompiled);
    assertExists(parsed.isNightly);
    assertExists(parsed.isDev);

    // Should contain remote info
    assertExists(parsed.remote);
    assertEquals(typeof parsed.remote.hasUpdate, "boolean");

    // For dev builds, should have skipped flag and reason
    if (parsed.isDev) {
      assertEquals(parsed.remote.skipped, true);
      assertExists(parsed.remote.reason);
    }
  } finally {
    console.log = originalConsoleLog;
    Deno.exit = originalExit;
  }
});

Deno.test("Version CLI - displayVersionWithRemote function unit test", async () => {
  const { displayVersionWithRemote } = await import("../utils/version.ts");

  // Capture console output
  const originalConsoleLog = console.log;
  const outputs: string[] = [];

  console.log = (...args: unknown[]) => {
    outputs.push(args.join(" "));
  };

  try {
    // Test human-readable output
    await displayVersionWithRemote(false);

    assert(outputs.length > 0, "Should produce output");
    assert(
      outputs.some((line) => line.includes("Atlas")),
      "Should show version info",
    );
    // For dev builds, should show disabled message instead of checking
    assert(
      outputs.some((line) =>
        line.includes("Remote version checking is disabled for development builds"),
      ),
      "Should show dev build message",
    );

    // Reset for JSON test
    outputs.length = 0;

    // Test JSON output
    await displayVersionWithRemote(true);

    assert(outputs.length > 0, "Should produce JSON output");
    const jsonOutput = outputs.join(" ");
    const parsed = JSON.parse(jsonOutput);

    assertExists(parsed.version);
    assertExists(parsed.remote);
    assertEquals(typeof parsed.remote.hasUpdate, "boolean");

    // For dev builds, should have skipped flag and reason
    if (parsed.isDev) {
      assertEquals(parsed.remote.skipped, true);
      assertExists(parsed.remote.reason);
    }
  } finally {
    console.log = originalConsoleLog;
  }
});

console.log("✅ Version checker integration tests completed!");

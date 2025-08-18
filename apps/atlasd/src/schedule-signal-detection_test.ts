/**
 * Schedule Signal Detection Tests
 *
 * Tests to ensure scheduled signals are properly detected and registered
 * from workspace configurations. This prevents regression of the bug where
 * signals with provider:"schedule" were not being registered due to checking
 * the wrong config path.
 */

import { assertEquals } from "@std/assert";

// Define proper type for signal config
interface SignalConfig {
  provider: string;
  config?: {
    schedule?: string | number; // Can be string (valid) or other type (invalid for testing)
    timezone?: string;
    path?: string; // For HTTP provider
    method?: string; // For HTTP provider
  } | null;
}

// Helper to check if a signal should be registered as a timer
function shouldRegisterAsTimer(signalConfig: SignalConfig): boolean {
  // This mirrors the logic in atlas-daemon.ts
  if (
    signalConfig.provider === "schedule" &&
    "config" in signalConfig &&
    signalConfig.config &&
    "schedule" in signalConfig.config &&
    typeof signalConfig.config.schedule === "string"
  ) {
    return true;
  }
  return false;
}

Deno.test("Schedule Signal Detection", async (t) => {
  await t.step("should detect schedule signals with correct config path", () => {
    // This is the actual structure from workspace.yml
    const signalConfig = {
      provider: "schedule",
      config: {
        schedule: "0 9 * * *",
        timezone: "America/Los_Angeles",
      },
    };

    const shouldRegister = shouldRegisterAsTimer(signalConfig);
    assertEquals(
      shouldRegister,
      true,
      "Should detect schedule signal with config.schedule structure",
    );
  });

  await t.step("should NOT detect schedule signals with incorrect path", () => {
    // This was the bug - checking signalConfig.schedule instead of signalConfig.config.schedule
    const signalConfig = {
      provider: "schedule",
      schedule: "0 9 * * *", // Wrong location
      timezone: "America/Los_Angeles",
    };

    const shouldRegister = shouldRegisterAsTimer(signalConfig);
    assertEquals(
      shouldRegister,
      false,
      "Should NOT detect schedule signal with schedule at wrong path",
    );
  });

  await t.step("should handle http provider signals correctly", () => {
    const signalConfig = {
      provider: "http",
      config: {
        path: "/webhook",
        method: "POST",
      },
    };

    const shouldRegister = shouldRegisterAsTimer(signalConfig);
    assertEquals(
      shouldRegister,
      false,
      "Should NOT register http provider as timer",
    );
  });

  await t.step("should handle missing config object", () => {
    const signalConfig = {
      provider: "schedule",
      // config is missing entirely
    };

    const shouldRegister = shouldRegisterAsTimer(signalConfig);
    assertEquals(
      shouldRegister,
      false,
      "Should NOT register when config object is missing",
    );
  });

  await t.step("should handle null config", () => {
    const signalConfig = {
      provider: "schedule",
      config: null,
    };

    const shouldRegister = shouldRegisterAsTimer(signalConfig);
    assertEquals(
      shouldRegister,
      false,
      "Should NOT register when config is null",
    );
  });

  await t.step("should handle config without schedule property", () => {
    const signalConfig = {
      provider: "schedule",
      config: {
        timezone: "America/Los_Angeles",
        // schedule is missing
      },
    };

    const shouldRegister = shouldRegisterAsTimer(signalConfig);
    assertEquals(
      shouldRegister,
      false,
      "Should NOT register when schedule property is missing",
    );
  });

  await t.step("should handle non-string schedule value", () => {
    const signalConfig = {
      provider: "schedule",
      config: {
        schedule: 123, // Not a string
        timezone: "America/Los_Angeles",
      },
    };

    const shouldRegister = shouldRegisterAsTimer(signalConfig);
    assertEquals(
      shouldRegister,
      false,
      "Should NOT register when schedule is not a string",
    );
  });

  await t.step("should extract schedule and timezone correctly", () => {
    const signalConfig = {
      provider: "schedule",
      config: {
        schedule: "0 9 * * *",
        timezone: "America/Los_Angeles",
      },
    };

    if (shouldRegisterAsTimer(signalConfig)) {
      // Extract values as done in atlas-daemon.ts
      const schedule = signalConfig.config.schedule;
      const timezone = signalConfig.config?.timezone || "UTC";

      assertEquals(schedule, "0 9 * * *", "Should extract correct schedule");
      assertEquals(
        timezone,
        "America/Los_Angeles",
        "Should extract correct timezone",
      );
    }
  });

  await t.step("should use UTC as default timezone", () => {
    const signalConfig: SignalConfig = {
      provider: "schedule",
      config: {
        schedule: "0 9 * * *",
        // No timezone specified
      },
    };

    if (shouldRegisterAsTimer(signalConfig)) {
      const timezone = signalConfig.config?.timezone || "UTC";
      assertEquals(timezone, "UTC", "Should default to UTC when timezone not specified");
    }
  });
});

Deno.test("Signal Type Compatibility", async (t) => {
  await t.step("should handle CronTimerSignalPayload spread correctly", () => {
    // This tests the spread operator solution
    // Testing the spread operator solution for type compatibility
    // This interface matches what's in packages/cron/src/cron-manager.ts

    const signalData = {
      id: "test-signal",
      type: "timer",
      timestamp: new Date().toISOString(),
      data: {
        scheduled: "0 9 * * *",
        timezone: "America/Los_Angeles",
        nextRun: "2025-01-20T17:00:00.000Z",
        source: "cron-manager" as const,
      },
    };

    // Test that spread operator preserves all properties
    const spreadData = { ...signalData.data };

    assertEquals(
      spreadData.scheduled,
      signalData.data.scheduled,
      "Spread should preserve scheduled property",
    );
    assertEquals(
      spreadData.timezone,
      signalData.data.timezone,
      "Spread should preserve timezone property",
    );
    assertEquals(
      spreadData.nextRun,
      signalData.data.nextRun,
      "Spread should preserve nextRun property",
    );
    assertEquals(
      spreadData.source,
      signalData.data.source,
      "Spread should preserve source property",
    );

    // Test that spread creates a plain object (satisfies Record<string, unknown>)
    const isPlainObject = Object.getPrototypeOf(spreadData) === Object.prototype;
    assertEquals(
      isPlainObject,
      true,
      "Spread should create a plain object",
    );
  });

  await t.step("should maintain type compatibility with triggerSignal", () => {
    // Simulate triggerSignal parameter type
    function acceptsRecord(payload?: Record<string, unknown>): boolean {
      return payload !== undefined;
    }

    const signalPayload = {
      scheduled: "0 9 * * *",
      timezone: "UTC",
      nextRun: "2025-01-20T17:00:00.000Z",
      source: "cron-manager",
    };

    // Test that spread operator makes it compatible
    const canAccept = acceptsRecord({ ...signalPayload });
    assertEquals(
      canAccept,
      true,
      "Spread operator should make payload compatible with Record<string, unknown>",
    );
  });
});

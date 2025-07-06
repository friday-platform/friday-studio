/**
 * Tests for CLI Signal Provider
 * TDD implementation - tests first, then implementation
 * RED PHASE: These tests should fail initially since CliSignalProvider doesn't exist yet
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { CliSignalProvider } from "../../../src/core/providers/builtin/cli-signal.ts";
import type {
  CliSignalConfig,
  CliTriggerData,
} from "../../../src/core/providers/builtin/cli-signal.ts";

Deno.test("CliSignalProvider - initialization", async (t) => {
  await t.step("should initialize with valid CLI config", () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "deploy",
      args: ["--env", "production"],
      flags: { verbose: true },
    };

    const provider = new CliSignalProvider(config);
    assertEquals(provider.getProviderId(), "test-cli");
    assertEquals(provider.getProviderType(), "cli");
  });

  await t.step("should require command in config", () => {
    const config = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli" as const,
      // missing command
    };

    try {
      new CliSignalProvider(config as CliSignalConfig);
      throw new Error("Should have thrown validation error");
    } catch (error) {
      assertEquals(error.message.includes("command"), true);
    }
  });

  await t.step("should accept empty args and flags", () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "status",
    };

    const provider = new CliSignalProvider(config);
    assertEquals(provider.getCommand(), "status");
    assertEquals(provider.getArgs(), []);
    assertEquals(provider.getFlags(), {});
  });

  await t.step("should validate command format", () => {
    const config = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli" as const,
      command: "", // empty command
    };

    try {
      new CliSignalProvider(config as CliSignalConfig);
      throw new Error("Should have thrown validation error");
    } catch (error) {
      assertEquals(error.message.includes("command"), true);
    }
  });
});

Deno.test("CliSignalProvider - interface compliance", async (t) => {
  await t.step("should implement IProvider interface", () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "test",
    };

    const provider = new CliSignalProvider(config);

    // IProvider interface properties
    assertEquals(typeof provider.id, "string");
    assertEquals(provider.type.toString(), "signal");
    assertEquals(typeof provider.name, "string");
    assertEquals(typeof provider.version, "string");

    // IProvider interface methods
    assertEquals(typeof provider.setup, "function");
    assertEquals(typeof provider.teardown, "function");
    assertEquals(typeof provider.getState, "function");
    assertEquals(typeof provider.checkHealth, "function");
  });

  await t.step("should have correct provider metadata", () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "test",
    };

    const provider = new CliSignalProvider(config);
    assertEquals(provider.name, "CLI Signal Provider");
    assertEquals(provider.version, "1.0.0");
  });
});

Deno.test("CliSignalProvider - command processing", async (t) => {
  await t.step("should process CLI trigger data", async () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "deploy",
      args: ["--env", "staging"],
      flags: { verbose: true, force: false },
    };

    const provider = new CliSignalProvider(config);

    const triggerData = {
      command: "deploy",
      args: ["--region", "us-west-2"],
      flags: { verbose: true, dryrun: true },
      metadata: { user: "testuser", timestamp: "2024-01-01T10:00:00Z" },
    };

    const signal = await provider.processTrigger(triggerData);

    assertEquals(signal.id, "test-cli");
    assertEquals(signal.type, "cli");
    assertEquals(signal.data.command, "deploy");
    assertEquals(signal.data.args, ["--env", "staging", "--region", "us-west-2"]);
    assertEquals(signal.data.flags.verbose, true);
    assertEquals(signal.data.flags.force, false); // from config
    assertEquals(signal.data.flags.dryrun, true); // from trigger
    assertEquals(signal.data.metadata.user, "testuser");
    assertEquals(typeof signal.timestamp, "string");
  });

  await t.step("should merge config and trigger data", async () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "deploy",
      args: ["--base-env", "staging"],
      flags: { verbose: true, force: false },
    };

    const provider = new CliSignalProvider(config);

    const triggerData = {
      args: ["--override", "production"],
      flags: { force: true, newFlag: "value" },
    };

    const signal = await provider.processTrigger(triggerData);

    // Should merge config and trigger data
    assertEquals(signal.data.command, "deploy");
    assertEquals(signal.data.args, ["--base-env", "staging", "--override", "production"]);
    assertEquals(signal.data.flags.verbose, true); // from config
    assertEquals(signal.data.flags.force, true); // overridden by trigger
    assertEquals(signal.data.flags.newFlag, "value"); // from trigger
  });

  await t.step("should handle minimal trigger data", async () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "status",
    };

    const provider = new CliSignalProvider(config);

    const signal = await provider.processTrigger({});

    assertEquals(signal.id, "test-cli");
    assertEquals(signal.type, "cli");
    assertEquals(signal.data.command, "status");
    assertEquals(signal.data.args, []);
    assertEquals(signal.data.flags, {});
  });
});

Deno.test("CliSignalProvider - command validation", async (t) => {
  await t.step("should validate command matches config", async () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "deploy",
    };

    const provider = new CliSignalProvider(config);

    const triggerData = {
      command: "different-command",
    };

    try {
      await provider.processTrigger(triggerData);
      throw new Error("Should have thrown validation error");
    } catch (error) {
      assertEquals(error.message.includes("command mismatch"), true);
    }
  });

  await t.step("should accept trigger without explicit command", async () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "deploy",
    };

    const provider = new CliSignalProvider(config);

    const triggerData = {
      args: ["--env", "production"],
    };

    const signal = await provider.processTrigger(triggerData);
    assertEquals(signal.data.command, "deploy"); // Uses config command
  });

  await t.step("should validate args format", async () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "deploy",
    };

    const provider = new CliSignalProvider(config);

    const triggerData = {
      args: "invalid-args-format", // Should be array
    };

    try {
      await provider.processTrigger(triggerData as unknown as CliTriggerData);
      throw new Error("Should have thrown validation error");
    } catch (error) {
      assertEquals(error.message.includes("args must be array"), true);
    }
  });

  await t.step("should validate flags format", async () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "deploy",
    };

    const provider = new CliSignalProvider(config);

    const triggerData = {
      flags: ["invalid", "flags", "format"], // Should be object
    };

    try {
      await provider.processTrigger(triggerData as unknown as CliTriggerData);
      throw new Error("Should have thrown validation error");
    } catch (error) {
      assertEquals(error.message.includes("flags must be object"), true);
    }
  });
});

Deno.test("CliSignalProvider - lifecycle management", async (t) => {
  await t.step("should handle setup and teardown", () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "test",
    };

    const provider = new CliSignalProvider(config);

    // Initial state should be NOT_CONFIGURED
    let state = provider.getState();
    assertEquals(state.status, "not_configured");

    // After setup, should be READY
    provider.setup();
    state = provider.getState();
    assertEquals(state.status, "ready");

    // After teardown, should be DISABLED
    provider.teardown();
    state = provider.getState();
    assertEquals(state.status, "disabled");
  });

  await t.step("should report health status", async () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "test",
    };

    const provider = new CliSignalProvider(config);
    provider.setup();

    const health = await provider.checkHealth();
    assertEquals(health.healthy, true);
    assertEquals(typeof health.lastCheck, "object");
    assertEquals(health.lastCheck instanceof Date, true);
    assertEquals(typeof health.message, "string");
  });
});

Deno.test("CliSignalProvider - error handling", async (t) => {
  await t.step("should handle invalid trigger data gracefully", async () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "test",
    };

    const provider = new CliSignalProvider(config);

    // Null trigger data
    try {
      await provider.processTrigger(null);
      throw new Error("Should have thrown validation error");
    } catch (error) {
      assertEquals(error.message.includes("trigger data"), true);
    }
  });

  await t.step("should handle setup errors gracefully", () => {
    const config: CliSignalConfig = {
      id: "test-cli",
      description: "Test CLI signal",
      provider: "cli",
      command: "test",
    };

    const provider = new CliSignalProvider(config);

    // Setup should not throw for valid config
    provider.setup();

    const state = provider.getState();
    assertEquals(state.status, "ready");
  });
});

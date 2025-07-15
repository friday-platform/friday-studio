/**
 * Tests for CLI Signal Provider Registry Integration
 * TDD implementation - tests first, then implementation
 * RED PHASE: These tests should fail initially since CLI provider factory is not registered
 */

import { assertEquals, assertRejects } from "@std/assert";
import { ProviderRegistry } from "../../../src/core/providers/registry.ts";
import { ProviderType } from "../../../src/core/providers/types.ts";
import type { ProviderConfig } from "../../../src/core/providers/types.ts";

Deno.test("CLI Signal Provider - Registry Integration", async (t) => {
  await t.step("should register CLI provider factory", async () => {
    const registry = ProviderRegistry.getInstance();

    // Providers are automatically available through static imports

    const config: ProviderConfig = {
      id: "test-cli-signal",
      type: ProviderType.SIGNAL,
      provider: "cli",
      config: {
        description: "Test CLI signal",
        command: "deploy",
        args: ["--env", "staging"],
        flags: { verbose: true },
      },
    };

    const provider = await registry.loadFromConfig(config);

    assertEquals(provider.id, "test-cli-signal");
    assertEquals(provider.type, ProviderType.SIGNAL);
    assertEquals(provider.name, "CLI Signal Provider");
  });

  await t.step("should create CLI provider from minimal config", async () => {
    const registry = ProviderRegistry.getInstance();

    const config: ProviderConfig = {
      id: "minimal-cli",
      type: ProviderType.SIGNAL,
      provider: "cli",
      config: {
        command: "status",
      },
    };

    const provider = await registry.loadFromConfig(config);

    assertEquals(provider.id, "minimal-cli");
    assertEquals(provider.type, ProviderType.SIGNAL);
  });

  await t.step("should fail with invalid CLI config", async () => {
    const registry = ProviderRegistry.getInstance();

    const config: ProviderConfig = {
      id: "invalid-cli",
      type: ProviderType.SIGNAL,
      provider: "cli",
      config: {
        // missing required command
      },
    };

    await assertRejects(
      () => registry.loadFromConfig(config),
      Error,
      "command",
    );
  });

  await t.step("should retrieve CLI provider by type", async () => {
    const registry = ProviderRegistry.getInstance();

    const config: ProviderConfig = {
      id: "test-cli-by-type",
      type: ProviderType.SIGNAL,
      provider: "cli",
      config: {
        command: "test",
      },
    };

    await registry.loadFromConfig(config);

    const signalProviders = registry.getByType(ProviderType.SIGNAL);
    const cliProviders = signalProviders.filter(
      (p) => p.name === "CLI Signal Provider",
    );

    assertEquals(cliProviders.length >= 1, true);
  });

  await t.step(
    "should handle CLI provider lifecycle through registry",
    async () => {
      const registry = ProviderRegistry.getInstance();

      const config: ProviderConfig = {
        id: "lifecycle-cli",
        type: ProviderType.SIGNAL,
        provider: "cli",
        config: {
          command: "lifecycle-test",
        },
      };

      const provider = await registry.loadFromConfig(config);

      // Setup provider
      provider.setup();
      let state = provider.getState();
      assertEquals(state.status, "ready");

      // Check health
      const health = await provider.checkHealth();
      assertEquals(health.healthy, true);

      // Teardown provider
      provider.teardown();
      state = provider.getState();
      assertEquals(state.status, "disabled");
    },
  );
});

Deno.test(
  "CLI Signal Provider - Configuration Schema Integration",
  async (t) => {
    await t.step("should handle complex CLI configurations", async () => {
      const registry = ProviderRegistry.getInstance();

      const config: ProviderConfig = {
        id: "complex-cli",
        type: ProviderType.SIGNAL,
        provider: "cli",
        config: {
          description: "Complex CLI deployment signal",
          command: "deploy",
          args: ["--env", "production", "--region", "us-west-2"],
          flags: {
            verbose: true,
            force: false,
            timeout: 300,
            dryRun: false,
          },
          timeout_ms: 30000,
          retry_config: {
            max_retries: 3,
            retry_delay_ms: 1000,
          },
        },
      };

      const provider = await registry.loadFromConfig(config);
      provider.setup();

      // Should be able to access configuration
      assertEquals(provider.id, "complex-cli");

      const state = provider.getState();
      assertEquals(state.status, "ready");
      assertEquals(state.config?.command, "deploy");
      assertEquals(state.config?.args, [
        "--env",
        "production",
        "--region",
        "us-west-2",
      ]);
      assertEquals(state.config?.flags.verbose, true);
      assertEquals(state.config?.flags.timeout, 300);
    });

    await t.step("should validate configuration schema", async () => {
      const registry = ProviderRegistry.getInstance();

      // Test with invalid args type
      const invalidArgsConfig: ProviderConfig = {
        id: "invalid-args-cli",
        type: ProviderType.SIGNAL,
        provider: "cli",
        config: {
          command: "test",
          args: "invalid-args-should-be-array",
        },
      };

      await assertRejects(
        () => registry.loadFromConfig(invalidArgsConfig),
        Error,
        "args",
      );

      // Test with invalid flags type
      const invalidFlagsConfig: ProviderConfig = {
        id: "invalid-flags-cli",
        type: ProviderType.SIGNAL,
        provider: "cli",
        config: {
          command: "test",
          flags: ["invalid", "flags", "should", "be", "object"],
        },
      };

      await assertRejects(
        () => registry.loadFromConfig(invalidFlagsConfig),
        Error,
        "flags",
      );
    });
  },
);

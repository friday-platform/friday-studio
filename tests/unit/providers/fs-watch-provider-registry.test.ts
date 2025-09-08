/**
 * Tests for FS-WATCH Signal Provider Registry Integration (TDD)
 */

import { assertEquals } from "@std/assert";
import { ProviderRegistry } from "../../../src/core/providers/registry.ts";
import type { ProviderConfig } from "../../../src/core/providers/types.ts";
import { ProviderType } from "../../../src/core/providers/types.ts";

Deno.test("FS-WATCH provider can be loaded via registry and managed", async (t) => {
  await t.step("should load provider from minimal config", async () => {
    const registry = ProviderRegistry.getInstance();
    const config: ProviderConfig = {
      id: "watch-minimal",
      type: ProviderType.SIGNAL,
      provider: "fs-watch",
      config: { path: "content" },
    };

    const provider = await registry.loadFromConfig(config);
    assertEquals(provider.id, "watch-minimal");
    assertEquals(provider.type, ProviderType.SIGNAL);
    assertEquals(provider.name, "File Watch Signal Provider");
  });

  await t.step("should manage lifecycle (setup/teardown) and health", async () => {
    const registry = ProviderRegistry.getInstance();
    const config: ProviderConfig = {
      id: "watch-lifecycle",
      type: ProviderType.SIGNAL,
      provider: "fs-watch",
      config: { path: "." },
    };

    const provider = await registry.loadFromConfig(config);
    provider.setup();
    const health = await provider.checkHealth();
    assertEquals(health.healthy, true);

    provider.teardown();
    const state = provider.getState();
    assertEquals(state.status, "disabled");
  });
});

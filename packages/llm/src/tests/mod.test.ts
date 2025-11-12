import type { SharedV2ProviderOptions } from "@ai-sdk/provider";
import { assertEquals } from "@std/assert";
import { getDefaultProviderOpts } from "../../mod.ts";

Deno.test("getDefaultProviderOpts - returns anthropic defaults with no overrides", () => {
  const result = getDefaultProviderOpts("anthropic");

  assertEquals(result, { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } });
});

Deno.test("getDefaultProviderOpts - deep merges anthropic provider options", () => {
  const overrides: SharedV2ProviderOptions = {
    anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } },
  };

  const result = getDefaultProviderOpts("anthropic", overrides);

  assertEquals(result, {
    anthropic: {
      cacheControl: { type: "ephemeral", ttl: "1h" },
      thinking: { type: "enabled", budgetTokens: 12000 },
    },
  });
});

Deno.test("getDefaultProviderOpts - deep merges nested anthropic properties", () => {
  const overrides: SharedV2ProviderOptions = { anthropic: { cacheControl: { type: "none" } } };

  const result = getDefaultProviderOpts("anthropic", overrides);

  // Deep merge preserves existing properties and overrides specified ones
  assertEquals(result, { anthropic: { cacheControl: { type: "none", ttl: "1h" } } });
});

Deno.test("getDefaultProviderOpts - preserves other provider options in overrides", () => {
  const overrides: SharedV2ProviderOptions = {
    anthropic: { thinking: { type: "enabled", budgetTokens: 5000 } },
    openai: { structuredOutputs: true },
  };

  const result = getDefaultProviderOpts("anthropic", overrides);

  assertEquals(result, {
    anthropic: {
      cacheControl: { type: "ephemeral", ttl: "1h" },
      thinking: { type: "enabled", budgetTokens: 5000 },
    },
    openai: { structuredOutputs: true },
  });
});

Deno.test("getDefaultProviderOpts - returns empty object for openai with no defaults", () => {
  const result = getDefaultProviderOpts("openai");

  assertEquals(result, {});
});

Deno.test("getDefaultProviderOpts - returns overrides only for openai", () => {
  const overrides: SharedV2ProviderOptions = { openai: { structuredOutputs: true } };

  const result = getDefaultProviderOpts("openai", overrides);

  assertEquals(result, { openai: { structuredOutputs: true } });
});

Deno.test("getDefaultProviderOpts - returns empty object for google with no defaults", () => {
  const result = getDefaultProviderOpts("google");

  assertEquals(result, {});
});

import type { SharedV2ProviderOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { getDefaultProviderOpts } from "../../mod.ts";

describe("getDefaultProviderOpts", () => {
  it("returns anthropic defaults with no overrides", () => {
    const result = getDefaultProviderOpts("anthropic");

    expect(result).toEqual({ anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } });
  });

  it("deep merges anthropic provider options", () => {
    const overrides: SharedV2ProviderOptions = {
      anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } },
    };

    const result = getDefaultProviderOpts("anthropic", overrides);

    expect(result).toEqual({
      anthropic: {
        cacheControl: { type: "ephemeral", ttl: "1h" },
        thinking: { type: "enabled", budgetTokens: 12000 },
      },
    });
  });

  it("deep merges nested anthropic properties", () => {
    const overrides: SharedV2ProviderOptions = { anthropic: { cacheControl: { type: "none" } } };

    const result = getDefaultProviderOpts("anthropic", overrides);

    // Deep merge preserves existing properties and overrides specified ones
    expect(result).toEqual({ anthropic: { cacheControl: { type: "none", ttl: "1h" } } });
  });

  it("preserves other provider options in overrides", () => {
    const overrides: SharedV2ProviderOptions = {
      anthropic: { thinking: { type: "enabled", budgetTokens: 5000 } },
      openai: { structuredOutputs: true },
    };

    const result = getDefaultProviderOpts("anthropic", overrides);

    expect(result).toEqual({
      anthropic: {
        cacheControl: { type: "ephemeral", ttl: "1h" },
        thinking: { type: "enabled", budgetTokens: 5000 },
      },
      openai: { structuredOutputs: true },
    });
  });

  it("returns empty object for openai with no defaults", () => {
    const result = getDefaultProviderOpts("openai");

    expect(result).toEqual({});
  });

  it("returns overrides only for openai", () => {
    const overrides: SharedV2ProviderOptions = { openai: { structuredOutputs: true } };

    const result = getDefaultProviderOpts("openai", overrides);

    expect(result).toEqual({ openai: { structuredOutputs: true } });
  });

  it("returns empty object for google with no defaults", () => {
    const result = getDefaultProviderOpts("google");

    expect(result).toEqual({});
  });
});

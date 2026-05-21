import { describe, expect, it } from "vitest";
import {
  parseOverride,
  resolvePillLabel,
  type CatalogEntry,
  type ModelInfo,
} from "./model-pill.ts";

const anthropicCatalog: CatalogEntry = {
  provider: "anthropic",
  credentialConfigured: true,
  credentialEnvVar: "ANTHROPIC_API_KEY",
  meta: { name: "Anthropic", letter: "A", keyPrefix: "sk-ant-", helpUrl: null },
  models: [
    { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
  ],
};

const openaiCatalog: CatalogEntry = {
  provider: "openai",
  credentialConfigured: true,
  credentialEnvVar: "OPENAI_API_KEY",
  meta: { name: "OpenAI", letter: "O", keyPrefix: "sk-", helpUrl: null },
  models: [{ id: "gpt-4o", displayName: "GPT-4o" }],
};

const catalog: CatalogEntry[] = [anthropicCatalog, openaiCatalog];

const conversationalDefault: ModelInfo = {
  role: "conversational",
  resolved: { provider: "anthropic.messages", modelId: "claude-sonnet-4-6" },
  configured: null,
};

describe("parseOverride", () => {
  it("returns null for null or empty", () => {
    expect(parseOverride(null)).toBeNull();
    expect(parseOverride("")).toBeNull();
  });

  it("splits provider and modelId on the first colon", () => {
    expect(parseOverride("anthropic:claude-haiku-4-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
    });
  });

  it("preserves colons inside the modelId portion", () => {
    expect(parseOverride("openai:gpt-4:turbo")).toEqual({
      provider: "openai",
      modelId: "gpt-4:turbo",
    });
  });

  it("rejects malformed values (no colon, leading/trailing colon)", () => {
    expect(parseOverride("bareword")).toBeNull();
    expect(parseOverride(":model")).toBeNull();
    expect(parseOverride("provider:")).toBeNull();
  });
});

describe("resolvePillLabel", () => {
  it("returns the default conversational model when no override is set", () => {
    const label = resolvePillLabel(null, [conversationalDefault], catalog);
    expect(label).toEqual({
      provider: "anthropic",
      providerName: "Anthropic",
      providerLetter: "A",
      modelId: "claude-sonnet-4-6",
      modelDisplayName: "Claude Sonnet 4.6",
    });
  });

  it("strips registry-form provider suffix when resolving the default", () => {
    const label = resolvePillLabel(null, [conversationalDefault], catalog);
    expect(label?.provider).toBe("anthropic");
  });

  it("returns the override when one is set, regardless of default", () => {
    const label = resolvePillLabel("anthropic:claude-haiku-4-5", [conversationalDefault], catalog);
    expect(label).toEqual({
      provider: "anthropic",
      providerName: "Anthropic",
      providerLetter: "A",
      modelId: "claude-haiku-4-5",
      modelDisplayName: "Claude Haiku 4.5",
    });
  });

  it("falls back to modelId when the catalog has no matching model entry", () => {
    const label = resolvePillLabel("anthropic:future-model-xyz", [], catalog);
    expect(label).toEqual({
      provider: "anthropic",
      providerName: "Anthropic",
      providerLetter: "A",
      modelId: "future-model-xyz",
      modelDisplayName: "future-model-xyz",
    });
  });

  it("falls back to bare provider name when the catalog has no matching provider entry", () => {
    const label = resolvePillLabel("unknown:some-model", [], []);
    expect(label).toEqual({
      provider: "unknown",
      providerName: "unknown",
      providerLetter: "U",
      modelId: "some-model",
      modelDisplayName: "some-model",
    });
  });

  it("returns null when no override and no resolved conversational model", () => {
    expect(resolvePillLabel(null, [], catalog)).toBeNull();
  });

  it("ignores models from other roles when resolving the default", () => {
    const labelsOnly: ModelInfo = {
      role: "labels",
      resolved: { provider: "openai", modelId: "gpt-4o" },
      configured: null,
    };
    expect(resolvePillLabel(null, [labelsOnly], catalog)).toBeNull();
  });
});

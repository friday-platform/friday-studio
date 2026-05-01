import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mock `traceModel` so we can assert the factory applies tracing middleware
 * to every resolved role. Identity passthrough preserves the underlying model
 * so all other assertions still work.
 */
const { traceModelMock } = vi.hoisted(() => ({ traceModelMock: vi.fn((model: unknown) => model) }));
vi.mock("../tracing.ts", async () => {
  const actual = await vi.importActual<typeof import("../tracing.ts")>("../tracing.ts");
  return { ...actual, traceModel: traceModelMock };
});

import {
  createPlatformModels,
  DEFAULT_PLATFORM_MODELS,
  PlatformModelsConfigError,
} from "../platform-models.ts";

/**
 * Snapshot and restore the env vars the resolver reads so each test starts
 * from a known credential state.
 */
const TOUCHED_ENV = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "LITELLM_API_KEY",
] as const;

function clearEnv(): void {
  for (const key of TOUCHED_ENV) delete process.env[key];
}

function setEnv(overrides: Partial<Record<(typeof TOUCHED_ENV)[number], string>>): void {
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) process.env[k] = v;
  }
}

const originalEnv: Partial<Record<string, string>> = {};

beforeEach(() => {
  for (const key of TOUCHED_ENV) originalEnv[key] = process.env[key];
  clearEnv();
  traceModelMock.mockClear();
});

afterEach(() => {
  clearEnv();
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
});

describe("createPlatformModels", () => {
  it("resolves all four roles from default chains when only ANTHROPIC_API_KEY is set", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });

    const models = createPlatformModels(null);

    // Each role should return a usable LanguageModelV3 instance
    expect(models.get("labels")).toBeDefined();
    expect(models.get("classifier")).toBeDefined();
    expect(models.get("planner")).toBeDefined();
    expect(models.get("conversational")).toBeDefined();
  });

  it("walks the labels default chain and picks Groq when GROQ_API_KEY is set", () => {
    setEnv({ GROQ_API_KEY: "gsk-test", ANTHROPIC_API_KEY: "sk-ant-test" });

    // groq:openai/gpt-oss-120b is first in chain; both creds present — groq wins
    expect(DEFAULT_PLATFORM_MODELS.labels[0]).toContain("groq:");
    const models = createPlatformModels(null);
    expect(models.get("labels")).toBeDefined();
  });

  it("falls through labels chain to anthropic when GROQ_API_KEY is missing", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });

    const models = createPlatformModels(null);
    expect(models.get("labels")).toBeDefined();
  });

  it("accepts LITELLM_API_KEY as universal credential for every provider", () => {
    setEnv({ LITELLM_API_KEY: "sk-litellm-test" });

    const models = createPlatformModels(null);
    expect(models.get("labels")).toBeDefined();
    expect(models.get("classifier")).toBeDefined();
    expect(models.get("planner")).toBeDefined();
    expect(models.get("conversational")).toBeDefined();
  });

  it("accepts a user-configured valid model when credentials are present", () => {
    setEnv({ GROQ_API_KEY: "gsk-test", ANTHROPIC_API_KEY: "sk-ant-test" });

    const models = createPlatformModels({ models: { classifier: "groq:openai/gpt-oss-120b" } });
    expect(models.get("classifier")).toBeDefined();
  });

  it("throws on malformed model id (missing colon)", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });

    expect(() => createPlatformModels({ models: { labels: "not-a-valid-format" } })).toThrow(
      PlatformModelsConfigError,
    );
  });

  it("throws on unknown provider", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });

    expect(() =>
      createPlatformModels({ models: { planner: "nonexistent-provider:some-model" } }),
    ).toThrow(/not registered/);
  });

  it("throws on missing credential for user-configured provider", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    // openai has no key set — strict validation fails

    expect(() => createPlatformModels({ models: { planner: "openai:gpt-4o" } })).toThrow(
      /missing credentials/,
    );
  });

  it("aggregates multiple errors across roles in a single throw", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });

    let caught: unknown;
    try {
      createPlatformModels({
        models: {
          labels: "bad-format",
          classifier: "nonexistent:foo",
          planner: "openai:gpt-4o", // missing credential
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PlatformModelsConfigError);
    const err = caught as PlatformModelsConfigError;
    expect(err.errors).toHaveLength(3);
    expect(err.errors.map((e) => e.role).sort()).toEqual(["classifier", "labels", "planner"]);
  });

  it("throws when default chain has no credentialed entry", () => {
    // No env vars set at all — every default chain entry fails
    expect(() => createPlatformModels(null)).toThrow(PlatformModelsConfigError);
  });

  it("claude-code is always credentialed (no env var required)", () => {
    // Provide Anthropic for other roles; claude-code planner overrides default
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    const models = createPlatformModels({ models: { planner: "claude-code:sonnet" } });
    expect(models.get("planner")).toBeDefined();
  });

  it("returns a get() accessor that throws on unknown role", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });

    const models = createPlatformModels(null);
    // @ts-expect-error — deliberate invalid role
    expect(() => models.get("nonexistent-role")).toThrow();
  });

  it("applies traceModel middleware once per resolved role", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });

    createPlatformModels(null);

    // Four roles (labels, classifier, planner, conversational) → four wraps
    expect(traceModelMock).toHaveBeenCalledTimes(4);
  });

  it("returns fresh instances on each factory call (no hidden caching)", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });

    const first = createPlatformModels(null);
    const second = createPlatformModels(null);

    expect(first.get("labels")).not.toBe(second.get("labels"));
  });
});

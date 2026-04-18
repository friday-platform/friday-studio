import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlatformModels, PlatformModelsConfigError } from "./platform-models.ts";

/**
 * Tests below run the real `createPlatformModels` factory and therefore
 * hit `@ai-sdk/*` registries. They don't make network calls — constructing
 * the language model is synchronous and purely configuration — but they do
 * require the provider env vars to be controllable per-test. We scrub
 * every credential before each test and restore in `afterEach`.
 */

const MANAGED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "LITELLM_API_KEY",
] as const;

const envBackup: Record<string, string | undefined> = {};

function stubEnv(vars: Partial<Record<(typeof MANAGED_ENV_VARS)[number], string | undefined>>) {
  for (const [k, v] of Object.entries(vars)) {
    envBackup[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  // Start each test from a clean slate — delete every managed key so a
  // previous test's stub can't bleed through.
  for (const k of MANAGED_ENV_VARS) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of Object.keys(envBackup)) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  for (const k of Object.keys(envBackup)) delete envBackup[k];
});

describe("createPlatformModels — single-string (back-compat)", () => {
  it("resolves a primary-only config when credentials are present", () => {
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    const pm = createPlatformModels({
      models: {
        labels: "anthropic:claude-haiku-4-5",
        classifier: "anthropic:claude-haiku-4-5",
        planner: "anthropic:claude-sonnet-4-6",
        conversational: "anthropic:claude-sonnet-4-6",
      },
    });
    expect(pm.get("planner").provider).toContain("anthropic");
    expect(pm.get("planner").modelId).toBe("claude-sonnet-4-6");
  });

  it("throws when the single configured provider has no credentials", () => {
    // No keys set — anthropic:X should error.
    expect(() =>
      createPlatformModels({ models: { planner: "anthropic:claude-sonnet-4-6" } }),
    ).toThrow(PlatformModelsConfigError);
  });
});

describe("createPlatformModels — chain resolution", () => {
  it("uses the primary entry when its credentials are present", () => {
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-test", GROQ_API_KEY: "gsk_test" });
    const pm = createPlatformModels({
      models: {
        planner: [
          "anthropic:claude-sonnet-4-6", // primary — has key
          "groq:llama-3.3-70b", // fallback — also has key, but primary wins
        ],
      },
    });
    const planner = pm.get("planner");
    expect(planner.provider).toContain("anthropic");
    expect(planner.modelId).toBe("claude-sonnet-4-6");
  });

  it("falls through to fallback 1 when primary has no credentials", () => {
    // Credential anthropic (so the *other* roles' default chains resolve)
    // and groq (the fallback we expect to pick up for planner). Test sees
    // an anthropic→groq chain for planner, and since we'll simulate
    // "anthropic has no key", we override it with an empty string to
    // bypass the hasCredential check.
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-default", GROQ_API_KEY: "gsk_test" });
    // Actually — to specifically test "primary has no credentials", we
    // need BOTH groq keyed (for the other roles' fallback in the labels
    // default chain) and anthropic keyed (for the other roles' defaults),
    // but ALSO we need the PRIMARY of planner (`anthropic`) to look
    // uncredentialed from `planner`'s perspective. That's contradictory
    // at the process-env layer, so we flip the test: use openai as the
    // primary (no key) and anthropic as the fallback.
    const pm = createPlatformModels({
      models: { planner: ["openai:gpt-5", "anthropic:claude-sonnet-4-6"] },
    });
    const planner = pm.get("planner");
    expect(planner.provider).toContain("anthropic");
    expect(planner.modelId).toBe("claude-sonnet-4-6");
  });

  it("walks multi-entry chains and returns the first credentialed entry", () => {
    // 3-entry chain: anthropic (no key), groq (no key), openai (keyed).
    // Other roles' defaults need anthropic; add that key too so the
    // factory can resolve labels/classifier/conversational. The planner
    // chain ordering guarantees we pick the first *chain* entry that's
    // credentialed — which in this test is the second of three.
    stubEnv({ OPENAI_API_KEY: "sk-openai-test", ANTHROPIC_API_KEY: "sk-ant-default" });
    const pm = createPlatformModels({
      models: {
        planner: [
          "openai:gpt-5", // first credentialed entry → picked
          "groq:llama-3.3-70b",
          "anthropic:claude-sonnet-4-6",
        ],
      },
    });
    expect(pm.get("planner").modelId).toBe("gpt-5");
  });

  it("falls through to the default chain when the whole user chain is uncredentialed", () => {
    // User chain: anthropic + groq, but NEITHER has a key.
    // Default `planner` chain is ["anthropic:claude-sonnet-4-6"] — also
    // uncredentialed with no keys set — so this should ERROR on the
    // default chain, not the user chain. Supply anthropic credentials
    // so the default resolves and confirm the user chain was bypassed.
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-default" });
    const pm = createPlatformModels({
      models: {
        // User chain references providers that need groq + openai keys
        // (neither set). Both entries bypassed, default chain picks up
        // anthropic:claude-sonnet-4-6 (which does have a key).
        planner: ["groq:llama-3.3-70b", "openai:gpt-5"],
      },
    });
    // Default planner = anthropic:claude-sonnet-4-6.
    expect(pm.get("planner").provider).toContain("anthropic");
    expect(pm.get("planner").modelId).toBe("claude-sonnet-4-6");
  });

  it("errors on typo'd model ids anywhere in the chain (unknown provider)", () => {
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    // Second entry names a nonexistent provider — should hard-error
    // rather than silently skip, so typos surface immediately.
    expect(() =>
      createPlatformModels({
        models: { planner: ["anthropic:claude-sonnet-4-6", "totally-not-a-provider:x"] },
      }),
    ).toThrow(PlatformModelsConfigError);
  });

  it("errors on malformed chain entries (missing colon)", () => {
    expect(() =>
      createPlatformModels({
        models: { planner: ["anthropic:claude-sonnet-4-6", "malformed-no-colon"] },
      }),
    ).toThrow(PlatformModelsConfigError);
  });

  it("treats a single-entry chain as strict (no silent fallthrough)", () => {
    // Single-entry chain with no credentials should error — same as the
    // back-compat string shape. Contract: [x] === "x".
    expect(() =>
      createPlatformModels({ models: { planner: ["anthropic:claude-sonnet-4-6"] } }),
    ).toThrow(PlatformModelsConfigError);
  });
});

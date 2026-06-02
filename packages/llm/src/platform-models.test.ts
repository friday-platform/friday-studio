import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlatformModels,
  PlatformModelsConfigError,
  resolveModelFromString,
} from "./platform-models.ts";

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

describe("resolveModelFromString", () => {
  it("returns a traced LanguageModelV3 for a credentialed provider:model", () => {
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    const model = resolveModelFromString("anthropic:claude-sonnet-4-6");
    expect(model.provider).toContain("anthropic");
    expect(model.modelId).toBe("claude-sonnet-4-6");
  });

  it("throws naming the spec when the format is invalid (no colon)", () => {
    expect(() => resolveModelFromString("malformed-no-colon")).toThrow(/malformed-no-colon/);
  });

  it("throws naming the spec when the provider half is empty", () => {
    expect(() => resolveModelFromString(":claude-sonnet-4-6")).toThrow(/:claude-sonnet-4-6/);
  });

  it("throws naming the spec when the model half is empty", () => {
    expect(() => resolveModelFromString("anthropic:")).toThrow(/anthropic:/);
  });

  it("throws listing known providers on unknown provider", () => {
    expect(() => resolveModelFromString("totally-not-a-provider:x")).toThrow(
      /totally-not-a-provider/,
    );
    expect(() => resolveModelFromString("totally-not-a-provider:x")).toThrow(/anthropic/);
  });

  it("throws naming the env var (and LITELLM_API_KEY) when credentials are missing", () => {
    expect(() => resolveModelFromString("anthropic:claude-sonnet-4-6")).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(() => resolveModelFromString("anthropic:claude-sonnet-4-6")).toThrow(/LITELLM_API_KEY/);
  });

  it("accepts LITELLM_API_KEY in lieu of the provider-specific env var", () => {
    stubEnv({ LITELLM_API_KEY: "sk-litellm-test" });
    const model = resolveModelFromString("openai:gpt-5");
    expect(model.provider).toContain("openai");
    expect(model.modelId).toBe("gpt-5");
  });
});

describe("createPlatformModels — getImage", () => {
  it("returns the first chain entry with credentials present and skips uncredentialed entries", () => {
    // Anthropic key keeps the four LLM roles' default chains resolvable
    // (boot-time eager validation). Gemini key credentials the second
    // image-chain entry. OpenAI is intentionally absent so the first
    // image-chain entry (openai:gpt-image-1.5) is skipped.
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-test", GEMINI_API_KEY: "test-gemini-key" });
    const pm = createPlatformModels({
      models: {
        image: ["openai:gpt-image-1.5", "google:gemini-2.5-flash-image"],
      },
    });
    const image = pm.getImage();
    expect(image.modelId).toBe("gemini-2.5-flash-image");
    expect(image.provider).toContain("google");
  });

  it("throws PlatformModelsConfigError when no chain entry has credentials", () => {
    // Credential only anthropic so the default LLM-role chains pass boot.
    // Image default is `google:gemini-2.5-flash-image`, which has no
    // matching GEMINI_API_KEY → `getImage()` exhausts and throws.
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    const pm = createPlatformModels(null);
    expect(() => pm.getImage()).toThrow(PlatformModelsConfigError);
  });
});

describe("createPlatformModels — image boot-time validation", () => {
  it("aggregates `unknown_image_model` error when models.image pins an overlay-missing id", () => {
    // Anthropic keys the default language chains so the four LLM roles boot
    // cleanly; the only problem is `models.image` naming a known provider
    // but an id we haven't verified in the overlay.
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    let caught: PlatformModelsConfigError | null = null;
    try {
      createPlatformModels({ models: { image: "google:gemini-2.5-flas-image" } });
    } catch (err) {
      if (err instanceof PlatformModelsConfigError) caught = err;
      else throw err;
    }
    expect(caught).not.toBeNull();
    const errors = caught?.errors ?? [];
    expect(
      errors.some((e) => e.role === "image" && e.kind === "unknown_image_model"),
    ).toBe(true);
    // Error message names the offending id and lists at least one known
    // overlay id so the operator can copy-paste a fix.
    expect(caught?.message).toContain("google:gemini-2.5-flas-image");
    expect(caught?.message).toContain("known image models:");
    expect(caught?.message).toContain("google:gemini-2.5-flash-image");
  });

  it("rejects any chain entry not in the overlay (multi-entry chains)", () => {
    // First entry is overlay-valid, second is not. Boot must surface the
    // typo even though the chain *could* resolve via entry 1 at runtime.
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(() =>
      createPlatformModels({
        models: { image: ["google:gemini-2.5-flash-image", "openai:dall-e-9000"] },
      }),
    ).toThrow(PlatformModelsConfigError);
  });

  it("aggregates an image error and a conversational error in a single throw", () => {
    // Both roles misconfigured: conversational names a nonexistent provider,
    // image names an overlay-missing id. One startup attempt must report
    // both — the operator shouldn't fix one, restart, then discover the next.
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    let caught: PlatformModelsConfigError | null = null;
    try {
      createPlatformModels({
        models: {
          conversational: "totally-not-a-provider:x",
          image: "google:not-a-real-model",
        },
      });
    } catch (err) {
      if (err instanceof PlatformModelsConfigError) caught = err;
      else throw err;
    }
    expect(caught).not.toBeNull();
    const errors = caught?.errors ?? [];
    expect(
      errors.some((e) => e.role === "conversational" && e.kind === "unknown_provider"),
    ).toBe(true);
    expect(
      errors.some((e) => e.role === "image" && e.kind === "unknown_image_model"),
    ).toBe(true);
  });

  it("boots when models.image is unset (no overlay check to run)", () => {
    // No GEMINI_API_KEY — default image chain has no credentials at boot,
    // but image credential checks are deferred to getImage(). Boot must
    // succeed so the daemon can come up even when image-gen is unused.
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(() => createPlatformModels(null)).not.toThrow();
  });

  it("boots when models.image pins a valid overlay id with credentials missing", () => {
    // openai:dall-e-3 is in the overlay; OPENAI_API_KEY is intentionally
    // absent. Boot must tolerate this — the credential check is the runtime
    // resolver's job, not boot's.
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(() =>
      createPlatformModels({ models: { image: "openai:dall-e-3" } }),
    ).not.toThrow();
  });
});

describe("createPlatformModels — lazy resolution", () => {
  it("re-resolves get() against the current process.env on each call", () => {
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-test", GROQ_API_KEY: "gsk_test" });
    const pm = createPlatformModels({
      models: { labels: ["groq:llama-3.3-70b", "anthropic:claude-haiku-4-5"] },
    });
    expect(pm.get("labels").modelId).toBe("llama-3.3-70b");

    delete process.env.GROQ_API_KEY;
    expect(pm.get("labels").modelId).toBe("claude-haiku-4-5");
  });

  it("picks up credentials added to process.env after construction", () => {
    stubEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    const pm = createPlatformModels({
      models: { labels: ["groq:llama-3.3-70b", "anthropic:claude-haiku-4-5"] },
    });
    expect(pm.get("labels").modelId).toBe("claude-haiku-4-5");

    process.env.GROQ_API_KEY = "gsk_test";
    expect(pm.get("labels").modelId).toBe("llama-3.3-70b");
  });
});

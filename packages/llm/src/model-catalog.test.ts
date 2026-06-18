import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Catalog,
  type CatalogEntry,
  type CatalogProvider,
  getCatalog,
  invalidateCatalog,
} from "./model-catalog.ts";

/**
 * Build a minimal gateway response. The catalog only reads a few fields
 * per entry, so this keeps test fixtures tiny.
 */
function gatewayModel(
  specificationProvider: string,
  modelId: string,
  name: string,
  modelType: string | null = null,
): Record<string, unknown> {
  return {
    id: modelId,
    name,
    specification: { provider: specificationProvider, modelId },
    modelType,
  };
}

function groqListResponse(ids: string[]): Record<string, unknown> {
  return { data: ids.map((id) => ({ id })) };
}

function mockJsonFetch(urlToBody: Record<string, unknown>): ReturnType<typeof vi.fn> {
  return vi.fn((url: string) => {
    const body = urlToBody[url];
    if (!body) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as unknown as Response);
  });
}

function find(catalog: Catalog, provider: CatalogProvider): CatalogEntry {
  const entry = catalog.entries.find((e) => e.provider === provider);
  if (!entry) throw new Error(`provider ${provider} not in catalog`);
  return entry;
}

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v4/ai/config";
const GROQ_URL = "https://api.groq.com/openai/v1/models";

const envBackup: Record<string, string | undefined> = {};
function stubEnv(vars: Record<string, string | undefined>) {
  for (const k of Object.keys(vars)) {
    envBackup[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
}
function restoreEnv() {
  for (const k of Object.keys(envBackup)) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  for (const k of Object.keys(envBackup)) delete envBackup[k];
}

beforeEach(() => {
  invalidateCatalog();
  stubEnv({
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
    GROQ_API_KEY: undefined,
    LITELLM_API_KEY: undefined,
    LOCAL_BASE_URL: undefined,
  });
});

afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
});

describe("model-catalog — gateway partitioning", () => {
  it("splits gateway entries into friday provider buckets with normalized ids", async () => {
    const gateway = {
      models: [
        gatewayModel("anthropic", "anthropic/claude-sonnet-4.6", "Claude Sonnet 4.6"),
        gatewayModel("anthropic", "anthropic/claude-haiku-4.5", "Claude Haiku 4.5"),
        gatewayModel("openai", "openai/gpt-5.4", "GPT-5.4"),
        gatewayModel("vertex", "google/gemini-3-pro-preview", "Gemini 3 Pro Preview"),
        gatewayModel("vertex", "google/gemini-3-pro-image", "Nano Banana", "language"),
        // Non-language types — must be skipped.
        gatewayModel("openai", "openai/gpt-image-1", "GPT Image 1", "image"),
        gatewayModel("openai", "openai/text-embedding-3-large", "embed", "embedding"),
        // Providers outside our five — ignored entirely.
        gatewayModel("mistral", "mistral/pixtral-12b", "Pixtral", "language"),
      ],
    };
    vi.stubGlobal("fetch", mockJsonFetch({ [GATEWAY_URL]: gateway }));

    const catalog = await getCatalog();

    // Ids are raw model names (no provider prefix) — callers compose
    // the full `provider:model` string when they need it.
    // Anthropic IDs are normalized from gateway semver form (dots) to the
    // direct-API form (hyphens) — see groupGatewayModels.
    const anthropic = find(catalog, "anthropic");
    expect(anthropic.models.map((m) => m.id)).toEqual(["claude-sonnet-4-6", "claude-haiku-4-5"]);

    const openai = find(catalog, "openai");
    expect(openai.models.map((m) => m.id)).toEqual(["gpt-5.4"]);

    // Google: only gemini-* text models via the `vertex` namespace.
    // `-image` variants must be dropped even when modelType=language.
    const google = find(catalog, "google");
    expect(google.models.map((m) => m.id)).toEqual(["gemini-3-pro-preview"]);

    // Groq gets nothing from the gateway path; it's filled from the
    // direct-Groq fetch when a key is present (covered in another test).
    expect(find(catalog, "groq").models).toEqual([]);
  });
});

describe("model-catalog — image partitioning", () => {
  it("partitions google entries: -image ids land in images, everything else stays in models", async () => {
    // Google ships its `-image` variants under `modelType: 'language'` —
    // language path must strip them (unchanged behavior), image path must
    // pick them up (new behavior).
    const gateway = {
      models: [
        gatewayModel("vertex", "google/gemini-3-pro-preview", "Gemini 3 Pro Preview"),
        gatewayModel("vertex", "google/gemini-2.5-flash", "Gemini 2.5 Flash"),
        gatewayModel(
          "vertex",
          "google/gemini-2.5-flash-image",
          "Gemini 2.5 Flash Image",
          "language",
        ),
        gatewayModel("vertex", "google/gemini-3-pro-image-preview", "Nano Banana", "language"),
      ],
    };
    vi.stubGlobal("fetch", mockJsonFetch({ [GATEWAY_URL]: gateway }));

    const google = find(await getCatalog(), "google");
    expect(google.models.map((m) => m.id)).toEqual(["gemini-3-pro-preview", "gemini-2.5-flash"]);
    expect(google.images.map((m) => m.id)).toEqual([
      "gemini-2.5-flash-image",
      "gemini-3-pro-image-preview",
    ]);
  });

  it("partitions openai entries: gpt-image-* and dall-e-* land in images, chat models stay in models", async () => {
    const gateway = {
      models: [
        gatewayModel("openai", "openai/gpt-5.4", "GPT-5.4"),
        gatewayModel("openai", "openai/gpt-image-1.5", "GPT Image 1.5", "image"),
        // dall-e-3 doesn't carry `modelType: 'image'` in some gateway
        // responses — the id-pattern rule has to catch it on its own.
        gatewayModel("openai", "openai/dall-e-3", "DALL·E 3"),
        gatewayModel("openai", "openai/dall-e-2", "DALL·E 2"),
      ],
    };
    vi.stubGlobal("fetch", mockJsonFetch({ [GATEWAY_URL]: gateway }));

    const openai = find(await getCatalog(), "openai");
    expect(openai.models.map((m) => m.id)).toEqual(["gpt-5.4"]);
    expect(openai.images.map((m) => m.id)).toEqual(["gpt-image-1.5", "dall-e-3", "dall-e-2"]);
  });

  it("routes gateway modelType=image entries into the appropriate provider's images bucket", async () => {
    // Imagen models land under `vertex` with `modelType: 'image'` but no
    // `-image` substring — exercises the explicit modelType branch.
    const gateway = {
      models: [
        gatewayModel("vertex", "google/imagen-4.0-generate-001", "Imagen 4", "image"),
        gatewayModel("vertex", "google/imagen-4.0-fast-generate-001", "Imagen 4 Fast", "image"),
        gatewayModel("openai", "openai/gpt-image-1", "GPT Image 1", "image"),
      ],
    };
    vi.stubGlobal("fetch", mockJsonFetch({ [GATEWAY_URL]: gateway }));

    const catalog = await getCatalog();
    expect(find(catalog, "google").images.map((m) => m.id)).toEqual([
      "imagen-4.0-generate-001",
      "imagen-4.0-fast-generate-001",
    ]);
    expect(find(catalog, "openai").images.map((m) => m.id)).toEqual(["gpt-image-1"]);
    // Language buckets untouched by image-only entries.
    expect(find(catalog, "google").models).toEqual([]);
    expect(find(catalog, "openai").models).toEqual([]);
  });

  it("leaves images empty for providers without an image surface", async () => {
    vi.stubGlobal("fetch", mockJsonFetch({ [GATEWAY_URL]: { models: [] } }));

    const catalog = await getCatalog();
    for (const entry of catalog.entries) {
      // Every entry must carry the `images` field, even when empty —
      // consumers shouldn't have to handle `undefined`.
      expect(entry.images).toEqual([]);
    }
  });
});

describe("model-catalog — credential resolution", () => {
  it("reports credentialConfigured=false and the env-var hint when no key is set", async () => {
    vi.stubGlobal("fetch", mockJsonFetch({ [GATEWAY_URL]: { models: [] } }));

    const catalog = await getCatalog();
    expect(find(catalog, "groq")).toMatchObject({
      credentialConfigured: false,
      credentialEnvVar: "GROQ_API_KEY",
    });
    expect(find(catalog, "google")).toMatchObject({
      credentialConfigured: false,
      credentialEnvVar: "GEMINI_API_KEY",
    });
  });

  it("unlocks every proxyable provider when LITELLM_API_KEY is set (proxy mode)", async () => {
    stubEnv({ LITELLM_API_KEY: "sk-litellm" });
    vi.stubGlobal("fetch", mockJsonFetch({ [GATEWAY_URL]: { models: [] } }));

    const catalog = await getCatalog();
    for (const entry of catalog.entries) {
      // `local` is the deliberate exception — a remote LiteLLM proxy
      // can't satisfy a localhost endpoint. Covered separately in the
      // "local provider" describe block.
      if (entry.provider === "local") continue;
      expect(entry.credentialConfigured).toBe(true);
      // When LiteLLM covers everything there's nothing actionable to add.
      expect(entry.credentialEnvVar).toBeNull();
    }
  });
});

describe("model-catalog — groq direct fetch", () => {
  it("fetches groq models directly when GROQ_API_KEY is set and filters audio models", async () => {
    stubEnv({ GROQ_API_KEY: "gsk_test" });
    const groq = groqListResponse([
      "llama-3.3-70b-versatile",
      "openai/gpt-oss-120b",
      "whisper-large-v3", // filtered
      "playai-tts-arabic", // filtered
      "distil-whisper-large-v3-en", // filtered
    ]);
    vi.stubGlobal("fetch", mockJsonFetch({ [GATEWAY_URL]: { models: [] }, [GROQ_URL]: groq }));

    const catalog = await getCatalog();
    const entry = find(catalog, "groq");
    expect(entry.credentialConfigured).toBe(true);
    expect(entry.models.map((m) => m.id)).toEqual([
      "llama-3.3-70b-versatile",
      "openai/gpt-oss-120b",
    ]);
    expect(entry.error).toBeUndefined();
  });

  it("surfaces a per-provider error when the groq fetch fails but leaves others intact", async () => {
    stubEnv({ GROQ_API_KEY: "gsk_test" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === GATEWAY_URL) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ models: [] }),
          } as unknown as Response);
        }
        if (url === GROQ_URL) {
          return Promise.resolve({
            ok: false,
            status: 401,
            json: () => Promise.resolve({}),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
        } as unknown as Response);
      }),
    );

    const catalog = await getCatalog();
    const groq = find(catalog, "groq");
    expect(groq.models).toEqual([]);
    expect(groq.error).toMatch(/HTTP 401/);
    expect(groq.credentialConfigured).toBe(true); // key IS set, fetch just failed
    // Other providers still resolved normally.
    expect(find(catalog, "anthropic").error).toBeUndefined();
  });
});

describe("model-catalog — local provider", () => {
  // LM Studio, Ollama, vLLM, and llama.cpp all return this exact OpenAI-
  // standard `/v1/models` shape. Use a representative sample of each.
  function localListResponse(ids: string[]): Record<string, unknown> {
    return { data: ids.map((id) => ({ id, object: "model" })) };
  }

  it("fetches models from a local server when LOCAL_BASE_URL is set", async () => {
    stubEnv({ LOCAL_BASE_URL: "http://localhost:1234/v1" });
    const lmStudio = localListResponse(["llama-3.2-3b-instruct", "qwen2.5-coder-7b-instruct"]);
    vi.stubGlobal(
      "fetch",
      mockJsonFetch({ [GATEWAY_URL]: { models: [] }, "http://localhost:1234/v1/models": lmStudio }),
    );

    const catalog = await getCatalog();
    const entry = find(catalog, "local");
    expect(entry.credentialConfigured).toBe(true);
    expect(entry.credentialEnvVar).toBe("LOCAL_BASE_URL");
    expect(entry.models.map((m) => m.id)).toEqual([
      "llama-3.2-3b-instruct",
      "qwen2.5-coder-7b-instruct",
    ]);
    expect(entry.error).toBeUndefined();
  });

  it("normalizes a trailing slash on LOCAL_BASE_URL when building the /models URL", async () => {
    stubEnv({ LOCAL_BASE_URL: "http://localhost:11434/v1/" });
    vi.stubGlobal(
      "fetch",
      mockJsonFetch({
        [GATEWAY_URL]: { models: [] },
        // Note: no double slash before /models.
        "http://localhost:11434/v1/models": localListResponse(["llama3.1:8b"]),
      }),
    );

    const catalog = await getCatalog();
    const entry = find(catalog, "local");
    expect(entry.models.map((m) => m.id)).toEqual(["llama3.1:8b"]);
  });

  it("reports credentialConfigured=false and no error when LOCAL_BASE_URL is unset", async () => {
    vi.stubGlobal("fetch", mockJsonFetch({ [GATEWAY_URL]: { models: [] } }));

    const catalog = await getCatalog();
    const entry = find(catalog, "local");
    expect(entry.credentialConfigured).toBe(false);
    expect(entry.credentialEnvVar).toBe("LOCAL_BASE_URL");
    expect(entry.models).toEqual([]);
    // No env var, no fetch attempt — so no error to surface either.
    expect(entry.error).toBeUndefined();
  });

  it("surfaces a per-provider error when the local fetch fails (server not running)", async () => {
    stubEnv({ LOCAL_BASE_URL: "http://localhost:1234/v1" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === GATEWAY_URL) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ models: [] }),
          } as unknown as Response);
        }
        if (url === "http://localhost:1234/v1/models") {
          // Real connection-refused throws — fetch rejects rather than 404s.
          return Promise.reject(new Error("fetch failed: ECONNREFUSED"));
        }
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
        } as unknown as Response);
      }),
    );

    const catalog = await getCatalog();
    const entry = find(catalog, "local");
    expect(entry.models).toEqual([]);
    expect(entry.error).toMatch(/ECONNREFUSED/);
    // Env var IS set, the fetch just failed — UI shows "server not running",
    // not "configure your credentials."
    expect(entry.credentialConfigured).toBe(true);
    // Other providers stay unaffected.
    expect(find(catalog, "anthropic").error).toBeUndefined();
  });

  it("local is NOT auto-credentialed by LITELLM_API_KEY (localhost is not proxyable)", async () => {
    stubEnv({ LITELLM_API_KEY: "sk-litellm", LOCAL_BASE_URL: undefined });
    vi.stubGlobal("fetch", mockJsonFetch({ [GATEWAY_URL]: { models: [] } }));

    const catalog = await getCatalog();
    const entry = find(catalog, "local");
    expect(entry.credentialConfigured).toBe(false);
    // And the envVar hint stays actionable instead of being null'd out
    // like the other providers under LiteLLM proxy mode.
    expect(entry.credentialEnvVar).toBe("LOCAL_BASE_URL");
  });
});

describe("model-catalog — cache", () => {
  it("serves the second call from cache and fires the fetch only once", async () => {
    const fetchMock = mockJsonFetch({ [GATEWAY_URL]: { models: [] } });
    vi.stubGlobal("fetch", fetchMock);

    await getCatalog();
    await getCatalog();
    await getCatalog();

    // One catalog fetch = 2 HTTP calls (gateway + openrouter). Cache hit on
    // calls 2 and 3 means no further requests.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent callers onto a single in-flight fetch (no thundering herd)", async () => {
    let resolveGateway!: (v: Response) => void;
    const gatewayPromise = new Promise<Response>((res) => {
      resolveGateway = res;
    });
    const fetchMock = vi.fn((url: string) => {
      if (url === GATEWAY_URL) return gatewayPromise;
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const a = getCatalog();
    const b = getCatalog();
    const c = getCatalog();
    resolveGateway({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ models: [] }),
    } as unknown as Response);
    await Promise.all([a, b, c]);

    // 2 HTTP calls per catalog fetch (gateway + openrouter); the three
    // concurrent callers share the one in-flight fetchCatalog.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("discards an in-flight fetch's result when invalidateCatalog runs before it resolves", async () => {
    // Reproduces the PUT /env race: a getCatalog() fetch starts under one
    // env, the user adds GROQ_API_KEY, invalidateCatalog() runs, then the
    // stale in-flight result resolves. Without a generation guard that
    // stale result would pin `cache` for the full TTL.
    let resolveGateway!: (v: Response) => void;
    const gatewayPromise = new Promise<Response>((res) => {
      resolveGateway = res;
    });
    const staleModels = [gatewayModel("anthropic", "anthropic/claude-sonnet-4.6", "Sonnet 4.6")];
    const freshModels = [gatewayModel("anthropic", "anthropic/claude-haiku-4.5", "Haiku 4.5")];
    let call = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === GATEWAY_URL) {
        call++;
        if (call === 1) return gatewayPromise;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ models: freshModels }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const inflight = getCatalog();
    invalidateCatalog();
    resolveGateway({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ models: staleModels }),
    } as unknown as Response);
    await inflight;

    // Next call must start a fresh fetch, not return the stale cached one.
    const after = await getCatalog();
    // 2 catalog fetches × 2 HTTP calls each (gateway + openrouter) = 4.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(find(after, "anthropic").models.map((m) => m.id)).toEqual(["claude-haiku-4-5"]);
  });
});

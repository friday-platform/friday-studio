import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Catalog,
  type CatalogEntry,
  type CatalogProvider,
  getCatalog,
  resetCatalogCacheForTests,
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
  resetCatalogCacheForTests();
  stubEnv({
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
    GROQ_API_KEY: undefined,
    LITELLM_API_KEY: undefined,
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

    const anthropic = find(catalog, "anthropic");
    expect(anthropic.models.map((m) => m.id)).toEqual([
      "anthropic:claude-sonnet-4.6",
      "anthropic:claude-haiku-4.5",
    ]);

    // claude-code mirrors anthropic with a re-prefixed id.
    const claudeCode = find(catalog, "claude-code");
    expect(claudeCode.models.map((m) => m.id)).toEqual([
      "claude-code:claude-sonnet-4.6",
      "claude-code:claude-haiku-4.5",
    ]);

    const openai = find(catalog, "openai");
    expect(openai.models.map((m) => m.id)).toEqual(["openai:gpt-5.4"]);

    // Google: only gemini-* text models via the `vertex` namespace.
    // `-image` variants must be dropped even when modelType=language.
    const google = find(catalog, "google");
    expect(google.models.map((m) => m.id)).toEqual(["google:gemini-3-pro-preview"]);

    // Groq gets nothing from the gateway path; it's filled from the
    // direct-Groq fetch when a key is present (covered in another test).
    expect(find(catalog, "groq").models).toEqual([]);
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
    expect(find(catalog, "claude-code")).toMatchObject({
      credentialConfigured: false,
      // claude-code shares the anthropic key — the hint must point there.
      credentialEnvVar: "ANTHROPIC_API_KEY",
    });
  });

  it("unlocks every provider when LITELLM_API_KEY is set (proxy mode)", async () => {
    stubEnv({ LITELLM_API_KEY: "sk-litellm" });
    vi.stubGlobal("fetch", mockJsonFetch({ [GATEWAY_URL]: { models: [] } }));

    const catalog = await getCatalog();
    for (const entry of catalog.entries) {
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
      "groq:llama-3.3-70b-versatile",
      "groq:openai/gpt-oss-120b",
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

describe("model-catalog — cache", () => {
  it("serves the second call from cache and fires the fetch only once", async () => {
    const fetchMock = mockJsonFetch({ [GATEWAY_URL]: { models: [] } });
    vi.stubGlobal("fetch", fetchMock);

    await getCatalog();
    await getCatalog();
    await getCatalog();

    expect(fetchMock).toHaveBeenCalledTimes(1);
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

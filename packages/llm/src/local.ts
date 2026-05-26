import process from "node:process";
import { createOpenAI, type OpenAIProvider, type OpenAIProviderSettings } from "@ai-sdk/openai";
import { createProxyFetch, PROVIDER_ENV_VARS } from "./util.ts";

/**
 * Configuration options for creating a local OpenAI-compatible client.
 *
 * Targets self-hosted runtimes that speak OpenAI's Chat Completions API
 * — LM Studio (`http://localhost:1234/v1`), Ollama
 * (`http://localhost:11434/v1`), vLLM, llama.cpp's server, and anything
 * else that mirrors the same shape.
 */
interface LocalOptions {
  /** Base URL for the local server. Defaults to LOCAL_BASE_URL env var, then to LM Studio's default port. */
  baseURL?: string;
  /** API key. Most local servers ignore it; defaults to LOCAL_API_KEY env var, then to a dummy string. */
  apiKey?: string;
  /** HTTP proxy URL. Defaults to LOCAL_PROXY_URL env var. */
  httpProxy?: string;
}

/**
 * Creates a client for a local OpenAI-compatible LLM server.
 *
 * `LOCAL_BASE_URL` is what unlocks this provider — see
 * `hasCredential` in `platform-models.ts` and `resolveCredential` in
 * `model-catalog.ts`. The constructor itself falls back to LM Studio's
 * default port so a stray invocation surfaces a connection error against
 * a plausible address rather than something cryptic.
 *
 * `apiKey` defaults to the literal string `"local"` because most local
 * servers ignore auth entirely, but `@ai-sdk/openai` requires a non-empty
 * string and 401s if you pass `undefined`.
 */
export function createLocalWithOptions(opts: LocalOptions = {}): OpenAIProvider {
  const httpProxy = opts.httpProxy || process.env.LOCAL_PROXY_URL;

  const localOptions: OpenAIProviderSettings = {
    apiKey: opts.apiKey || process.env[PROVIDER_ENV_VARS.local] || "local",
    baseURL: opts.baseURL || process.env.LOCAL_BASE_URL || "http://localhost:1234/v1",
  };
  if (httpProxy) {
    localOptions.fetch = createProxyFetch(httpProxy);
  }
  return createOpenAI(localOptions);
}

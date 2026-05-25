import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalWithOptions } from "./local.ts";

/**
 * Smoke test for the constructor — purely shape-level. The actual HTTP
 * traffic isn't exercised here (no MockAgent / no real server); we rely on
 * `@ai-sdk/openai` (a third-party SDK) to honor the `baseURL` we pass.
 * Matches the repo precedent: `openrouter.ts` ships with zero tests.
 */
describe("createLocalWithOptions", () => {
  const envBackup: Record<string, string | undefined> = {};
  function withEnv(vars: Record<string, string | undefined>) {
    for (const k of Object.keys(vars)) {
      envBackup[k] = process.env[k];
      if (vars[k] === undefined) delete process.env[k];
      else process.env[k] = vars[k];
    }
  }
  afterEach(() => {
    for (const k of Object.keys(envBackup)) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    for (const k of Object.keys(envBackup)) delete envBackup[k];
  });

  it("returns a provider when explicit options are passed", () => {
    const provider = createLocalWithOptions({
      baseURL: "http://localhost:1234/v1",
      apiKey: "test",
    });
    // The provider is a callable function that also exposes `.chat()`.
    expect(typeof provider.chat).toBe("function");
    expect(typeof provider.languageModel).toBe("function");
  });

  it("reads baseURL and apiKey from env vars when options are omitted", () => {
    withEnv({ LOCAL_BASE_URL: "http://localhost:11434/v1", LOCAL_API_KEY: "ollama" });
    const provider = createLocalWithOptions();
    expect(typeof provider.chat).toBe("function");
  });

  it("does not throw when LOCAL_BASE_URL is unset (falls back to LM Studio default)", () => {
    withEnv({ LOCAL_BASE_URL: undefined, LOCAL_API_KEY: undefined });
    // Construction must not throw — the registry instantiates this provider
    // eagerly even for users who never use it. Credential gating elsewhere
    // ensures it's only *invoked* when LOCAL_BASE_URL is set.
    expect(() => createLocalWithOptions()).not.toThrow();
  });
});

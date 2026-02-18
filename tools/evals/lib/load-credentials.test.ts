import process from "node:process";
import { describe, expect, it } from "vitest";
import { type CredentialDeps, loadCredentials } from "./load-credentials.ts";

function createMockDeps(): CredentialDeps & {
  fetchCalls: Array<{ atlasKey: string; retries: number; retryDelay: number }>;
  setEnvCalls: Array<Record<string, string>>;
} {
  const fetchCalls: Array<{ atlasKey: string; retries: number; retryDelay: number }> = [];
  const setEnvCalls: Array<Record<string, string>> = [];

  return {
    fetchCalls,
    setEnvCalls,
    // deno-lint-ignore require-await
    fetch: async (opts) => {
      fetchCalls.push(opts);
      return { OPENAI_API_KEY: "sk-test" };
    },
    setEnv: (creds) => {
      setEnvCalls.push(creds);
      return { setCount: Object.keys(creds).length, skippedCount: 0 };
    },
  };
}

describe("loadCredentials", () => {
  it("fetches credentials with ATLAS_KEY and pipes to setEnv", async () => {
    const hadKey = !!process.env.ATLAS_KEY;
    if (!hadKey) process.env.ATLAS_KEY = "test-key";

    try {
      const deps = createMockDeps();
      await loadCredentials(deps);

      expect(deps.fetchCalls).toHaveLength(1);
      expect(deps.setEnvCalls).toHaveLength(1);
      expect(deps.setEnvCalls[0]).toMatchObject({ OPENAI_API_KEY: "sk-test" });
    } finally {
      if (!hadKey) delete process.env.ATLAS_KEY;
    }
  });

  it("throws when ATLAS_KEY missing after dotenv load", async () => {
    const saved = process.env.ATLAS_KEY;
    delete process.env.ATLAS_KEY;

    const savedHome = process.env.HOME;
    process.env.HOME = "/nonexistent";
    const savedAtlasHome = process.env.ATLAS_HOME;
    delete process.env.ATLAS_HOME;

    try {
      const deps = createMockDeps();
      await expect(loadCredentials(deps)).rejects.toThrow(
        "ATLAS_KEY environment variable is not set",
      );

      expect(deps.fetchCalls).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.ATLAS_KEY = saved;
      if (savedHome !== undefined) process.env.HOME = savedHome;
      if (savedAtlasHome !== undefined) process.env.ATLAS_HOME = savedAtlasHome;
    }
  });
});

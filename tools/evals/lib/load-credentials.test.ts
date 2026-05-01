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
  it("fetches credentials with FRIDAY_KEY and pipes to setEnv", async () => {
    const hadKey = !!process.env.FRIDAY_KEY;
    if (!hadKey) process.env.FRIDAY_KEY = "test-key";

    try {
      const deps = createMockDeps();
      await loadCredentials(deps);

      expect(deps.fetchCalls).toHaveLength(1);
      expect(deps.setEnvCalls).toHaveLength(1);
      expect(deps.setEnvCalls[0]).toMatchObject({ OPENAI_API_KEY: "sk-test" });
    } finally {
      if (!hadKey) delete process.env.FRIDAY_KEY;
    }
  });

  it("throws when FRIDAY_KEY missing after dotenv load", async () => {
    const saved = process.env.FRIDAY_KEY;
    delete process.env.FRIDAY_KEY;

    const savedHome = process.env.HOME;
    process.env.HOME = "/nonexistent";
    const savedAtlasHome = process.env.FRIDAY_HOME;
    delete process.env.FRIDAY_HOME;

    try {
      const deps = createMockDeps();
      await expect(loadCredentials(deps)).rejects.toThrow(
        "FRIDAY_KEY environment variable is not set",
      );

      expect(deps.fetchCalls).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.FRIDAY_KEY = saved;
      if (savedHome !== undefined) process.env.HOME = savedHome;
      if (savedAtlasHome !== undefined) process.env.FRIDAY_HOME = savedAtlasHome;
    }
  });
});

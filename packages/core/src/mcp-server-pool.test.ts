import type { MCPServerConfig } from "@atlas/config";
import { describe, expect, it } from "vitest";
import { GlobalMCPServerPool } from "./mcp-server-pool.ts";

// Minimal logger stub — pool constructor requires it
const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => stubLogger,
};

function makePool() {
  return new GlobalMCPServerPool(stubLogger as unknown as import("@atlas/logger").Logger);
}

function makeConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    transport: { type: "http", url: "http://localhost:3000/mcp" },
    ...overrides,
  } as MCPServerConfig;
}

describe("generateConfigKey", () => {
  it("produces the same key for identical configs", () => {
    const pool = makePool();
    const configs = { "server-a": makeConfig(), "server-b": makeConfig() };

    const key1 = pool.generateConfigKey(configs);
    const key2 = pool.generateConfigKey(configs);

    expect(key1).toBe(key2);
  });

  it("produces the same key regardless of insertion order", () => {
    const pool = makePool();
    const a = makeConfig({ transport: { type: "http", url: "http://a/mcp" } });
    const b = makeConfig({ transport: { type: "http", url: "http://b/mcp" } });

    const key1 = pool.generateConfigKey({ "server-a": a, "server-b": b });
    const key2 = pool.generateConfigKey({ "server-b": b, "server-a": a });

    expect(key1).toBe(key2);
  });

  const differingConfigs = [
    {
      name: "different transport URLs",
      configA: { srv: makeConfig({ transport: { type: "http" as const, url: "http://a/mcp" } }) },
      configB: { srv: makeConfig({ transport: { type: "http" as const, url: "http://b/mcp" } }) },
    },
    {
      name: "different auth",
      configA: { srv: makeConfig({ auth: { type: "bearer" as const, token_env: "TOKEN_A" } }) },
      configB: { srv: makeConfig({ auth: { type: "bearer" as const, token_env: "TOKEN_B" } }) },
    },
    {
      name: "different env",
      configA: { srv: makeConfig({ env: { API_KEY: "key-a" } }) },
      configB: { srv: makeConfig({ env: { API_KEY: "key-b" } }) },
    },
    {
      name: "different server IDs",
      configA: { alpha: makeConfig() },
      configB: { beta: makeConfig() },
    },
  ] as const;

  it.each(differingConfigs)("produces different keys for $name", ({ configA, configB }) => {
    const pool = makePool();
    expect(pool.generateConfigKey(configA)).not.toBe(pool.generateConfigKey(configB));
  });
});

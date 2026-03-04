import type { MCPServerConfig } from "@atlas/config";
import { MCPManager } from "@atlas/mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
} from "./mcp-registry/credential-resolver.ts";
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

describe("getMCPManager — credential error propagation", () => {
  let disposeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    disposeSpy = vi.spyOn(MCPManager.prototype, "dispose").mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-throws when registerServer fails with LinkCredentialNotFoundError", async () => {
    const credError = new LinkCredentialNotFoundError("cred_deleted_xyz");

    vi.spyOn(MCPManager.prototype, "registerServer").mockRejectedValue(credError);

    const pool = makePool();
    const configs = { slack: makeConfig() };

    await expect(pool.getMCPManager(configs)).rejects.toThrow(credError);
    expect(disposeSpy).toHaveBeenCalledOnce();
    expect(pool.getPoolStats().totalPooledManagers).toBe(0);
    await pool.dispose();
  });

  it("re-throws when registerServer fails with LinkCredentialExpiredError", async () => {
    const expiredError = new LinkCredentialExpiredError("cred_expired_abc", "expired_no_refresh");

    vi.spyOn(MCPManager.prototype, "registerServer").mockRejectedValue(expiredError);

    const pool = makePool();
    const configs = { github: makeConfig() };

    await expect(pool.getMCPManager(configs)).rejects.toThrow(expiredError);
    expect(disposeSpy).toHaveBeenCalledOnce();
    expect(pool.getPoolStats().totalPooledManagers).toBe(0);
    await pool.dispose();
  });

  it("swallows non-credential registration errors and continues", async () => {
    vi.spyOn(MCPManager.prototype, "registerServer").mockRejectedValue(
      new Error("connection refused"),
    );

    const pool = makePool();
    const configs = { slack: makeConfig() };

    // Should NOT throw — error is swallowed, manager returned and cached
    const manager = await pool.getMCPManager(configs);
    expect(manager).toBeInstanceOf(MCPManager);
    expect(pool.getPoolStats().totalPooledManagers).toBe(1);
    await pool.dispose();
  });
});

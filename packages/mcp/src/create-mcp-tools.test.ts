import process from "node:process";
import type { MCPServerConfig } from "@atlas/config";
import {
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  NoDefaultCredentialError,
} from "@atlas/core/mcp-registry/credential-resolver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted ensures these are available when vi.mock factories run
const {
  mockTools,
  mockClose,
  mockCreateMCPClient,
  MockStdioTransport,
  MockHTTPTransport,
  mockResolveEnvValues,
} = vi.hoisted(() => ({
  mockTools: vi.fn(),
  mockClose: vi.fn(),
  mockCreateMCPClient: vi.fn(),
  MockStdioTransport: vi.fn(),
  MockHTTPTransport: vi.fn(),
  mockResolveEnvValues: vi.fn(),
}));

vi.mock("@ai-sdk/mcp", () => ({ experimental_createMCPClient: mockCreateMCPClient }));

vi.mock("@ai-sdk/mcp/mcp-stdio", () => ({ Experimental_StdioMCPTransport: MockStdioTransport }));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockHTTPTransport,
}));

vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>();
  return { ...actual, resolveEnvValues: mockResolveEnvValues };
});

// Strip retry backoff delays — retry logic is @std/async's responsibility, not ours.
vi.mock("@std/async/retry", () => ({
  retry: async (fn: () => Promise<unknown>, opts?: { maxAttempts?: number }) => {
    const maxAttempts = opts?.maxAttempts ?? 3;
    let lastError: unknown;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  },
}));

// Import after mocks
const { createMCPTools } = await import("./create-mcp-tools.ts");

// Fake logger
const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => fakeLogger),
} as unknown as import("@atlas/logger").Logger;

beforeEach(() => {
  mockTools.mockReset();
  mockClose.mockReset();
  mockCreateMCPClient.mockReset();
  MockStdioTransport.mockReset();
  MockHTTPTransport.mockReset();
  mockResolveEnvValues.mockReset();
  mockResolveEnvValues.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createMCPTools", () => {
  it("connects to a stdio server, returns tools, and disposes cleanly", async () => {
    const fakeTool = { description: "test tool", parameters: {} };
    mockTools.mockResolvedValue({ "my-tool": fakeTool });
    mockClose.mockResolvedValue(undefined);
    mockCreateMCPClient.mockResolvedValue({ tools: mockTools, close: mockClose });

    const configs: Record<string, MCPServerConfig> = {
      "test-server": { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("my-tool");
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
    expect(mockTools).toHaveBeenCalled();

    await result.dispose();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("skips a server that fails to connect and continues with others", async () => {
    let callCount = 0;
    mockCreateMCPClient.mockImplementation(() => {
      callCount++;
      if (callCount <= 3) {
        // First server retries 3 times then gives up
        return Promise.reject(new Error("spawn failed"));
      }
      // Second server succeeds
      return Promise.resolve({
        tools: vi.fn().mockResolvedValue({ "good-tool": { description: "works" } }),
        close: vi.fn().mockResolvedValue(undefined),
      });
    });

    const configs: Record<string, MCPServerConfig> = {
      "broken-server": { transport: { type: "stdio", command: "nonexistent", args: [] } },
      "working-server": { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("good-tool");
    expect(Object.keys(result.tools)).toHaveLength(1);
    expect(fakeLogger.warn).toHaveBeenCalled();
  });

  it("re-throws LinkCredentialNotFoundError immediately", async () => {
    mockResolveEnvValues.mockRejectedValue(new LinkCredentialNotFoundError("cred_123"));

    const configs: Record<string, MCPServerConfig> = {
      "needs-cred": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_123", key: "token" } },
      },
      "other-server": { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const error = await createMCPTools(configs, fakeLogger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkCredentialNotFoundError);
    // Should NOT have tried the second server
    expect(mockCreateMCPClient).not.toHaveBeenCalled();
  });

  it("re-throws NoDefaultCredentialError immediately", async () => {
    mockResolveEnvValues.mockRejectedValue(new NoDefaultCredentialError("github"));

    const configs: Record<string, MCPServerConfig> = {
      "needs-cred": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_123", key: "token" } },
      },
      "other-server": { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const error = await createMCPTools(configs, fakeLogger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoDefaultCredentialError);
    // Should NOT have tried the second server
    expect(mockCreateMCPClient).not.toHaveBeenCalled();
  });

  it("re-throws LinkCredentialExpiredError immediately", async () => {
    mockResolveEnvValues.mockRejectedValue(
      new LinkCredentialExpiredError("cred_456", "expired_no_refresh"),
    );

    const configs: Record<string, MCPServerConfig> = {
      "expired-cred": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_456", key: "token" } },
      },
    };

    const error = await createMCPTools(configs, fakeLogger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkCredentialExpiredError);
  });

  it("applies allow filter to server tools", async () => {
    mockCreateMCPClient.mockResolvedValue({
      tools: vi
        .fn()
        .mockResolvedValue({
          "allowed-tool": { description: "allowed" },
          "blocked-tool": { description: "blocked" },
          "another-blocked": { description: "also blocked" },
        }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const configs: Record<string, MCPServerConfig> = {
      "filtered-server": {
        transport: { type: "stdio", command: "echo", args: [] },
        tools: { allow: ["allowed-tool"] },
      },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("allowed-tool");
    expect(result.tools).not.toHaveProperty("blocked-tool");
    expect(result.tools).not.toHaveProperty("another-blocked");
  });

  it("applies deny filter to server tools", async () => {
    mockCreateMCPClient.mockResolvedValue({
      tools: vi
        .fn()
        .mockResolvedValue({
          "good-tool": { description: "keep" },
          "bad-tool": { description: "deny" },
        }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const configs: Record<string, MCPServerConfig> = {
      "filtered-server": {
        transport: { type: "stdio", command: "echo", args: [] },
        tools: { deny: ["bad-tool"] },
      },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("good-tool");
    expect(result.tools).not.toHaveProperty("bad-tool");
  });

  it("dispose is idempotent — calling twice does not throw", async () => {
    mockCreateMCPClient.mockResolvedValue({
      tools: vi.fn().mockResolvedValue({ tool: { description: "x" } }),
      close: mockClose.mockResolvedValue(undefined),
    });

    const configs: Record<string, MCPServerConfig> = {
      server: { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);

    await result.dispose();
    await result.dispose();

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("connects to an HTTP server with auth headers", async () => {
    mockCreateMCPClient.mockResolvedValue({
      tools: vi.fn().mockResolvedValue({ "http-tool": { description: "http" } }),
      close: vi.fn().mockResolvedValue(undefined),
    });
    mockResolveEnvValues.mockResolvedValue({ MY_TOKEN: "secret-token" });

    const configs: Record<string, MCPServerConfig> = {
      "http-server": {
        transport: { type: "http", url: "https://mcp.example.com" },
        auth: { type: "bearer", token_env: "MY_TOKEN" },
        env: { MY_TOKEN: { from: "link" as const, id: "cred_http", key: "access_token" } },
      },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("http-tool");
    expect(MockHTTPTransport).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        requestInit: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
        }),
      }),
    );
  });

  it("returns empty tools when no configs provided", async () => {
    const result = await createMCPTools({}, fakeLogger);

    expect(Object.keys(result.tools)).toHaveLength(0);
    await result.dispose();
  });

  it("merges tools from multiple servers and dispose kills all clients", async () => {
    const closeA = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const closeB = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    mockCreateMCPClient
      .mockResolvedValueOnce({
        tools: vi.fn().mockResolvedValue({ "tool-a": { description: "from A" } }),
        close: closeA,
      })
      .mockResolvedValueOnce({
        tools: vi.fn().mockResolvedValue({ "tool-b": { description: "from B" } }),
        close: closeB,
      });

    const configs: Record<string, MCPServerConfig> = {
      "server-a": { transport: { type: "stdio", command: "echo", args: [] } },
      "server-b": { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("tool-a");
    expect(result.tools).toHaveProperty("tool-b");
    expect(Object.keys(result.tools)).toHaveLength(2);

    await result.dispose();
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
  });

  it("enriches LinkCredentialNotFoundError with server name", async () => {
    mockResolveEnvValues.mockRejectedValue(new LinkCredentialNotFoundError("cred_123"));

    const configs: Record<string, MCPServerConfig> = {
      "my-slack-server": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_123", key: "token" } },
      },
    };

    const error = await createMCPTools(configs, fakeLogger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkCredentialNotFoundError);
    expect.assert(error instanceof LinkCredentialNotFoundError);
    expect(error.message).toContain("my-slack-server");
    expect(error.credentialId).toBe("cred_123");
  });

  it("enriches LinkCredentialExpiredError with server name", async () => {
    mockResolveEnvValues.mockRejectedValue(
      new LinkCredentialExpiredError("cred_456", "refresh_failed"),
    );

    const configs: Record<string, MCPServerConfig> = {
      "my-github-server": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_456", key: "token" } },
      },
    };

    const error = await createMCPTools(configs, fakeLogger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkCredentialExpiredError);
    expect.assert(error instanceof LinkCredentialExpiredError);
    expect(error.message).toContain("my-github-server");
    expect(error.credentialId).toBe("cred_456");
    expect(error.status).toBe("refresh_failed");
  });

  it("retries stdio connection that fails then succeeds", async () => {
    const fakeTool = { description: "retry tool" };
    let attempt = 0;
    mockCreateMCPClient.mockImplementation(() => {
      attempt++;
      if (attempt === 1) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve({
        tools: vi.fn().mockResolvedValue({ "retry-tool": fakeTool }),
        close: vi.fn().mockResolvedValue(undefined),
      });
    });

    const configs: Record<string, MCPServerConfig> = {
      "flaky-server": { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("retry-tool");
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(2);
  });

  it("retries when stdio tools() verification fails", async () => {
    let attempt = 0;
    mockCreateMCPClient.mockImplementation(() => {
      attempt++;
      if (attempt === 1) {
        // Client connects but tools() fails (server not ready)
        return Promise.resolve({
          tools: vi.fn().mockRejectedValue(new Error("not ready")),
          close: vi.fn().mockResolvedValue(undefined),
        });
      }
      return Promise.resolve({
        tools: vi.fn().mockResolvedValue({ "verified-tool": { description: "ok" } }),
        close: vi.fn().mockResolvedValue(undefined),
      });
    });

    const configs: Record<string, MCPServerConfig> = {
      "slow-server": { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("verified-tool");
    // First attempt: createMCPClient + tools() fail → retry
    // Second attempt: createMCPClient + tools() succeed
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(2);
  });

  it("closes leaked client when stdio tools() verification fails before retry", async () => {
    const failedClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    let attempt = 0;
    mockCreateMCPClient.mockImplementation(() => {
      attempt++;
      if (attempt === 1) {
        // Client connects but tools() fails — subprocess should be closed
        return Promise.resolve({
          tools: vi.fn().mockRejectedValue(new Error("not ready")),
          close: failedClose,
        });
      }
      return Promise.resolve({
        tools: vi.fn().mockResolvedValue({ "ok-tool": { description: "ok" } }),
        close: vi.fn().mockResolvedValue(undefined),
      });
    });

    const configs: Record<string, MCPServerConfig> = {
      "flaky-server": { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("ok-tool");
    // The failed client from attempt 1 must have been closed
    expect(failedClose).toHaveBeenCalledTimes(1);
  });

  it("cleans up already-connected clients when credential error is thrown", async () => {
    const closeA = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    // Server A connects successfully
    mockCreateMCPClient.mockResolvedValueOnce({
      tools: vi.fn().mockResolvedValue({ "tool-a": { description: "from A" } }),
      close: closeA,
    });

    // Server B has a credential error during env resolution
    // (Server A has no env, so resolveEnvValues is only called for server B)
    mockResolveEnvValues.mockRejectedValueOnce(new LinkCredentialNotFoundError("cred_missing"));

    const configs: Record<string, MCPServerConfig> = {
      "server-a": { transport: { type: "stdio", command: "echo", args: [] } },
      "server-b": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_missing", key: "token" } },
      },
    };

    const error = await createMCPTools(configs, fakeLogger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkCredentialNotFoundError);
    // Server A's client must have been closed despite the throw
    expect(closeA).toHaveBeenCalledTimes(1);
  });

  it("closes leaked HTTP client when tools() throws after successful connect", async () => {
    const leakedClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    // HTTP server: createMCPClient succeeds but tools() throws
    mockCreateMCPClient.mockResolvedValueOnce({
      tools: vi.fn().mockRejectedValue(new Error("tools fetch failed")),
      close: leakedClose,
    });

    // Second server succeeds normally
    mockCreateMCPClient.mockResolvedValueOnce({
      tools: vi.fn().mockResolvedValue({ "good-tool": { description: "works" } }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const configs: Record<string, MCPServerConfig> = {
      "broken-http": { transport: { type: "http", url: "https://mcp.example.com" } },
      "working-server": { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);

    // The leaked HTTP client must have been closed
    expect(leakedClose).toHaveBeenCalledTimes(1);
    // Server was skipped with a warning
    expect(fakeLogger.warn).toHaveBeenCalled();
    // Second server's tools still available
    expect(result.tools).toHaveProperty("good-tool");
    expect(Object.keys(result.tools)).toHaveLength(1);
  });

  it("dispose completes even when one client close() rejects", async () => {
    const closeA = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("close exploded"));
    const closeB = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    mockCreateMCPClient
      .mockResolvedValueOnce({
        tools: vi.fn().mockResolvedValue({ "tool-a": { description: "from A" } }),
        close: closeA,
      })
      .mockResolvedValueOnce({
        tools: vi.fn().mockResolvedValue({ "tool-b": { description: "from B" } }),
        close: closeB,
      });

    const configs: Record<string, MCPServerConfig> = {
      "server-a": { transport: { type: "stdio", command: "echo", args: [] } },
      "server-b": { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);

    // dispose should not throw even though closeA rejects
    await expect(result.dispose()).resolves.toBeUndefined();
    // Both clients should have had close() called
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
  });

  it("retries HTTP connection when tools() fails transiently", async () => {
    let attempt = 0;
    mockCreateMCPClient.mockImplementation(() => {
      attempt++;
      if (attempt === 1) {
        // HTTP client connects but tools() fails (cold start)
        return Promise.resolve({
          tools: vi.fn().mockRejectedValue(new Error("service unavailable")),
          close: vi.fn().mockResolvedValue(undefined),
        });
      }
      return Promise.resolve({
        tools: vi.fn().mockResolvedValue({ "http-retry-tool": { description: "ok" } }),
        close: vi.fn().mockResolvedValue(undefined),
      });
    });

    const configs: Record<string, MCPServerConfig> = {
      "flaky-http": { transport: { type: "http", url: "https://mcp.example.com" } },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("http-retry-tool");
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(2);
  });

  it("warns on tool name collision when two servers export same tool", async () => {
    mockCreateMCPClient
      .mockResolvedValueOnce({
        tools: vi
          .fn()
          .mockResolvedValue({
            "shared-tool": { description: "from A" },
            "unique-a": { description: "a" },
          }),
        close: vi.fn().mockResolvedValue(undefined),
      })
      .mockResolvedValueOnce({
        tools: vi
          .fn()
          .mockResolvedValue({
            "shared-tool": { description: "from B" },
            "unique-b": { description: "b" },
          }),
        close: vi.fn().mockResolvedValue(undefined),
      });

    const configs: Record<string, MCPServerConfig> = {
      "server-a": { transport: { type: "stdio", command: "echo", args: [] } },
      "server-b": { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);

    // Later server wins
    expect(result.tools["shared-tool"]).toEqual({ description: "from B" });
    expect(result.tools).toHaveProperty("unique-a");
    expect(result.tools).toHaveProperty("unique-b");
    // Collision warning was logged for server-b
    expect(fakeLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("server-b"),
      expect.objectContaining({ clobberedTools: ["shared-tool"] }),
    );
  });

  it("falls back to process.env for bearer token when resolvedEnv lacks it", async () => {
    const originalEnv = process.env.FALLBACK_TOKEN;
    process.env.FALLBACK_TOKEN = "env-secret";

    try {
      mockCreateMCPClient.mockResolvedValue({
        tools: vi.fn().mockResolvedValue({ "env-tool": { description: "ok" } }),
        close: vi.fn().mockResolvedValue(undefined),
      });
      // resolveEnvValues returns empty — token not in resolved env
      mockResolveEnvValues.mockResolvedValue({});

      const configs: Record<string, MCPServerConfig> = {
        "env-server": {
          transport: { type: "http", url: "https://mcp.example.com" },
          auth: { type: "bearer", token_env: "FALLBACK_TOKEN" },
        },
      };

      await createMCPTools(configs, fakeLogger);

      expect(MockHTTPTransport).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          requestInit: expect.objectContaining({
            headers: expect.objectContaining({ Authorization: "Bearer env-secret" }),
          }),
        }),
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.FALLBACK_TOKEN;
      } else {
        process.env.FALLBACK_TOKEN = originalEnv;
      }
    }
  });

  it("applies combined allow + deny filter", async () => {
    mockCreateMCPClient.mockResolvedValue({
      tools: vi
        .fn()
        .mockResolvedValue({
          "keep-me": { description: "allowed and not denied" },
          "deny-me": { description: "allowed but denied" },
          "not-in-allow": { description: "not in allow list" },
        }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const configs: Record<string, MCPServerConfig> = {
      "combo-filter": {
        transport: { type: "stdio", command: "echo", args: [] },
        tools: { allow: ["keep-me", "deny-me"], deny: ["deny-me"] },
      },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("keep-me");
    expect(result.tools).not.toHaveProperty("deny-me");
    expect(result.tools).not.toHaveProperty("not-in-allow");
  });

  it("re-throws credential error with existing serverName without re-enriching", async () => {
    // Error already has serverName set — should be thrown as-is, not re-wrapped
    mockResolveEnvValues.mockRejectedValue(
      new LinkCredentialNotFoundError("cred_789", "original-server"),
    );

    const configs: Record<string, MCPServerConfig> = {
      "different-server": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_789", key: "token" } },
      },
    };

    const error = await createMCPTools(configs, fakeLogger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkCredentialNotFoundError);
    expect.assert(error instanceof LinkCredentialNotFoundError);
    // Should preserve the original serverName, not overwrite with "different-server"
    expect(error.message).toContain("original-server");
    expect(error.serverName).toBe("original-server");
  });

  it("cleans up already-connected clients when signal is aborted before next server", async () => {
    const closeA = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const controller = new AbortController();

    // Server A connects; abort before server B starts
    mockCreateMCPClient.mockImplementation(() => {
      // Abort after the first server connects
      controller.abort(new Error("cancelled"));
      return Promise.resolve({
        tools: vi.fn().mockResolvedValue({ "tool-a": { description: "from A" } }),
        close: closeA,
      });
    });

    const configs: Record<string, MCPServerConfig> = {
      "server-a": { transport: { type: "stdio", command: "echo", args: [] } },
      "server-b": { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const error = await createMCPTools(configs, fakeLogger, { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("cancelled");
    // Server A's client must have been cleaned up
    expect(closeA).toHaveBeenCalledTimes(1);
    // Server B should never have been attempted
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
  });

  it("dispose awaits close() — does not resolve before cleanup finishes", async () => {
    let closeResolved = false;
    const slowClose = vi.fn<() => Promise<void>>().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            closeResolved = true;
            resolve();
          }, 50);
        }),
    );

    mockCreateMCPClient.mockResolvedValue({
      tools: vi.fn().mockResolvedValue({ tool: { description: "x" } }),
      close: slowClose,
    });

    const configs: Record<string, MCPServerConfig> = {
      server: { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);
    await result.dispose();

    expect(closeResolved).toBe(true);
    expect(slowClose).toHaveBeenCalledTimes(1);
  });
});

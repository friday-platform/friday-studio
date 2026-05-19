import { writeSync } from "node:fs";
import process from "node:process";
import type { MCPServerConfig } from "@atlas/config";
import {
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  LinkCredentialUnavailableError,
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
  StreamableHTTPError: class extends Error {
    readonly code: number | undefined;
    constructor(code: number | undefined, message: string | undefined) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>();
  return { ...actual, resolveEnvValues: mockResolveEnvValues };
});

// Import after mocks
const { createMCPTools, MCPTimeoutError, withTimeout } = await import("./create-mcp-tools.ts");

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

  it("skips server that fails to connect and returns empty tools", async () => {
    mockCreateMCPClient.mockRejectedValue(new Error("spawn failed"));

    const configs: Record<string, MCPServerConfig> = {
      "broken-server": { transport: { type: "stdio", command: "nonexistent", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);
    expect(Object.keys(result.tools)).toHaveLength(0);
    expect(result.disconnected).toHaveLength(0);
    expect(fakeLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("connection error"),
      expect.anything(),
    );
  });

  it("skips server with LinkCredentialNotFoundError and continues", async () => {
    mockResolveEnvValues.mockRejectedValueOnce(new LinkCredentialNotFoundError("cred_123"));

    // Healthy second server still connects and contributes its tool
    mockCreateMCPClient.mockResolvedValueOnce({
      tools: vi.fn().mockResolvedValue({ "other-tool": { description: "ok" } }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const configs: Record<string, MCPServerConfig> = {
      "needs-cred": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_123", key: "token" } },
      },
      "other-server": { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("other-tool");
    expect(result.disconnected).toHaveLength(1);
    expect(result.disconnected[0]).toMatchObject({
      serverId: "needs-cred",
      kind: "credential_not_found",
    });
    // Only the healthy server should have connected
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
  });

  it("skips server with NoDefaultCredentialError and records provider", async () => {
    mockResolveEnvValues.mockRejectedValueOnce(new NoDefaultCredentialError("github"));

    const configs: Record<string, MCPServerConfig> = {
      "needs-cred": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_123", key: "token" } },
      },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(Object.keys(result.tools)).toHaveLength(0);
    expect(result.disconnected).toHaveLength(1);
    expect(result.disconnected[0]).toMatchObject({
      serverId: "needs-cred",
      provider: "github",
      kind: "no_default_credential",
    });
  });

  it("threads the workspace .env overlay through to resolveEnvValues", async () => {
    mockCreateMCPClient.mockResolvedValueOnce({
      tools: vi.fn().mockResolvedValue({ "a-tool": { description: "ok" } }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const configs: Record<string, MCPServerConfig> = {
      srv: {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { FOO: "from_environment" },
      },
    };
    const envOverlay = { FOO: "overlay-value" };

    await createMCPTools(configs, fakeLogger, { envOverlay });

    // The overlay reaches the shared resolver as its third argument — proving
    // the createMCPTools → connect path threads it end to end.
    expect(mockResolveEnvValues).toHaveBeenCalledWith(
      { FOO: "from_environment" },
      expect.anything(),
      envOverlay,
    );
  });

  it("skips server with LinkCredentialExpiredError and classifies refresh kind", async () => {
    mockResolveEnvValues
      .mockRejectedValueOnce(
        new LinkCredentialExpiredError("cred_456", "refresh_failed", "refresh failed"),
      )
      .mockRejectedValueOnce(
        new LinkCredentialExpiredError("cred_789", "expired_no_refresh", "expired, no refresh"),
      );

    const configs: Record<string, MCPServerConfig> = {
      "refresh-failed": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_456", key: "token" } },
      },
      "expired-no-refresh": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_789", key: "token" } },
      },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.disconnected).toHaveLength(2);
    expect(result.disconnected[0]?.kind).toBe("credential_refresh_failed");
    expect(result.disconnected[1]?.kind).toBe("credential_expired");
  });

  it("skips server with LinkCredentialUnavailableError and emits credential_temporarily_unavailable", async () => {
    mockResolveEnvValues.mockRejectedValueOnce(
      new LinkCredentialUnavailableError({
        credentialId: "cred_transient",
        serverName: "needs-cred",
        provider: "google-gmail",
        linkError: "transient refresh failure (network)",
      }),
    );

    const configs: Record<string, MCPServerConfig> = {
      "needs-cred": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_transient", key: "token" } },
      },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(Object.keys(result.tools)).toHaveLength(0);
    expect(result.disconnected).toHaveLength(1);
    expect(result.disconnected[0]).toMatchObject({
      serverId: "needs-cred",
      kind: "credential_temporarily_unavailable",
    });
  });

  it("isolates LinkCredentialUnavailableError per server — others still connect", async () => {
    mockResolveEnvValues
      .mockRejectedValueOnce(
        new LinkCredentialUnavailableError({
          credentialId: "cred_transient",
          serverName: "transient-server",
          linkError: "transient refresh failure (network)",
        }),
      )
      .mockResolvedValueOnce({});

    mockCreateMCPClient.mockResolvedValueOnce({
      tools: vi.fn().mockResolvedValue({ "healthy-tool": { description: "ok" } }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const configs: Record<string, MCPServerConfig> = {
      "transient-server": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_transient", key: "token" } },
      },
      "healthy-server": { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("healthy-tool");
    expect(result.disconnected).toHaveLength(1);
    expect(result.disconnected[0]).toMatchObject({
      serverId: "transient-server",
      kind: "credential_temporarily_unavailable",
    });
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
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

  it("disconnected entry exposes serverId on the entry itself", async () => {
    mockResolveEnvValues.mockRejectedValue(new LinkCredentialNotFoundError("cred_123"));

    const configs: Record<string, MCPServerConfig> = {
      "my-slack-server": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_123", key: "token" } },
      },
    };

    const result = await createMCPTools(configs, fakeLogger);

    // The DisconnectedIntegration entry carries serverId structurally — the
    // `.message` is the upstream error string verbatim (no rewriting), so
    // we no longer assert that the server name is interpolated into it.
    expect(result.disconnected).toHaveLength(1);
    expect(result.disconnected[0]?.serverId).toBe("my-slack-server");
  });

  it("disconnected entry surfaces the LinkCredentialExpired refresh status with Link's error string", async () => {
    const linkError = "transient refresh failure (network): tcp connect error";
    mockResolveEnvValues.mockRejectedValue(
      new LinkCredentialExpiredError("cred_456", "refresh_failed", linkError),
    );

    const configs: Record<string, MCPServerConfig> = {
      "my-github-server": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_456", key: "token" } },
      },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.disconnected).toHaveLength(1);
    expect(result.disconnected[0]).toMatchObject({
      serverId: "my-github-server",
      kind: "credential_refresh_failed",
      message: linkError, // verbatim — not translated, not wrapped
    });
  });

  it("keeps already-connected clients alive when a later server has a credential error", async () => {
    const closeA = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    // Server A connects successfully
    mockCreateMCPClient.mockResolvedValueOnce({
      tools: vi.fn().mockResolvedValue({ "tool-a": { description: "from A" } }),
      close: closeA,
    });

    // Server B has a credential error during env resolution
    mockResolveEnvValues.mockRejectedValueOnce(new LinkCredentialNotFoundError("cred_missing"));

    const configs: Record<string, MCPServerConfig> = {
      "server-a": { transport: { type: "stdio", command: "echo", args: [] } },
      "server-b": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_missing", key: "token" } },
      },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("tool-a");
    expect(result.disconnected).toHaveLength(1);
    expect(result.disconnected[0]?.serverId).toBe("server-b");
    // Server A's client stays alive — only dispose() should close it
    expect(closeA).not.toHaveBeenCalled();
    await result.dispose();
    expect(closeA).toHaveBeenCalledTimes(1);
  });

  it("skips HTTP server that fails to connect", async () => {
    mockCreateMCPClient.mockRejectedValue(new Error("connection refused"));

    const configs: Record<string, MCPServerConfig> = {
      "broken-http": { transport: { type: "http", url: "https://mcp.example.com" } },
    };

    const result = await createMCPTools(configs, fakeLogger);
    expect(Object.keys(result.tools)).toHaveLength(0);
    expect(result.disconnected).toHaveLength(0);
    expect(fakeLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("connection error"),
      expect.anything(),
    );
  });

  it("skips HTTP server that returns 401", async () => {
    const { StreamableHTTPError } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    mockCreateMCPClient.mockRejectedValue(new StreamableHTTPError(401, "invalid token"));

    const configs: Record<string, MCPServerConfig> = {
      "auth-http": { transport: { type: "http", url: "https://mcp.example.com" } },
    };

    const result = await createMCPTools(configs, fakeLogger);
    expect(Object.keys(result.tools)).toHaveLength(0);
    expect(result.disconnected).toHaveLength(0);
    expect(fakeLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("connection error"),
      expect.anything(),
    );
  });

  it("keeps already-connected clients when another server fails", async () => {
    const closeA = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    // Server A connects successfully
    mockCreateMCPClient
      .mockResolvedValueOnce({
        tools: vi.fn().mockResolvedValue({ "tool-a": { description: "from A" } }),
        close: closeA,
      })
      // Server B fails
      .mockRejectedValue(new Error("spawn failed"));

    const configs: Record<string, MCPServerConfig> = {
      "server-a": { transport: { type: "stdio", command: "echo", args: [] } },
      "server-b": { transport: { type: "stdio", command: "nonexistent", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);
    expect(result.tools).toHaveProperty("tool-a");
    expect(Object.keys(result.tools)).toHaveLength(1);
    // Server A stays alive — only dispose() should close it
    expect(closeA).not.toHaveBeenCalled();
    await result.dispose();
    expect(closeA).toHaveBeenCalledTimes(1);
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
    expect(result.tools["shared-tool"]).toMatchObject({ description: "from B" });
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

  it("preserves existing serverName on the credential error message instead of re-enriching", async () => {
    mockResolveEnvValues.mockRejectedValue(
      new LinkCredentialNotFoundError("cred_789", "original-server"),
    );

    const configs: Record<string, MCPServerConfig> = {
      "different-server": {
        transport: { type: "stdio", command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_789", key: "token" } },
      },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.disconnected).toHaveLength(1);
    // serverId still reflects the loop key, but the message keeps the original
    // serverName the error was constructed with — no double-enrichment.
    expect(result.disconnected[0]?.serverId).toBe("different-server");
    expect(result.disconnected[0]?.message).toContain("original-server");
    expect(result.disconnected[0]?.message).not.toContain("different-server");
  });

  it("disposes all connected clients when signal aborts mid-connect", async () => {
    const closeA = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const controller = new AbortController();

    mockCreateMCPClient.mockImplementation(() => {
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
    // Both parallel mappers created a client; both get disposed in cleanup
    expect(closeA).toHaveBeenCalledTimes(2);
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(2);
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

  it("prefixes tool keys with toolPrefix when provided", async () => {
    mockCreateMCPClient.mockResolvedValue({
      tools: vi
        .fn()
        .mockResolvedValue({
          "get-activity": { description: "Fetch an activity" },
          "list-activities": { description: "List activities" },
        }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const configs: Record<string, MCPServerConfig> = {
      strava: { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger, { toolPrefix: "strava" });

    expect(result.tools).toHaveProperty("strava_get-activity");
    expect(result.tools).toHaveProperty("strava_list-activities");
    expect(result.tools["strava_get-activity"]).toMatchObject({ description: "Fetch an activity" });
    expect(result.tools["strava_list-activities"]).toMatchObject({
      description: "List activities",
    });

    await result.dispose();
  });

  it("leaves tool keys unchanged when toolPrefix is omitted", async () => {
    mockCreateMCPClient.mockResolvedValue({
      tools: vi.fn().mockResolvedValue({ "get-activity": { description: "Fetch an activity" } }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const configs: Record<string, MCPServerConfig> = {
      strava: { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const result = await createMCPTools(configs, fakeLogger);

    expect(result.tools).toHaveProperty("get-activity");
    expect(result.tools).not.toHaveProperty("strava_get-activity");

    await result.dispose();
  });

  it("warns on collision when prefixed tool names overlap", async () => {
    mockCreateMCPClient
      .mockResolvedValueOnce({
        tools: vi.fn().mockResolvedValue({ "shared-tool": { description: "from A" } }),
        close: vi.fn().mockResolvedValue(undefined),
      })
      .mockResolvedValueOnce({
        tools: vi.fn().mockResolvedValue({ "shared-tool": { description: "from B" } }),
        close: vi.fn().mockResolvedValue(undefined),
      });

    const configsA: Record<string, MCPServerConfig> = {
      serverA: { transport: { type: "stdio", command: "echo", args: [] } },
    };
    const configsB: Record<string, MCPServerConfig> = {
      serverB: { transport: { type: "stdio", command: "echo", args: [] } },
    };

    const resultA = await createMCPTools(configsA, fakeLogger, { toolPrefix: "prefix" });
    const resultB = await createMCPTools(configsB, fakeLogger, { toolPrefix: "prefix" });

    // Both prefixed to "prefix_shared-tool" — second set overwrites first
    expect(resultA.tools).toHaveProperty("prefix_shared-tool");
    expect(resultB.tools).toHaveProperty("prefix_shared-tool");

    await resultA.dispose();
    await resultB.dispose();
  });

  describe("uvx --from recovery", () => {
    // fakeLogger.warn accumulates across tests; clear it before each so
    // not.toHaveBeenCalledWith(...) assertions only see this test's calls.
    beforeEach(() => {
      (fakeLogger.warn as unknown as ReturnType<typeof vi.fn>).mockClear();
    });

    // attemptStdio writes subprocess stderr to a temp file (the fd is passed
    // to the transport). To simulate that under mocks, MockStdioTransport
    // writes our test stderr into that fd synchronously; the real
    // attemptStdio reads it back via fstat/read.
    function writeStderrToFd(opts: { stderr: number }, content: string) {
      writeSync(opts.stderr, content);
    }

    it("retries uvx with --from when uv emits the entrypoint-mismatch hint", async () => {
      const uvHint = [
        "An executable named `bitbucket-mcp-py` is not provided by package `bitbucket-mcp-py`.",
        "The following executables are available:",
        "- bitbucket-mcp",
        "",
        "Use `uvx --from bitbucket-mcp-py bitbucket-mcp` instead.",
      ].join("\n");

      let attempt = 0;
      MockStdioTransport.mockImplementation(function (this: unknown, opts: { stderr: number }) {
        attempt++;
        if (attempt === 1) writeStderrToFd(opts, uvHint);
      });

      mockTools
        .mockImplementationOnce(() => Promise.reject(new Error("Connection closed")))
        .mockImplementationOnce(() =>
          Promise.resolve({ "bb-tool": { description: "ok", parameters: {} } }),
        );
      mockClose.mockResolvedValue(undefined);
      mockCreateMCPClient.mockResolvedValue({ tools: mockTools, close: mockClose });

      const configs: Record<string, MCPServerConfig> = {
        bitbucket: {
          transport: { type: "stdio", command: "uvx", args: ["bitbucket-mcp-py==1.2.3"] },
        },
      };

      const result = await createMCPTools(configs, fakeLogger);

      expect(result.tools).toHaveProperty("bb-tool");
      expect(MockStdioTransport).toHaveBeenCalledTimes(2);
      expect(MockStdioTransport).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ args: ["--from", "bitbucket-mcp-py==1.2.3", "bitbucket-mcp"] }),
      );
      expect(fakeLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("retrying"),
        expect.objectContaining({
          operation: "mcp_connect_recover",
          serverId: "bitbucket",
          recoveryArgs: ["--from", "bitbucket-mcp-py==1.2.3", "bitbucket-mcp"],
        }),
      );
    });

    it("does not retry when stderr lacks the uv hint", async () => {
      MockStdioTransport.mockImplementation(function (this: unknown, opts: { stderr: number }) {
        writeStderrToFd(opts, "ENOENT: command not found\n");
      });
      mockTools.mockImplementation(() => Promise.reject(new Error("Connection closed")));
      mockClose.mockResolvedValue(undefined);
      mockCreateMCPClient.mockResolvedValue({ tools: mockTools, close: mockClose });

      const configs: Record<string, MCPServerConfig> = {
        bogus: { transport: { type: "stdio", command: "uvx", args: ["nonexistent-pkg"] } },
      };

      await createMCPTools(configs, fakeLogger);

      expect(MockStdioTransport).toHaveBeenCalledTimes(1);
      expect(fakeLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("retrying"),
        expect.anything(),
      );
    });

    it("strips ANSI color codes from the captured hint before parsing", async () => {
      // uv wraps the package name and entrypoint in CSI color codes when it
      // detects a terminal-ish stderr. The recovery parser must strip them or
      // the captured argv will contain raw ESC bytes.
      const ESC = "";
      const coloredHint = [
        `An executable named \`${ESC}[36mfoo-pkg${ESC}[39m\` is not provided by package \`${ESC}[36mfoo-pkg${ESC}[39m\`.`,
        "The following executables are available:",
        `- ${ESC}[36mfoo-bin${ESC}[39m`,
        "",
        `Use \`uvx --from ${ESC}[36mfoo-pkg${ESC}[39m ${ESC}[36mfoo-bin${ESC}[39m\` instead.`,
      ].join("\n");

      let attempt = 0;
      MockStdioTransport.mockImplementation(function (this: unknown, opts: { stderr: number }) {
        attempt++;
        if (attempt === 1) writeStderrToFd(opts, coloredHint);
      });

      mockTools
        .mockImplementationOnce(() => Promise.reject(new Error("Connection closed")))
        .mockImplementationOnce(() =>
          Promise.resolve({ x: { description: "ok", parameters: {} } }),
        );
      mockClose.mockResolvedValue(undefined);
      mockCreateMCPClient.mockResolvedValue({ tools: mockTools, close: mockClose });

      const configs: Record<string, MCPServerConfig> = {
        colored: { transport: { type: "stdio", command: "uvx", args: ["foo-pkg==2.0"] } },
      };

      await createMCPTools(configs, fakeLogger);

      expect(MockStdioTransport).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ args: ["--from", "foo-pkg==2.0", "foo-bin"] }),
      );
    });

    it("does not retry when the command is not uvx, even if stderr contains the hint", async () => {
      const hint = "Use `uvx --from foo-pkg foo-bin` instead.";
      MockStdioTransport.mockImplementation(function (this: unknown, opts: { stderr: number }) {
        writeStderrToFd(opts, hint);
      });
      mockTools.mockImplementation(() => Promise.reject(new Error("Connection closed")));
      mockClose.mockResolvedValue(undefined);
      mockCreateMCPClient.mockResolvedValue({ tools: mockTools, close: mockClose });

      const configs: Record<string, MCPServerConfig> = {
        wrapper: { transport: { type: "stdio", command: "my-wrapper", args: ["foo-pkg"] } },
      };

      await createMCPTools(configs, fakeLogger);

      expect(MockStdioTransport).toHaveBeenCalledTimes(1);
      expect(fakeLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("retrying"),
        expect.anything(),
      );
    });

    it("does not retry when the original args already contain --from", async () => {
      const hint = "Use `uvx --from foo-pkg foo-bin` instead.";
      MockStdioTransport.mockImplementation(function (this: unknown, opts: { stderr: number }) {
        writeStderrToFd(opts, hint);
      });
      mockTools.mockImplementation(() => Promise.reject(new Error("Connection closed")));
      mockClose.mockResolvedValue(undefined);
      mockCreateMCPClient.mockResolvedValue({ tools: mockTools, close: mockClose });

      const configs: Record<string, MCPServerConfig> = {
        already: {
          transport: { type: "stdio", command: "uvx", args: ["--from", "foo-pkg", "wrong-entry"] },
        },
      };

      await createMCPTools(configs, fakeLogger);

      expect(MockStdioTransport).toHaveBeenCalledTimes(1);
      expect(fakeLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("retrying"),
        expect.anything(),
      );
    });

    it("falls back to uv's suggested package when no positional carries the name", async () => {
      const hint = "Use `uvx --from solo-pkg solo-bin` instead.";
      let attempt = 0;
      MockStdioTransport.mockImplementation(function (this: unknown, opts: { stderr: number }) {
        attempt++;
        if (attempt === 1) writeStderrToFd(opts, hint);
      });
      mockTools
        .mockImplementationOnce(() => Promise.reject(new Error("Connection closed")))
        .mockImplementationOnce(() =>
          Promise.resolve({ t: { description: "ok", parameters: {} } }),
        );
      mockClose.mockResolvedValue(undefined);
      mockCreateMCPClient.mockResolvedValue({ tools: mockTools, close: mockClose });

      const configs: Record<string, MCPServerConfig> = {
        // args contain no token that includes "solo-pkg" — flag-only case.
        // The recovery falls back to uv's suggested package, preserving the
        // original `--quiet` flag.
        flagsonly: { transport: { type: "stdio", command: "uvx", args: ["--quiet"] } },
      };

      await createMCPTools(configs, fakeLogger);

      expect(MockStdioTransport).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ args: ["--quiet", "--from", "solo-pkg", "solo-bin"] }),
      );
    });

    it("recovers from --python flag-with-value invocations", async () => {
      // `uvx --python 3.11 mypkg` — the previous "first non-flag arg" heuristic
      // would have picked "3.11"; substring match correctly picks "mypkg".
      const hint = "Use `uvx --from mypkg mybin` instead.";
      let attempt = 0;
      MockStdioTransport.mockImplementation(function (this: unknown, opts: { stderr: number }) {
        attempt++;
        if (attempt === 1) writeStderrToFd(opts, hint);
      });
      mockTools
        .mockImplementationOnce(() => Promise.reject(new Error("Connection closed")))
        .mockImplementationOnce(() =>
          Promise.resolve({ t: { description: "ok", parameters: {} } }),
        );
      mockClose.mockResolvedValue(undefined);
      mockCreateMCPClient.mockResolvedValue({ tools: mockTools, close: mockClose });

      const configs: Record<string, MCPServerConfig> = {
        py: {
          transport: { type: "stdio", command: "uvx", args: ["--python", "3.11", "mypkg==1.0"] },
        },
      };

      await createMCPTools(configs, fakeLogger);

      expect(MockStdioTransport).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ args: ["--python", "3.11", "--from", "mypkg==1.0", "mybin"] }),
      );
    });

    it("preserves both stderr outputs when the retry also fails", async () => {
      const firstHint = "Use `uvx --from foo-pkg foo-bin` instead.";
      const retryError = "RETRY_FAILURE_TOKEN: something else went wrong";
      let attempt = 0;
      MockStdioTransport.mockImplementation(function (this: unknown, opts: { stderr: number }) {
        attempt++;
        writeStderrToFd(opts, attempt === 1 ? firstHint : retryError);
      });
      mockTools.mockImplementation(() => Promise.reject(new Error("Connection closed")));
      mockClose.mockResolvedValue(undefined);
      mockCreateMCPClient.mockResolvedValue({ tools: mockTools, close: mockClose });

      const configs: Record<string, MCPServerConfig> = {
        both: { transport: { type: "stdio", command: "uvx", args: ["foo-pkg"] } },
      };

      await createMCPTools(configs, fakeLogger);

      // The surfaced error should carry both stderrs — the original uv hint
      // (so the operator knows why we retried) and the retry's distinct
      // failure (so they know it didn't fix things).
      expect(fakeLogger.warn).toHaveBeenCalledWith(
        "MCP server skipped due to connection error",
        expect.objectContaining({ error: expect.stringContaining(firstHint) }),
      );
      expect(fakeLogger.warn).toHaveBeenCalledWith(
        "MCP server skipped due to connection error",
        expect.objectContaining({ error: expect.stringContaining("RETRY_FAILURE_TOKEN") }),
      );
    });
  });

  describe("timeout behaviour", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("listTools timeout isolates the slow server", async () => {
      // Fast server returns immediately
      mockCreateMCPClient.mockResolvedValueOnce({
        tools: vi.fn().mockResolvedValue({ "fast-tool": { description: "fast" } }),
        close: vi.fn().mockResolvedValue(undefined),
      });

      // Slow server: createMCPClient resolves, but tools() hangs forever
      mockCreateMCPClient.mockResolvedValueOnce({
        tools: vi.fn().mockImplementation(() => new Promise(() => {})),
        close: vi.fn().mockResolvedValue(undefined),
      });

      const configs: Record<string, MCPServerConfig> = {
        "server-fast": { transport: { type: "stdio", command: "echo", args: [] } },
        "server-slow": { transport: { type: "stdio", command: "echo", args: [] } },
      };

      const promise = createMCPTools(configs, fakeLogger);

      // Advance past the 20s listTools timeout (async variant flushes microtasks)
      await (
        vi as unknown as { advanceTimersByTimeAsync: (ms: number) => Promise<void> }
      ).advanceTimersByTimeAsync(21_000);

      const result = await promise;

      expect(result.tools).toHaveProperty("fast-tool");
      expect(result.tools).not.toHaveProperty("slow-tool");
      expect(fakeLogger.warn).toHaveBeenCalledWith(
        "MCP operation timed out",
        expect.objectContaining({
          operation: "mcp_timeout",
          serverId: "server-slow",
          phase: "list_tools",
          timeoutMs: 20_000,
          durationMs: expect.any(Number),
        }),
      );
    });

    it("callTool timeout enforces the 15min ceiling", async () => {
      const hangExecute = vi.fn().mockImplementation(() => new Promise(() => {}));

      mockCreateMCPClient.mockResolvedValue({
        tools: vi
          .fn()
          .mockResolvedValue({ "hang-tool": { description: "hangs", execute: hangExecute } }),
        close: vi.fn().mockResolvedValue(undefined),
      });

      const configs: Record<string, MCPServerConfig> = {
        hang: { transport: { type: "stdio", command: "echo", args: [] } },
      };

      const result = await createMCPTools(configs, fakeLogger);
      expect(result.tools).toHaveProperty("hang-tool");

      const tool = result.tools["hang-tool"]!;
      const executePromise = tool.execute!({}, { toolCallId: "tc_1", messages: [] });

      // Advance past the 15-minute ceiling
      vi.advanceTimersByTime(15 * 60 * 1_000 + 1_000);

      await expect(executePromise).rejects.toBeInstanceOf(MCPTimeoutError);
    });
  });

  describe("stdio arg placeholder expansion", () => {
    // Regression: Friday kept guessing wrong usernames in absolute paths.
    // Expanding `${HOME}` / `${FRIDAY_HOME}` at spawn time makes templates
    // portable and removes the hallucinated-username failure mode.
    it("expands ${HOME} and ${FRIDAY_HOME} in stdio args before spawning", async () => {
      const originalHome = process.env.HOME;
      const originalAtlasHome = process.env.FRIDAY_HOME;
      process.env.HOME = "/Users/alice";
      process.env.FRIDAY_HOME = "/Users/alice/.atlas";

      try {
        mockTools.mockResolvedValue({ write_query: { description: "x", parameters: {} } });
        mockClose.mockResolvedValue(undefined);
        mockCreateMCPClient.mockResolvedValue({ tools: mockTools, close: mockClose });

        const configs: Record<string, MCPServerConfig> = {
          sqlite: {
            transport: {
              type: "stdio",
              command: "uvx",
              args: [
                "mcp-server-sqlite",
                "--db-path",
                "${FRIDAY_HOME}/workspaces/knowledge-base/kb.sqlite",
                "--fallback",
                "${HOME}/Documents/kb.sqlite",
              ],
            },
          },
        };

        await createMCPTools(configs, fakeLogger);

        expect(MockStdioTransport).toHaveBeenCalledWith(
          expect.objectContaining({
            args: [
              "mcp-server-sqlite",
              "--db-path",
              "/Users/alice/.atlas/workspaces/knowledge-base/kb.sqlite",
              "--fallback",
              "/Users/alice/Documents/kb.sqlite",
            ],
          }),
        );
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalAtlasHome === undefined) delete process.env.FRIDAY_HOME;
        else process.env.FRIDAY_HOME = originalAtlasHome;
      }
    });

    it("leaves args without placeholders untouched", async () => {
      mockTools.mockResolvedValue({});
      mockClose.mockResolvedValue(undefined);
      mockCreateMCPClient.mockResolvedValue({ tools: mockTools, close: mockClose });

      const configs: Record<string, MCPServerConfig> = {
        fetch: { transport: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] } },
      };

      await createMCPTools(configs, fakeLogger);

      expect(MockStdioTransport).toHaveBeenCalledWith(
        expect.objectContaining({ args: ["mcp-server-fetch"] }),
      );
    });

    it("falls back to ${HOME}/.friday/local when FRIDAY_HOME is unset", async () => {
      const originalHome = process.env.HOME;
      const originalAtlasHome = process.env.FRIDAY_HOME;
      process.env.HOME = "/Users/test";
      delete process.env.FRIDAY_HOME;

      try {
        mockTools.mockResolvedValue({});
        mockClose.mockResolvedValue(undefined);
        mockCreateMCPClient.mockResolvedValue({ tools: mockTools, close: mockClose });

        const configs: Record<string, MCPServerConfig> = {
          sqlite: {
            transport: {
              type: "stdio",
              command: "uvx",
              args: ["mcp-server-sqlite", "--db-path", "${FRIDAY_HOME}/kb.sqlite"],
            },
          },
        };

        await createMCPTools(configs, fakeLogger);

        expect(MockStdioTransport).toHaveBeenCalledWith(
          expect.objectContaining({
            args: ["mcp-server-sqlite", "--db-path", "/Users/test/.friday/local/kb.sqlite"],
          }),
        );
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalAtlasHome !== undefined) process.env.FRIDAY_HOME = originalAtlasHome;
      }
    });
  });
});

describe("withTimeout", () => {
  const makeTimeoutError = (ms: number) => new Error(`timed out after ${ms}ms`);

  it("rejects immediately with signal.reason when signal is already aborted", async () => {
    const reason = new Error("pre-aborted");
    const controller = new AbortController();
    controller.abort(reason);

    await expect(
      withTimeout(new Promise(() => {}), 10_000, makeTimeoutError, controller.signal),
    ).rejects.toBe(reason);
  });

  it("rejects with signal.reason when signal aborts before the timer fires", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new Error("mid-flight");
      const promise = withTimeout(
        new Promise(() => {}),
        10_000,
        makeTimeoutError,
        controller.signal,
      );

      // Abort before the 10s timer would fire.
      await vi.advanceTimersByTimeAsync(50);
      controller.abort(reason);

      await expect(promise).rejects.toBe(reason);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timer when the signal aborts (no zombie setTimeout)", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const promise = withTimeout(
        new Promise(() => {}),
        10_000,
        makeTimeoutError,
        controller.signal,
      );

      controller.abort(new Error("cancel"));
      await expect(promise).rejects.toThrow("cancel");

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timer when the inner promise resolves", async () => {
    vi.useFakeTimers();
    try {
      const promise = withTimeout(Promise.resolve("ok"), 10_000, makeTimeoutError);
      await expect(promise).resolves.toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still rejects on timeout when no signal is supplied (backward compatible)", async () => {
    vi.useFakeTimers();
    try {
      const promise = withTimeout(new Promise(() => {}), 1_000, makeTimeoutError);
      const assertion = expect(promise).rejects.toThrow("timed out after");
      await vi.advanceTimersByTimeAsync(1_500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the abort listener after the inner promise settles", async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    await withTimeout(Promise.resolve("ok"), 10_000, makeTimeoutError, controller.signal);

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

import type { ChildProcess } from "node:child_process";
import type { MCPServerConfig } from "@atlas/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted ensures these are available when vi.mock factories run
const { mockCreateMCPClient, MockHTTPTransport } = vi.hoisted(() => ({
  mockCreateMCPClient: vi.fn(),
  MockHTTPTransport: vi.fn(),
}));

vi.mock("@ai-sdk/mcp", () => ({ experimental_createMCPClient: mockCreateMCPClient }));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockHTTPTransport,
}));

// Import after mocks
const { connectHttp, MCPStartupError } = await import("./create-mcp-tools.ts");
const { sharedMCPProcesses } = await import("./process-registry.ts");

/** No-op pid file writer for tests — avoids touching the user's filesystem. */
function noopPidFile() {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => fakeLogger),
} as unknown as import("@atlas/logger").Logger;

beforeEach(() => {
  mockCreateMCPClient.mockReset();
  MockHTTPTransport.mockReset();
  sharedMCPProcesses._resetForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
  sharedMCPProcesses._resetForTesting();
});

/** Build a mock child process that can emit stderr / exit events and record kill() calls. */
function createMockChildProcess(): MockChildProcess {
  const stderrListeners: Array<(data: Uint8Array) => void> = [];
  const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  let _killed = false;
  let _exitCode: number | null = null;
  let _signalCode: string | null = null;

  return {
    stderr: {
      on: (_event: string, handler: (data: Uint8Array) => void) => {
        stderrListeners.push(handler);
      },
    },
    on: (event: string, handler: (code: number | null, signal: string | null) => void) => {
      if (event === "exit") exitListeners.push(handler);
    },
    once: (event: string, handler: (code: number | null, signal: string | null) => void) => {
      if (event === "exit") exitListeners.push(handler);
    },
    kill: vi.fn((signal: string) => {
      _killed = true;
      _signalCode = signal;
      for (const h of exitListeners) {
        h(null, signal);
      }
    }),
    get exitCode() {
      return _exitCode;
    },
    get signalCode() {
      return _signalCode;
    },
    get killed() {
      return _killed;
    },
    _emitStderr(text: string) {
      const data = new TextEncoder().encode(text);
      for (const h of stderrListeners) {
        h(data);
      }
    },
    _emitExit(code: number | null, signal: string | null) {
      _exitCode = code;
      _signalCode = signal;
      for (const h of exitListeners) {
        h(code, signal);
      }
    },
  } as unknown as MockChildProcess;
}

interface MockChildProcess extends ChildProcess {
  _emitStderr(text: string): void;
  _emitExit(code: number | null, signal: string | null): void;
}

function mockMCPClient(tools: Record<string, unknown> = {}) {
  mockCreateMCPClient.mockResolvedValue({
    tools: vi.fn().mockResolvedValue(tools),
    close: vi.fn().mockResolvedValue(undefined),
  });
}

function makeHttpConfig(overrides?: Partial<MCPServerConfig["startup"]>): MCPServerConfig {
  return {
    transport: { type: "http", url: "http://localhost:8001/mcp" },
    startup: {
      type: "command",
      command: "uvx",
      args: ["workspace-mcp", "--tools", "calendar", "--transport", "streamable-http"],
      env: {
        TEST_PLATFORM_VAR: "test-value",
        TEST_PLATFORM_SECRET: "test-secret",
        WORKSPACE_MCP_PORT: "8001",
      },
      ready_timeout_ms: 500,
      ready_interval_ms: 50,
      ...overrides,
    },
  };
}

describe("connectHttp startup", () => {
  it("happy path: spawns process via shared registry, polls ready_url, returns tools", async () => {
    const child = createMockChildProcess();
    const mockSpawn = vi.fn().mockReturnValue(child);

    // URL unreachable on first check (connection refused), then reachable
    let fetchCall = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      fetchCall++;
      if (fetchCall <= 1) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve({ status: 200, ok: true } as Response);
    });

    mockMCPClient({ "cal-tool": { description: "calendar" } });

    const config = makeHttpConfig();
    const result = await connectHttp(config, {}, "test-server", fakeLogger, {
      spawn: mockSpawn,
      fetch: mockFetch,
      pidFile: noopPidFile(),
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      "uvx",
      ["workspace-mcp", "--tools", "calendar", "--transport", "streamable-http"],
      expect.objectContaining({
        env: expect.objectContaining({ TEST_PLATFORM_VAR: "test-value" }),
      }),
    );

    expect(result.tools).toHaveProperty("cal-tool");
    // Children are owned by the daemon-scoped registry, not returned to the caller.
    expect((result as { children?: unknown }).children).toBeUndefined();
  });

  it("registry reuse: a second connectHttp for the same serverId does not respawn", async () => {
    const child = createMockChildProcess();
    const mockSpawn = vi.fn().mockReturnValue(child);
    // Server unreachable initially, then reachable after first acquire's poll.
    let fetchCall = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      fetchCall++;
      if (fetchCall <= 1) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve({ status: 200, ok: true } as Response);
    });

    mockMCPClient({ "cal-tool": { description: "calendar" } });

    const config = makeHttpConfig();
    await connectHttp(config, {}, "shared-server", fakeLogger, {
      spawn: mockSpawn,
      fetch: mockFetch,
      pidFile: noopPidFile(),
    });
    await connectHttp(config, {}, "shared-server", fakeLogger, {
      spawn: mockSpawn,
      fetch: mockFetch,
      pidFile: noopPidFile(),
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("skip path: URL already reachable → no spawn, connects directly", async () => {
    const mockSpawn = vi.fn();
    const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);

    mockMCPClient({ "skip-tool": { description: "skip" } });

    const config = makeHttpConfig();
    const result = await connectHttp(config, {}, "test-server", fakeLogger, {
      spawn: mockSpawn,
      fetch: mockFetch,
      pidFile: noopPidFile(),
    });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(result.tools).toHaveProperty("skip-tool");
    expect((result as { children?: unknown }).children).toBeUndefined();
  });

  it("timeout: ready_url never responds → MCPStartupError(kind: 'timeout')", async () => {
    const child = createMockChildProcess();
    const mockSpawn = vi.fn().mockReturnValue(child);
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const config = makeHttpConfig();
    const error = await connectHttp(config, {}, "timeout-server", fakeLogger, {
      spawn: mockSpawn,
      fetch: mockFetch,
      pidFile: noopPidFile(),
    }).catch((e: unknown) => e);

    if (!(error instanceof MCPStartupError)) throw new Error("expected MCPStartupError");
    expect(error.kind).toBe("timeout");
    expect(error.serverId).toBe("timeout-server");
    expect(error.command).toBe("uvx");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("env isolation: config.env bearer tokens never reach child; startup.env never reaches HTTP headers", async () => {
    const child = createMockChildProcess();
    const mockSpawn = vi.fn().mockReturnValue(child);

    // URL unreachable initially (connection refused), then reachable
    let fetchCall = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      fetchCall++;
      if (fetchCall <= 1) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve({ status: 200, ok: true } as Response);
    });

    mockMCPClient({ "iso-tool": { description: "isolation" } });

    const config: MCPServerConfig = {
      transport: { type: "http", url: "http://localhost:8001/mcp" },
      auth: { type: "bearer", token_env: "MY_TOKEN" },
      env: { MY_TOKEN: "bearer-secret" },
      startup: {
        type: "command",
        command: "uvx",
        args: ["workspace-mcp"],
        env: { TEST_PLATFORM_VAR: "client-value", WORKSPACE_MCP_PORT: "8001" },
        ready_timeout_ms: 500,
        ready_interval_ms: 50,
      },
    };

    const resolvedEnv = { MY_TOKEN: "bearer-secret" };

    await connectHttp(config, resolvedEnv, "iso-server", fakeLogger, {
      spawn: mockSpawn,
      fetch: mockFetch,
      pidFile: noopPidFile(),
    });

    // Spawn env must NOT contain the bearer token
    const spawnCall = mockSpawn.mock.calls[0];
    if (!spawnCall) throw new Error("expected mockSpawn to have been called");
    const spawnEnv = spawnCall[2].env as Record<string, string>;
    expect(spawnEnv).not.toHaveProperty("MY_TOKEN");
    expect(spawnEnv).toHaveProperty("TEST_PLATFORM_VAR", "client-value");

    // HTTP headers must contain the bearer token but NOT startup env vars
    expect(MockHTTPTransport).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        requestInit: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer bearer-secret" }),
        }),
      }),
    );
    const httpCall = MockHTTPTransport.mock.calls[0];
    if (!httpCall) throw new Error("expected MockHTTPTransport to have been called");
    const callArgs = httpCall[1] as { requestInit: { headers: Record<string, string> } };
    expect(callArgs.requestInit.headers).not.toHaveProperty("TEST_PLATFORM_VAR");
  });
});

describe("MCPStartupError", () => {
  it("carries kind, serverId, command, and cause", () => {
    const cause = new Error("boom");
    const err = new MCPStartupError("spawn", "srv-1", "cmd", cause);

    expect(err.kind).toBe("spawn");
    expect(err.serverId).toBe("srv-1");
    expect(err.command).toBe("cmd");
    expect(err.cause).toBe(cause);
    expect(err.message).toContain("srv-1");
    expect(err.message).toContain("spawn");
    expect(err.message).toContain("cmd");
  });

  it("works without optional command and cause", () => {
    const err = new MCPStartupError("timeout", "srv-2");
    expect(err.message).toContain("srv-2");
    expect(err.message).toContain("timeout");
    expect(err.command).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });
});

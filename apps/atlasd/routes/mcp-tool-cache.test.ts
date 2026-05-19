import type { MCPServerConfig } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockTool = {
  description?: string;
  inputSchema?: { jsonSchema?: Record<string, unknown> };
};
type MockDisconnected = { serverId: string; kind: string; message: string };

const mockCreateMCPTools =
  vi.fn<
    (
      configs: Record<string, unknown>,
      logger: unknown,
      options?: { signal?: AbortSignal; toolPrefix?: string },
    ) => Promise<{
      tools: Record<string, MockTool>;
      dispose: () => Promise<void>;
      disconnected: MockDisconnected[];
    }>
  >();

vi.mock("@atlas/mcp", () => ({
  createMCPTools: (...args: Parameters<typeof mockCreateMCPTools>) => mockCreateMCPTools(...args),
}));

const { probeAndExtract } = await import("./mcp-tool-cache.ts");

const config: MCPServerConfig = {
  transport: { type: "stdio", command: "echo", args: ["hello"] },
};
const logger = createLogger({ test: "mcp-tool-cache" });

beforeEach(() => {
  mockCreateMCPTools.mockReset();
});

describe("probeAndExtract — signal threading (PR 1 of #344)", () => {
  it("rejects immediately when a pre-aborted signal is passed", async () => {
    // createMCPTools' existing pre-check throws synchronously on an aborted
    // signal before any subprocess work — the composed signal is aborted at
    // construction time when the parent signal is already aborted.
    mockCreateMCPTools.mockImplementation((_configs, _logger, options) => {
      if (options?.signal?.aborted) {
        return Promise.reject(options.signal.reason ?? new Error("Aborted"));
      }
      return Promise.resolve({
        tools: {},
        dispose: vi.fn().mockResolvedValue(undefined),
        disconnected: [],
      });
    });

    const ctl = new AbortController();
    ctl.abort(new Error("client gone"));
    const start = performance.now();
    await expect(probeAndExtract("srv-1", config, logger, 5000, ctl.signal)).rejects.toThrow(
      "client gone",
    );
    expect(performance.now() - start).toBeLessThan(50);
  });

  it("rejects within ~50ms when signal aborts mid-call", async () => {
    // Mock createMCPTools to hang until its own signal aborts, then reject
    // with that signal's reason. This mirrors createMCPTools' real behavior
    // on abort (post-settle check disposes + throws signal.reason).
    mockCreateMCPTools.mockImplementation(
      (_configs, _logger, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(options.signal!.reason ?? new Error("Aborted"));
          });
        }),
    );

    const ctl = new AbortController();
    const promise = probeAndExtract("srv-2", config, logger, 60_000, ctl.signal);
    // Abort after a brief delay so the call is genuinely in-flight.
    setTimeout(() => ctl.abort(new Error("client disconnected")), 20);
    const start = performance.now();
    await expect(promise).rejects.toThrow("client disconnected");
    expect(performance.now() - start).toBeLessThan(150);
  });

  it("internal timeout still fires when no parent signal is passed", async () => {
    // Regression guard on AbortSignal.any composition: when only the timeout
    // path is active, the composed signal must still abort at timeoutMs.
    mockCreateMCPTools.mockImplementation(
      (_configs, _logger, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(options.signal!.reason ?? new Error("Aborted"));
          });
        }),
    );

    const start = performance.now();
    await expect(probeAndExtract("srv-3", config, logger, 30)).rejects.toThrow();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(200);
  });

  it("returns tools normally when neither signal aborts", async () => {
    mockCreateMCPTools.mockResolvedValue({
      tools: { "tool-a": { description: "first tool" } },
      dispose: vi.fn().mockResolvedValue(undefined),
      disconnected: [],
    });

    const ctl = new AbortController();
    const tools = await probeAndExtract("srv-4", config, logger, 5000, ctl.signal);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("tool-a");
    expect(tools[0]?.description).toBe("first tool");
  });
});

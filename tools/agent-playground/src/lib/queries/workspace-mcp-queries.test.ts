import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MutationConfig {
  mutationFn: (vars: unknown) => Promise<unknown>;
  onSuccess?: () => void;
}

// Mock svelte-query so .svelte imports from node_modules don't break node tests
vi.mock("@tanstack/svelte-query", () => ({
  createMutation: (fn: () => MutationConfig) => {
    const config = fn();
    return {
      mutateAsync: async (vars: unknown) => {
        if (config.mutationFn) {
          return await config.mutationFn(vars);
        }
        throw new Error("No mutationFn");
      },
      mutate: (vars: unknown, opts?: { onSettled?: () => void }) => {
        config
          .mutationFn(vars)
          .then(() => {
            if (config.onSuccess) config.onSuccess();
            opts?.onSettled?.();
          })
          .catch(() => {
            opts?.onSettled?.();
          });
      },
      isPending: false,
      error: null,
    };
  },
  queryOptions: <T extends object>(opts: T): T => opts,
  skipToken: Symbol.for("skipToken"),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

// Mock @atlas/utils/sse for test-chat stream tests
vi.mock("@atlas/utils/sse", () => ({
  parseSSEStream: vi.fn(),
}));

// Mock daemon client so we can assert requests without real network calls
const mockWorkspaceMcp = vi.fn();
vi.mock("../daemon-client.ts", () => ({
  getDaemonClient: () => ({
    workspaceMcp: mockWorkspaceMcp,
  }),
}));

const { workspaceMcpQueries, useEnableMCPServer, useDisableMCPServer, testChatEventStream } =
  await import("./workspace-mcp-queries.ts");

describe("workspaceMcpQueries", () => {
  describe("all", () => {
    it("returns the base query key with workspaceId", () => {
      expect(workspaceMcpQueries.all("ws-1")).toEqual([
        "daemon",
        "workspace",
        "ws-1",
        "mcp",
      ]);
    });
  });

  describe("status", () => {
    it("produces a query key with workspace id", () => {
      const options = workspaceMcpQueries.status("ws-1");
      expect(options.queryKey).toEqual(["daemon", "workspace", "ws-1", "mcp", "status"]);
    });

    it("sets staleTime to 30 seconds", () => {
      const options = workspaceMcpQueries.status("ws-1");
      expect(options.staleTime).toBe(30_000);
    });

    it("uses skipToken when workspaceId is null", () => {
      const options = workspaceMcpQueries.status(null);
      expect(options.queryFn).toBe(Symbol.for("skipToken"));
    });
  });
});

describe("useEnableMCPServer", () => {
  beforeEach(() => {
    mockWorkspaceMcp.mockClear();
  });

  it("sends PUT to correct path and parses response", async () => {
    mockWorkspaceMcp.mockReturnValue({
      ":serverId": {
        $put: vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({ server: { id: "github", name: "GitHub" } }),
        }),
      },
    });

    const mutation = useEnableMCPServer();
    const result = await mutation.mutateAsync({ workspaceId: "ws-1", serverId: "github" });

    expect(mockWorkspaceMcp).toHaveBeenCalledWith("ws-1");
    expect(result.server).toEqual({ id: "github", name: "GitHub" });
  });

  it("throws with error message on failure", async () => {
    mockWorkspaceMcp.mockReturnValue({
      ":serverId": {
        $put: vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          json: vi.fn().mockResolvedValue({ error: "not_found", message: "Server not found" }),
        }),
      },
    });

    const mutation = useEnableMCPServer();
    await expect(
      mutation.mutateAsync({ workspaceId: "ws-1", serverId: "unknown" }),
    ).rejects.toThrow("Server not found");
  });
});

describe("useDisableMCPServer", () => {
  beforeEach(() => {
    mockWorkspaceMcp.mockClear();
  });

  it("sends DELETE to correct path without force", async () => {
    const $delete = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ removed: "github" }),
    });
    mockWorkspaceMcp.mockReturnValue({
      ":serverId": { $delete },
    });

    const mutation = useDisableMCPServer();
    const result = await mutation.mutateAsync({ workspaceId: "ws-1", serverId: "github" });

    expect(mockWorkspaceMcp).toHaveBeenCalledWith("ws-1");
    expect($delete).toHaveBeenCalledWith({
      param: { serverId: "github" },
      query: undefined,
    });
    expect(result.removed).toBe("github");
  });

  it("sends DELETE with force query param", async () => {
    const $delete = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ removed: "github" }),
    });
    mockWorkspaceMcp.mockReturnValue({
      ":serverId": { $delete },
    });

    const mutation = useDisableMCPServer();
    await mutation.mutateAsync({ workspaceId: "ws-1", serverId: "github", force: true });

    expect($delete).toHaveBeenCalledWith({
      param: { serverId: "github" },
      query: { force: "true" },
    });
  });

  it("throws with error message on 409 conflict", async () => {
    mockWorkspaceMcp.mockReturnValue({
      ":serverId": {
        $delete: vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          json: vi.fn().mockResolvedValue({
            error: "conflict",
            message: "Server is referenced by 1 entity. Use ?force=true to cascade delete.",
          }),
        }),
      },
    });

    const mutation = useDisableMCPServer();
    await expect(
      mutation.mutateAsync({ workspaceId: "ws-1", serverId: "github" }),
    ).rejects.toThrow("Server is referenced by 1 entity. Use ?force=true to cascade delete.");
  });
});

describe("testChatEventStream", () => {
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchSpy = vi.fn<typeof fetch>();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("throws on non-OK response", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: "Server not found" }), { status: 404 }),
    );

    const stream = testChatEventStream("github", "hello");
    await expect(stream.next()).rejects.toThrow("Server not found");
  });

  it("yields parsed SSE events", async () => {
    const { parseSSEStream } = await import("@atlas/utils/sse");
    const mockStream = async function* () {
      yield { event: "chunk", data: '{"text":"Hello"}' };
      yield { event: "tool_call", data: '{"toolCallId":"1","toolName":"search","input":{}}' };
      yield { event: "tool_result", data: '{"toolCallId":"1","output":"result"}' };
      yield { event: "done", data: "{}" };
    };
    (parseSSEStream as ReturnType<typeof vi.fn>).mockImplementation(mockStream);

    fetchSpy.mockResolvedValue(new Response(new ReadableStream()));

    const stream = testChatEventStream("github", "hello", "ws-1");
    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "chunk", text: "Hello" },
      { type: "tool_call", toolCallId: "1", toolName: "search", input: {} },
      { type: "tool_result", toolCallId: "1", output: "result" },
      { type: "done" },
    ]);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/daemon/api/mcp-registry/github/test-chat?workspaceId=ws-1"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        }),
        body: JSON.stringify({ message: "hello" }),
      }),
    );
  });

  it("yields error events with phase", async () => {
    const { parseSSEStream } = await import("@atlas/utils/sse");
    const mockStream = async function* () {
      yield { event: "error", data: '{"error":"Auth failed","phase":"auth"}' };
    };
    (parseSSEStream as ReturnType<typeof vi.fn>).mockImplementation(mockStream);

    fetchSpy.mockResolvedValue(new Response(new ReadableStream()));

    const stream = testChatEventStream("github", "hello");
    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "error", error: "Auth failed", phase: "auth" }]);
  });
});

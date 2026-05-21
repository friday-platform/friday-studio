import type { Logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeleteAgentFromRegistryTool,
  createRegisterAgentTool,
} from "./agent-registry-tools.ts";

vi.mock("@atlas/oapi-client", () => ({ getAtlasDaemonUrl: () => "http://localhost:8080" }));

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } satisfies Record<keyof Logger, unknown>;
}

const TOOL_CALL_OPTS = { toolCallId: "test-call", messages: [] as never[] };

const fetchSpy = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// =============================================================================
// register_agent
// =============================================================================

describe("createRegisterAgentTool", () => {
  it("registers register_agent tool", () => {
    const tools = createRegisterAgentTool(makeLogger());
    expect(tools).toHaveProperty("register_agent");
  });

  it("POSTs JSON entrypoint to /api/agents/register and returns the parsed agent", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          agent: {
            id: "triage-agent",
            version: "0.1.0",
            description: "Triages incoming work",
            path: "/home/user/.friday/agents/triage-agent@0.1.0",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tools = createRegisterAgentTool(makeLogger());
    const result = await tools.register_agent?.execute?.(
      { entrypoint: "/Users/me/projects/triage-agent/agent.py" },
      TOOL_CALL_OPTS,
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8080/api/agents/register",
      expect.objectContaining({ method: "POST" }),
    );
    const call = fetchSpy.mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      entrypoint: "/Users/me/projects/triage-agent/agent.py",
    });
    expect(result).toMatchObject({ ok: true, agent: { id: "triage-agent", version: "0.1.0" } });
  });

  it("returns ok:false with phase from a daemon validation error", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "validate timeout", phase: "validate" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const tools = createRegisterAgentTool(makeLogger());
    const result = await tools.register_agent?.execute?.(
      { entrypoint: "/path/to/agent.py" },
      TOOL_CALL_OPTS,
    );

    expect(result).toMatchObject({ ok: false, error: "validate timeout", phase: "validate" });
  });

  it("returns ok:false on network failure", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    const tools = createRegisterAgentTool(makeLogger());
    const result = await tools.register_agent?.execute?.(
      { entrypoint: "/path/to/agent.py" },
      TOOL_CALL_OPTS,
    );

    expect(result).toMatchObject({ ok: false, error: "register_agent failed: network error" });
  });

  it("returns ok:false on unexpected response shape", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tools = createRegisterAgentTool(makeLogger());
    const result = await tools.register_agent?.execute?.(
      { entrypoint: "/path/to/agent.py" },
      TOOL_CALL_OPTS,
    );

    expect(result).toMatchObject({ ok: false });
  });
});

// =============================================================================
// delete_agent_from_registry
// =============================================================================

describe("createDeleteAgentFromRegistryTool", () => {
  it("registers delete_agent_from_registry tool", () => {
    const tools = createDeleteAgentFromRegistryTool(makeLogger());
    expect(tools).toHaveProperty("delete_agent_from_registry");
  });

  it("DELETEs /api/agents/:id without version when none is supplied", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          agent: { id: "triage-agent", deleted: ["/home/user/.friday/agents/triage-agent@0.1.0"] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tools = createDeleteAgentFromRegistryTool(makeLogger());
    const result = await tools.delete_agent_from_registry?.execute?.(
      { id: "triage-agent" },
      TOOL_CALL_OPTS,
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8080/api/agents/triage-agent",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(result).toMatchObject({
      ok: true,
      agent: { id: "triage-agent", deleted: expect.any(Array) },
    });
  });

  it("appends version to the URL when provided", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          agent: { id: "triage-agent", deleted: ["/path/triage-agent@0.1.0"] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tools = createDeleteAgentFromRegistryTool(makeLogger());
    await tools.delete_agent_from_registry?.execute?.(
      { id: "triage-agent", version: "0.1.0" },
      TOOL_CALL_OPTS,
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8080/api/agents/triage-agent?version=0.1.0",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("URL-encodes the agent id", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, agent: { id: "weird id", deleted: ["/p"] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tools = createDeleteAgentFromRegistryTool(makeLogger());
    await tools.delete_agent_from_registry?.execute?.({ id: "weird id" }, TOOL_CALL_OPTS);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8080/api/agents/weird%20id",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("returns ok:false when the agent isn't a user agent", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: 'Agent "delegate" is not a user agent — bundled and SDK agents cannot be deleted.',
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );

    const tools = createDeleteAgentFromRegistryTool(makeLogger());
    const result = await tools.delete_agent_from_registry?.execute?.(
      { id: "delegate" },
      TOOL_CALL_OPTS,
    );

    expect(result).toMatchObject({ ok: false });
  });

  it("returns ok:false on network failure", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    const tools = createDeleteAgentFromRegistryTool(makeLogger());
    const result = await tools.delete_agent_from_registry?.execute?.(
      { id: "triage-agent" },
      TOOL_CALL_OPTS,
    );

    expect(result).toMatchObject({
      ok: false,
      error: "delete_agent_from_registry failed: network error",
    });
  });
});

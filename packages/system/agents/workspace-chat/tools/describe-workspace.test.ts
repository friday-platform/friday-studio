import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockParseResult } = vi.hoisted(() => ({
  mockParseResult: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
}));

vi.mock("@atlas/client/v2", () => ({
  client: {
    workspace: {
      ":workspaceId": {
        $get: () => undefined,
        agents: { $get: () => undefined },
        jobs: { $get: () => undefined },
        signals: { $get: () => undefined },
        config: { $get: () => undefined },
      },
    },
  },
  parseResult: mockParseResult,
}));

import { createDescribeWorkspaceTool, type WorkspaceInventory } from "./describe-workspace.ts";
import type { ReadResponse } from "./envelope.ts";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

beforeEach(() => {
  mockParseResult.mockReset();
});

interface ToolWithExecute {
  execute: (input: { scope?: string }) => Promise<unknown>;
}

function getTool() {
  const tools = createDescribeWorkspaceTool("ws-1", logger);
  return tools.describe_workspace as unknown as ToolWithExecute;
}

/**
 * The tool fires five parallel parseResult calls per execute(). The mock
 * returns one queued result per call, in order: workspace, agents, jobs,
 * signals, config.
 */
function setupAllOk(opts: {
  workspace?: { name?: string; description?: string };
  agents?: Array<{ id: string; type?: string; description?: string }>;
  jobs?: Array<{ id: string; name: string; description?: string }>;
  signals?: { signals: Array<{ name: string; provider?: string }> };
  config?: { config?: { workspace?: { mcp_servers?: unknown } } };
}) {
  mockParseResult
    .mockResolvedValueOnce({ ok: true, data: opts.workspace ?? { name: "Personal" } })
    .mockResolvedValueOnce({ ok: true, data: opts.agents ?? [] })
    .mockResolvedValueOnce({ ok: true, data: opts.jobs ?? [] })
    .mockResolvedValueOnce({ ok: true, data: opts.signals ?? { signals: [] } })
    .mockResolvedValueOnce({ ok: true, data: opts.config ?? {} });
}

describe("describe_workspace", () => {
  it("returns inventory by default with names + counts", async () => {
    setupAllOk({
      workspace: { name: "Personal", description: "Default" },
      agents: [{ id: "a1" }, { id: "a2" }],
      jobs: [{ id: "j1", name: "Job One" }],
      signals: { signals: [{ name: "s1" }] },
      config: { config: { workspace: { mcp_servers: ["google-gmail", { id: "filesystem" }] } } },
    });
    const result = (await getTool().execute({})) as ReadResponse<WorkspaceInventory>;
    expect(result.items).toHaveLength(1);
    const inv = result.items[0];
    expect(inv?.id).toBe("ws-1");
    expect(inv?.name).toBe("Personal");
    expect(inv?.agentCount).toBe(2);
    expect(inv?.jobCount).toBe(1);
    expect(inv?.signalCount).toBe(1);
    expect(inv?.mcpServerCount).toBe(2);
    expect(inv?.agentNames).toEqual(["a1", "a2"]);
    expect(inv?.mcpServerIds).toEqual(["google-gmail", "filesystem"]);
    expect(result.provenance.source).toBe("system-config");
    expect(result.provenance.origin).toBe("workspace:ws-1");
  });

  it("returns per-agent details with scope=agents", async () => {
    setupAllOk({
      agents: [
        { id: "a1", type: "llm", description: "Triage" },
        { id: "a2", type: "user" },
      ],
    });
    const result = (await getTool().execute({ scope: "agents" })) as ReadResponse<unknown>;
    expect(result.items).toEqual([
      { id: "a1", type: "llm", description: "Triage" },
      { id: "a2", type: "user" },
    ]);
  });

  it("returns mcp server entries with scope=mcp_servers", async () => {
    setupAllOk({ config: { config: { workspace: { mcp_servers: ["google-gmail", "slack"] } } } });
    const result = (await getTool().execute({ scope: "mcp_servers" })) as ReadResponse<{
      id: string;
    }>;
    expect(result.items.map((i) => i.id)).toEqual(["google-gmail", "slack"]);
  });

  it("falls back to workspaceId for name when workspace fetch fails", async () => {
    mockParseResult
      .mockResolvedValueOnce({ ok: false, error: "boom" })
      .mockResolvedValueOnce({ ok: true, data: [] })
      .mockResolvedValueOnce({ ok: true, data: [] })
      .mockResolvedValueOnce({ ok: true, data: { signals: [] } })
      .mockResolvedValueOnce({ ok: true, data: {} });
    const result = (await getTool().execute({})) as ReadResponse<WorkspaceInventory>;
    expect(result.items[0]?.name).toBe("ws-1");
  });
});

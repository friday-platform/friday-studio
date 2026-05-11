import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockReaddir, mockRm, mockStat, mockReload, mockGetUserAgentSummary, mockGetAgent } =
  vi.hoisted(() => ({
    mockReaddir: vi.fn(),
    mockRm: vi.fn(),
    mockStat: vi.fn(),
    mockReload: vi.fn(),
    mockGetUserAgentSummary: vi.fn(),
    mockGetAgent: vi.fn(),
  }));

vi.mock("node:fs/promises", () => ({ readdir: mockReaddir, rm: mockRm, stat: mockStat }));

vi.mock("@atlas/utils/paths.server", () => ({ getFridayHome: () => "/mock-friday-home" }));

vi.mock("@atlas/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../src/factory.ts", () => ({
  daemonFactory: {
    createApp: () => {
      // Minimal Hono-like shim — collect handler so we can invoke it directly.
      let handler: ((c: unknown) => Promise<Response>) | null = null;
      return {
        delete: (_path: string, h: (c: unknown) => Promise<Response>) => {
          handler = h;
        },
        get _handler() {
          return handler;
        },
      };
    },
  },
}));

import { deleteAgentRoute } from "./delete.ts";

interface MockContext {
  req: { param: () => Record<string, string>; query: () => Record<string, string> };
  json: (body: unknown, status?: number) => Response;
  get: (key: string) => unknown;
}

function createCtx(
  params: Record<string, string>,
  query: Record<string, string> = {},
): MockContext {
  return {
    req: { param: () => params, query: () => query },
    json: (body, status) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    get: () => ({
      getAgentRegistry: () => ({
        getUserAgentSummary: mockGetUserAgentSummary,
        getAgent: mockGetAgent,
        reload: mockReload,
      }),
    }),
  };
}

beforeEach(() => {
  mockReaddir.mockReset();
  mockRm.mockReset();
  mockStat.mockReset();
  mockReload.mockReset();
  mockGetUserAgentSummary.mockReset();
  mockGetAgent.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleteAgentRoute", () => {
  it("returns 404 when the agent isn't registered", async () => {
    mockGetUserAgentSummary.mockReturnValue(undefined);
    mockGetAgent.mockResolvedValue(undefined);

    const handler = (
      deleteAgentRoute as unknown as { _handler: (c: MockContext) => Promise<Response> }
    )._handler;
    const res = await handler(createCtx({ id: "ghost" }));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: expect.stringContaining('"ghost"') });
  });

  it("returns 400 when the agent is bundled / SDK", async () => {
    mockGetUserAgentSummary.mockReturnValue(undefined);
    mockGetAgent.mockResolvedValue({ metadata: { id: "delegate" } });

    const handler = (
      deleteAgentRoute as unknown as { _handler: (c: MockContext) => Promise<Response> }
    )._handler;
    const res = await handler(createCtx({ id: "delegate" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: expect.stringContaining("not a user agent") });
  });

  it("deletes a single version when version is provided", async () => {
    mockGetUserAgentSummary.mockReturnValue({ id: "triage", version: "0.1.0" });
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockRm.mockResolvedValue(undefined);

    const handler = (
      deleteAgentRoute as unknown as { _handler: (c: MockContext) => Promise<Response> }
    )._handler;
    const res = await handler(createCtx({ id: "triage" }, { version: "0.1.0" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      agent: { id: "triage", deleted: ["/mock-friday-home/agents/triage@0.1.0"] },
    });
    expect(mockRm).toHaveBeenCalledWith(
      "/mock-friday-home/agents/triage@0.1.0",
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(mockReload).toHaveBeenCalled();
  });

  it("deletes all versions when version is omitted", async () => {
    mockGetUserAgentSummary.mockReturnValue({ id: "triage" });
    mockReaddir.mockResolvedValue(["triage@0.1.0", "triage@0.2.0", "other@1.0.0"]);
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockRm.mockResolvedValue(undefined);

    const handler = (
      deleteAgentRoute as unknown as { _handler: (c: MockContext) => Promise<Response> }
    )._handler;
    const res = await handler(createCtx({ id: "triage" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { deleted: string[] } };
    expect(body.agent.deleted).toHaveLength(2);
    expect(body.agent.deleted).toContain("/mock-friday-home/agents/triage@0.1.0");
    expect(body.agent.deleted).toContain("/mock-friday-home/agents/triage@0.2.0");
    expect(body.agent.deleted).not.toContain("/mock-friday-home/agents/other@1.0.0");
    expect(mockReload).toHaveBeenCalled();
  });

  it("returns 404 when the agent is registered but no on-disk artifacts exist", async () => {
    mockGetUserAgentSummary.mockReturnValue({ id: "triage" });
    mockReaddir.mockResolvedValue(["other@1.0.0"]);

    const handler = (
      deleteAgentRoute as unknown as { _handler: (c: MockContext) => Promise<Response> }
    )._handler;
    const res = await handler(createCtx({ id: "triage" }));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, deleted: [] });
  });
});

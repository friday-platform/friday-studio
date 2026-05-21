import type { Logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockFetchLinkSummary } = vi.hoisted(() => ({ mockFetchLinkSummary: vi.fn() }));

vi.mock("../../link-context.ts", () => ({ fetchLinkSummary: mockFetchLinkSummary }));

vi.mock("@atlas/core/mcp-registry/registry-consolidated", () => ({
  mcpServersRegistry: {
    servers: {
      gmail: { urlDomains: ["mail.google.com", "googleapis.com"] },
      slack: { urlDomains: ["slack.com"] },
    },
  },
}));

import { createDescribeIntegrationTool, createListIntegrationsTool } from "./integration-tools.ts";

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

beforeEach(() => {
  mockFetchLinkSummary.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// list_integrations
// =============================================================================

describe("createListIntegrationsTool", () => {
  it("registers list_integrations tool", () => {
    const tools = createListIntegrationsTool(makeLogger());
    expect(tools).toHaveProperty("list_integrations");
  });

  it("returns providers as ready/unconnected with credentials grouped", async () => {
    mockFetchLinkSummary.mockResolvedValue({
      providers: [{ id: "gmail" }, { id: "slack" }],
      credentials: [
        { provider: "gmail", label: "personal@gmail.com", isDefault: true },
        { provider: "gmail", label: "work@gmail.com" },
      ],
    });

    const tools = createListIntegrationsTool(makeLogger());
    const result = await tools.list_integrations?.execute?.({}, TOOL_CALL_OPTS);

    expect(result).toMatchObject({
      ok: true,
      count: 2,
      integrations: [
        {
          provider: "gmail",
          status: "ready",
          urlDomains: ["mail.google.com", "googleapis.com"],
          credentials: [
            { label: "personal@gmail.com", isDefault: true },
            { label: "work@gmail.com" },
          ],
        },
        { provider: "slack", status: "unconnected", urlDomains: ["slack.com"], credentials: [] },
      ],
    });
  });

  it("returns ok:false when Link summary is unavailable", async () => {
    mockFetchLinkSummary.mockResolvedValue(null);

    const tools = createListIntegrationsTool(makeLogger());
    const result = await tools.list_integrations?.execute?.({}, TOOL_CALL_OPTS);

    expect(result).toMatchObject({ ok: false });
  });

  it("sorts integrations alphabetically by provider id", async () => {
    mockFetchLinkSummary.mockResolvedValue({
      providers: [{ id: "slack" }, { id: "gmail" }],
      credentials: [],
    });

    const tools = createListIntegrationsTool(makeLogger());
    const result = await tools.list_integrations?.execute?.({}, TOOL_CALL_OPTS);

    const ids = (result as { integrations: Array<{ provider: string }> }).integrations.map(
      (i) => i.provider,
    );
    expect(ids).toEqual(["gmail", "slack"]);
  });
});

// =============================================================================
// describe_integration
// =============================================================================

describe("createDescribeIntegrationTool", () => {
  it("registers describe_integration tool", () => {
    const tools = createDescribeIntegrationTool(makeLogger());
    expect(tools).toHaveProperty("describe_integration");
  });

  it("returns the matching provider with credentials and urlDomains", async () => {
    mockFetchLinkSummary.mockResolvedValue({
      providers: [{ id: "gmail" }, { id: "slack" }],
      credentials: [{ provider: "gmail", label: "personal@gmail.com", isDefault: true }],
    });

    const tools = createDescribeIntegrationTool(makeLogger());
    const result = await tools.describe_integration?.execute?.(
      { provider: "gmail" },
      TOOL_CALL_OPTS,
    );

    expect(result).toMatchObject({
      ok: true,
      integration: {
        provider: "gmail",
        status: "ready",
        urlDomains: ["mail.google.com", "googleapis.com"],
        credentials: [{ label: "personal@gmail.com", isDefault: true }],
      },
    });
  });

  it("returns ok:false when the provider id isn't in the summary", async () => {
    mockFetchLinkSummary.mockResolvedValue({ providers: [{ id: "gmail" }], credentials: [] });

    const tools = createDescribeIntegrationTool(makeLogger());
    const result = await tools.describe_integration?.execute?.(
      { provider: "ghost" },
      TOOL_CALL_OPTS,
    );

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("ghost") });
  });

  it("returns ok:false when Link summary is unavailable", async () => {
    mockFetchLinkSummary.mockResolvedValue(null);

    const tools = createDescribeIntegrationTool(makeLogger());
    const result = await tools.describe_integration?.execute?.(
      { provider: "gmail" },
      TOOL_CALL_OPTS,
    );

    expect(result).toMatchObject({ ok: false });
  });
});

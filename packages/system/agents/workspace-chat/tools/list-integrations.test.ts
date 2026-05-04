import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchLinkSummary = vi.hoisted(() =>
  vi.fn<() => Promise<unknown | null>>().mockResolvedValue(null),
);

vi.mock("../../link-context.ts", () => ({ fetchLinkSummary: mockFetchLinkSummary }));

import type { ReadResponse } from "./envelope.ts";
import { createListIntegrationsTool, type IntegrationItem } from "./list-integrations.ts";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

beforeEach(() => {
  mockFetchLinkSummary.mockReset();
});

interface ToolWithExecute {
  execute: (input: { status?: "ready" | "unconnected" | "all" }) => Promise<unknown>;
}

function getTool() {
  const tools = createListIntegrationsTool(logger);
  return tools.list_integrations as unknown as ToolWithExecute;
}

describe("list_integrations", () => {
  it("returns empty envelope when Link summary unavailable", async () => {
    mockFetchLinkSummary.mockResolvedValueOnce(null);
    const result = (await getTool().execute({})) as ReadResponse<IntegrationItem>;
    expect(result.items).toEqual([]);
    expect(result.provenance.source).toBe("system-config");
    expect(result.provenance.origin).toBe("link:summary");
  });

  it("emits ready entries for connected providers and unconnected entries for the rest", async () => {
    mockFetchLinkSummary.mockResolvedValueOnce({
      providers: [
        { id: "google-gmail", urlDomains: ["mail.google.com"] },
        { id: "slack", urlDomains: ["slack.com"] },
      ],
      credentials: [{ provider: "google-gmail", label: "ken@tempest.team", isDefault: true }],
    });
    const result = (await getTool().execute({})) as ReadResponse<IntegrationItem>;
    expect(result.items).toHaveLength(2);
    const gmail = result.items.find((i) => i.id === "google-gmail");
    const slack = result.items.find((i) => i.id === "slack");
    expect(gmail).toEqual({
      id: "google-gmail",
      status: "ready",
      label: "ken@tempest.team",
      isDefault: true,
      urlDomains: "mail.google.com",
    });
    expect(slack).toEqual({ id: "slack", status: "unconnected", urlDomains: "slack.com" });
  });

  it("filters by status=ready", async () => {
    mockFetchLinkSummary.mockResolvedValueOnce({
      providers: [
        { id: "google-gmail", urlDomains: ["mail.google.com"] },
        { id: "slack", urlDomains: ["slack.com"] },
      ],
      credentials: [{ provider: "google-gmail", label: "x", isDefault: true }],
    });
    const result = (await getTool().execute({ status: "ready" })) as ReadResponse<IntegrationItem>;
    expect(result.items.map((i) => i.id)).toEqual(["google-gmail"]);
  });

  it("filters by status=unconnected", async () => {
    mockFetchLinkSummary.mockResolvedValueOnce({
      providers: [
        { id: "google-gmail", urlDomains: ["mail.google.com"] },
        { id: "slack", urlDomains: ["slack.com"] },
      ],
      credentials: [{ provider: "google-gmail", label: "x", isDefault: true }],
    });
    const result = (await getTool().execute({
      status: "unconnected",
    })) as ReadResponse<IntegrationItem>;
    expect(result.items.map((i) => i.id)).toEqual(["slack"]);
  });
});

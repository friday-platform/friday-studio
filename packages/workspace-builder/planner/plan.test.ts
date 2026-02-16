import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before the module under test is imported
// ---------------------------------------------------------------------------

const mockGenerateObject = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({ generateObject: mockGenerateObject }));

vi.mock("@atlas/agent-sdk", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, repairJson: vi.fn((text: string) => text) };
});

vi.mock("@atlas/llm", () => ({
  getDefaultProviderOpts: vi.fn(() => ({})),
  registry: { languageModel: vi.fn(() => "mock-model") },
}));

vi.mock("evalite/ai-sdk", () => ({ wrapAISDKModel: vi.fn((m: unknown) => m) }));

vi.mock("@atlas/logger", () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

vi.mock("@atlas/utils", () => ({ getTodaysDate: vi.fn(() => "2026-02-11") }));

vi.mock("../../system/agents/conversation/capabilities.ts", () => ({
  getCapabilitiesSection: vi.fn(() => "mock capabilities"),
}));

vi.mock("../../system/agents/conversation/link-context.ts", () => ({
  fetchLinkSummary: vi.fn(() => null),
  formatIntegrationsSection: vi.fn(() => ""),
}));

import { generatePlan } from "./plan.ts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generatePlan — mode parameter", () => {
  beforeEach(() => {
    mockGenerateObject.mockReset();
  });

  it("task mode returns empty signals and kebab-cased agent IDs", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        plan: {
          workspace: { name: "Test Task", purpose: "Analyze a CSV" },
          agents: [
            { name: "Data Analyst", description: "Analyzes CSV data", needs: ["data-analysis"] },
          ],
        },
      },
    });

    const result = await generatePlan("Analyze this CSV file", { mode: "task" });

    expect(result.signals).toEqual([]);
    expect(result.agents).toEqual([
      expect.objectContaining({ id: "data-analyst", name: "Data Analyst" }),
    ]);
    expect(result.workspace.name).toBe("Test Task");
  });

  it("task mode prompt excludes signal instructions", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { plan: { workspace: { name: "Test", purpose: "Test" }, agents: [] } },
    });

    await generatePlan("do something", { mode: "task" });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("triggered ad-hoc"),
          }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Do not generate signals"),
          }),
        ]),
      }),
    );
    // Verify signal instructions are excluded
    expect(mockGenerateObject).not.toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining("Signal Types") }),
        ]),
      }),
    );
  });

  it("workspace mode returns signals and agents with kebab-cased IDs", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        plan: {
          workspace: { name: "PR Summary", purpose: "Summarize PRs weekly" },
          signals: [
            {
              name: "Weekly Check",
              title: "Triggers weekly on Friday",
              signalType: "schedule",
              description: "Runs every Friday at 9am",
              displayLabel: "Every Friday at 9am",
            },
          ],
          agents: [{ name: "PR Reader", description: "Reads merged PRs", needs: ["github"] }],
        },
      },
    });

    const result = await generatePlan("Summarize PRs weekly");

    expect(result.signals).toEqual([
      expect.objectContaining({ id: "weekly-check", name: "Weekly Check" }),
    ]);
    expect(result.agents).toEqual([
      expect.objectContaining({ id: "pr-reader", name: "PR Reader" }),
    ]);
  });

  it("workspace mode prompt includes Signal Types section", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { plan: { workspace: { name: "Test", purpose: "Test" }, signals: [], agents: [] } },
    });

    await generatePlan("do something", { mode: "workspace" });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Signal Types"),
          }),
        ]),
      }),
    );
    // Verify task-only instructions are excluded
    expect(mockGenerateObject).not.toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining("triggered ad-hoc") }),
        ]),
      }),
    );
  });
});

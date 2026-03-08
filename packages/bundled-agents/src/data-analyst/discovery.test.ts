/**
 * Phase 1 Data Discovery Tests
 *
 * Tests the discoverDataSources function — verifies it passes the correct
 * prompt, system prompt, model, and options to generateObject. Since the
 * extraction logic lives in the LLM prompt, tests assert on prompt content
 * rather than mock return values.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { discoverDataSources } from "./discovery.ts";

// ---------------------------------------------------------------------------
// Mock ai SDK
// ---------------------------------------------------------------------------

const generateObjectMock = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({ generateObject: generateObjectMock }));

vi.mock("@atlas/llm", () => ({
  registry: { languageModel: vi.fn(() => "mock-model") },
  traceModel: vi.fn((m: unknown) => m),
}));

afterEach(() => {
  generateObjectMock.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discoverDataSources", () => {
  test("passes user prompt through to generateObject", async () => {
    generateObjectMock.mockResolvedValue({ object: { question: "test", artifactIds: [] } });

    const prompt = "Analyze my sales data for Q4 trends";
    await discoverDataSources(prompt);

    expect(generateObjectMock).toHaveBeenCalledOnce();
    const call = generateObjectMock.mock.calls[0];
    if (!call) throw new Error("Expected generateObject to have been called");
    const callArgs = call[0];
    expect(callArgs.prompt).toContain(prompt);
  });

  test("system prompt instructs LLM to include Signal Data and Datasets, not Files or External", async () => {
    generateObjectMock.mockResolvedValue({ object: { question: "test", artifactIds: [] } });

    await discoverDataSources("test");

    const callArgs = generateObjectMock.mock.calls[0]?.[0];
    if (typeof callArgs?.system !== "string") throw new Error("Expected string system prompt");
    const system = callArgs.system;

    expect(system).toContain("Signal Data");
    expect(system).toContain("Datasets");
    expect(system).toContain("Do NOT include");
    expect(system).toContain("Files");
    expect(system).toContain("External");
  });

  test("passes abort signal to generateObject", async () => {
    generateObjectMock.mockResolvedValue({ object: { question: "test", artifactIds: [] } });

    const controller = new AbortController();
    await discoverDataSources("test prompt", controller.signal);

    const call = generateObjectMock.mock.calls[0];
    if (!call) throw new Error("Expected generateObject to have been called");
    const callArgs = call[0];
    expect(callArgs.abortSignal).toBe(controller.signal);
  });

  test("uses haiku model for lightweight discovery", async () => {
    const { registry } = await import("@atlas/llm");
    generateObjectMock.mockResolvedValue({ object: { question: "test", artifactIds: [] } });

    await discoverDataSources("test prompt");

    expect(registry.languageModel).toHaveBeenCalledWith("anthropic:claude-haiku-4-5");
  });

  test("returns the LLM-resolved object directly", async () => {
    const expected = { question: "What are sales?", artifactIds: ["art-1"] };
    generateObjectMock.mockResolvedValue({ object: expected });

    const result = await discoverDataSources("What are sales?");

    expect(result).toEqual(expected);
  });
});

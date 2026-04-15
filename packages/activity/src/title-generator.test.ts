import { createStubPlatformModels } from "@atlas/llm";
import { describe, expect, it, vi } from "vitest";
import { generateResourceActivityTitle, generateSessionActivityTitle } from "./title-generator.ts";
import { generateUserActivityTitle } from "./title-utils.ts";

const stubPlatformModels = createStubPlatformModels();

describe("generateSessionActivityTitle", () => {
  it("passes correct context to LLM prompt", async () => {
    const mockLLM = vi
      .fn<
        (params: { system: string; prompt: string; maxOutputTokens?: number }) => Promise<string>
      >()
      .mockResolvedValue("Deployed API gateway to staging");

    await generateSessionActivityTitle({
      status: "completed",
      jobName: "deploy-api",
      agentNames: ["deployer", "validator"],
      finalOutput: "Deployment successful",
      _llm: mockLLM,
      platformModels: stubPlatformModels,
    });

    expect(mockLLM).toHaveBeenCalledOnce();
    const callArgs = mockLLM.mock.calls[0]?.[0];
    expect(callArgs?.prompt).toContain("deploy-api");
    expect(callArgs?.prompt).toContain("deployer, validator");
    expect(callArgs?.prompt).toContain("Deployment successful");
    expect(callArgs?.prompt).toContain("completed");
  });

  it("includes error in prompt when provided", async () => {
    const mockLLM = vi
      .fn<
        (params: { system: string; prompt: string; maxOutputTokens?: number }) => Promise<string>
      >()
      .mockResolvedValue("API deploy failed due to timeout");

    await generateSessionActivityTitle({
      status: "failed",
      jobName: "deploy-api",
      agentNames: ["deployer"],
      finalOutput: undefined,
      error: "Connection timeout",
      _llm: mockLLM,
      platformModels: stubPlatformModels,
    });

    const callArgs = mockLLM.mock.calls[0]?.[0];
    expect(callArgs?.prompt).toContain("Connection timeout");
  });

  it("returns LLM result when valid", async () => {
    const mockLLM = vi
      .fn<
        (params: { system: string; prompt: string; maxOutputTokens?: number }) => Promise<string>
      >()
      .mockResolvedValue("Deployed API gateway to staging");

    const title = await generateSessionActivityTitle({
      status: "completed",
      jobName: "deploy-api",
      agentNames: ["deployer"],
      finalOutput: "Deployment successful",
      _llm: mockLLM,
      platformModels: stubPlatformModels,
    });

    expect(title).toBe("Deployed API gateway to staging");
  });

  it("falls back on LLM failure (never throws)", async () => {
    const mockLLM = vi
      .fn<
        (params: { system: string; prompt: string; maxOutputTokens?: number }) => Promise<string>
      >()
      .mockRejectedValue(new Error("LLM unavailable"));

    const title = await generateSessionActivityTitle({
      status: "completed",
      jobName: "deploy-api",
      agentNames: [],
      finalOutput: undefined,
      _llm: mockLLM,
      platformModels: stubPlatformModels,
    });

    expect(title).toBe("Deploy api session completed");
  });

  it("falls back when LLM returns too-short string", async () => {
    const mockLLM = vi
      .fn<
        (params: { system: string; prompt: string; maxOutputTokens?: number }) => Promise<string>
      >()
      .mockResolvedValue("ab");

    const title = await generateSessionActivityTitle({
      status: "failed",
      jobName: "daily-report",
      agentNames: [],
      finalOutput: undefined,
      _llm: mockLLM,
      platformModels: stubPlatformModels,
    });

    expect(title).toBe("Daily report session failed");
  });

  it("uses failed status in fallback for non-completed sessions", async () => {
    const mockLLM = vi
      .fn<
        (params: { system: string; prompt: string; maxOutputTokens?: number }) => Promise<string>
      >()
      .mockRejectedValue(new Error("fail"));

    const title = await generateSessionActivityTitle({
      status: "error",
      jobName: "nightly-sync",
      agentNames: [],
      finalOutput: undefined,
      _llm: mockLLM,
      platformModels: stubPlatformModels,
    });

    expect(title).toBe("Nightly sync session failed");
  });
});

describe("generateResourceActivityTitle", () => {
  it("passes correct context to LLM", async () => {
    const mockLLM = vi
      .fn<
        (params: { system: string; prompt: string; maxOutputTokens?: number }) => Promise<string>
      >()
      .mockResolvedValue("Updated product roadmap document");

    await generateResourceActivityTitle({
      resourceName: "Product Roadmap",
      resourceSlug: "product-roadmap",
      resourceType: "document",
      _llm: mockLLM,
      platformModels: stubPlatformModels,
    });

    expect(mockLLM).toHaveBeenCalledOnce();
    const callArgs = mockLLM.mock.calls[0]?.[0];
    expect(callArgs?.prompt).toContain("Product Roadmap");
    expect(callArgs?.prompt).toContain("document");
    expect(callArgs?.prompt).toContain("product-roadmap");
  });

  it("returns LLM result when valid", async () => {
    const mockLLM = vi
      .fn<
        (params: { system: string; prompt: string; maxOutputTokens?: number }) => Promise<string>
      >()
      .mockResolvedValue("Updated product roadmap document");

    const title = await generateResourceActivityTitle({
      resourceName: "Product Roadmap",
      resourceSlug: "product-roadmap",
      resourceType: "document",
      _llm: mockLLM,
      platformModels: stubPlatformModels,
    });

    expect(title).toBe("Updated product roadmap document");
  });

  it("falls back on failure", async () => {
    const mockLLM = vi
      .fn<
        (params: { system: string; prompt: string; maxOutputTokens?: number }) => Promise<string>
      >()
      .mockRejectedValue(new Error("LLM unavailable"));

    const title = await generateResourceActivityTitle({
      resourceName: "Product Roadmap",
      resourceSlug: "product-roadmap",
      resourceType: "document",
      _llm: mockLLM,
      platformModels: stubPlatformModels,
    });

    expect(title).toBe("Product Roadmap was updated");
  });

  it("falls back when LLM returns too-short string", async () => {
    const mockLLM = vi
      .fn<
        (params: { system: string; prompt: string; maxOutputTokens?: number }) => Promise<string>
      >()
      .mockResolvedValue("x");

    const title = await generateResourceActivityTitle({
      resourceName: "API Docs",
      resourceSlug: "api-docs",
      resourceType: "document",
      _llm: mockLLM,
      platformModels: stubPlatformModels,
    });

    expect(title).toBe("API Docs was updated");
  });
});

describe("generateUserActivityTitle", () => {
  it.each([
    { action: "uploaded", expected: "{{user_id}} uploaded report.pdf" },
    { action: "replaced", expected: "{{user_id}} replaced report.pdf" },
    { action: "deleted", expected: "{{user_id}} deleted report.pdf" },
    { action: "linked", expected: "{{user_id}} linked report.pdf" },
  ] as const)("returns correct title for $action", ({ action, expected }) => {
    const title = generateUserActivityTitle(action, "report.pdf");
    expect(title).toBe(expected);
  });

  it("does not call LLM", () => {
    // generateUserActivityTitle is synchronous — no LLM parameter exists
    const title = generateUserActivityTitle("uploaded", "my-file.txt");
    expect(title).toBe("{{user_id}} uploaded my-file.txt");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidationResult } from "./validators/types.ts";

const mockAppendDiscoveryAsTask =
  vi.fn<
    (
      corpusBaseUrl: string,
      discovery: Record<string, unknown>,
    ) => Promise<{ id: string; createdAt: string }>
  >();

vi.mock("../../../../packages/memory/src/discovery-to-task.ts", () => ({
  appendDiscoveryAsTask: (url: string, d: Record<string, unknown>) =>
    mockAppendDiscoveryAsTask(url, d),
}));

const mockValidateTypecheck = vi.fn<() => Promise<ValidationResult>>();
const mockValidateLint = vi.fn<(files: string[]) => Promise<ValidationResult>>();
const mockValidateWorkspaceYml =
  vi.fn<
    (
      files: string[],
      opts?: { platformUrl?: string; dispatcherWorkspaceId?: string },
    ) => Promise<ValidationResult>
  >();
const mockValidateAgentBuild = vi.fn<(files: string[]) => Promise<ValidationResult>>();
const mockValidateSmokeTest =
  vi.fn<(files: string[], opts?: { platformUrl?: string }) => Promise<ValidationResult>>();

vi.mock("./validators/typecheck.ts", () => ({ validateTypecheck: () => mockValidateTypecheck() }));
vi.mock("./validators/lint.ts", () => ({
  validateLint: (files: string[]) => mockValidateLint(files),
}));
vi.mock("./validators/workspace-yml.ts", () => ({
  validateWorkspaceYml: (files: string[], opts?: Record<string, unknown>) =>
    mockValidateWorkspaceYml(
      files,
      opts as { platformUrl?: string; dispatcherWorkspaceId?: string },
    ),
}));
vi.mock("./validators/agent-build.ts", () => ({
  validateAgentBuild: (files: string[]) => mockValidateAgentBuild(files),
}));
vi.mock("./validators/smoke-test.ts", () => ({
  validateSmokeTest: (files: string[], opts?: { platformUrl?: string }) =>
    mockValidateSmokeTest(files, opts),
}));

import {
  PostSessionValidatorInputSchema,
  runPostSessionValidator,
  ValidatorDiscoverySchema,
} from "./job.ts";

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "sess-001",
    changedFiles: ["packages/core/src/index.ts"],
    taskId: "task-abc",
    taskBrief: "Fix the widget",
    taskPriority: 50,
    workspaceId: "braised_biscuit",
    dispatcherWorkspaceId: "thick_endive",
    ...overrides,
  };
}

function passResult(validator: string): ValidationResult {
  return { validator, ok: true, message: `${validator} passed`, evidence: [] };
}

function failResult(
  validator: string,
  evidence: string[] = ["error: something broke"],
): ValidationResult {
  return { validator, ok: false, message: `${validator} failed`, evidence };
}

function setupAllPass(): void {
  mockValidateTypecheck.mockResolvedValue(passResult("typecheck"));
  mockValidateLint.mockResolvedValue(passResult("lint"));
  mockValidateWorkspaceYml.mockResolvedValue(passResult("workspace-yml"));
  mockValidateAgentBuild.mockResolvedValue(passResult("agent-build"));
  mockValidateSmokeTest.mockResolvedValue(passResult("smoke-test"));
}

describe("runPostSessionValidator", () => {
  let fetchCalls: Array<{ url: string; body: unknown }>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;

    globalThis.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        fetchCalls.push({ url, body });
        return Promise.resolve(
          new Response(JSON.stringify({ id: "entry-1", createdAt: "2026-04-14T00:00:00Z" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });

    mockAppendDiscoveryAsTask.mockReset();
    mockAppendDiscoveryAsTask.mockResolvedValue({
      id: "disc-1",
      createdAt: "2026-04-14T00:00:00Z",
    });
    mockValidateTypecheck.mockReset();
    mockValidateLint.mockReset();
    mockValidateWorkspaceYml.mockReset();
    mockValidateAgentBuild.mockReset();
    mockValidateSmokeTest.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("no changed files — appends validated:true without running validators", async () => {
    const result = await runPostSessionValidator(
      validInput({ changedFiles: [] }),
      "http://test:8080",
    );

    expect(result.validated).toBe(true);
    expect(result.results).toEqual([]);
    expect(result.discoveriesAppended).toBe(0);

    expect(mockValidateTypecheck).not.toHaveBeenCalled();
    expect(mockValidateLint).not.toHaveBeenCalled();
    expect(mockValidateWorkspaceYml).not.toHaveBeenCalled();
    expect(mockValidateAgentBuild).not.toHaveBeenCalled();
    expect(mockValidateSmokeTest).not.toHaveBeenCalled();

    expect(fetchCalls).toHaveLength(1);
    const backlogCall = fetchCalls[0];
    expect(backlogCall?.url).toContain("/api/memory/thick_endive/narrative/autopilot-backlog");
    expect(backlogCall?.body).toMatchObject({
      author: "post-session-validator",
      metadata: { validated: true },
    });
    expect(backlogCall?.body).toHaveProperty("text", "task:task-abc");
  });

  it("all validators pass — appends validated:true + status:completed", async () => {
    setupAllPass();

    const result = await runPostSessionValidator(validInput(), "http://test:8080");

    expect(result.validated).toBe(true);
    expect(result.results).toHaveLength(5);
    expect(result.results.every((r) => r.ok)).toBe(true);
    expect(result.discoveriesAppended).toBe(0);
    expect(mockAppendDiscoveryAsTask).not.toHaveBeenCalled();

    const backlogAppend = fetchCalls.find((c) => c.url.includes("/narrative/autopilot-backlog"));
    expect(backlogAppend).toBeDefined();
    expect(backlogAppend?.body).toMatchObject({
      text: "task:task-abc",
      author: "post-session-validator",
      metadata: { validated: true, status: "completed", sessionId: "sess-001" },
    });
  });

  it("validator failure — creates discovery task + appends status:blocked", async () => {
    mockValidateTypecheck.mockResolvedValue(failResult("typecheck", ["error TS2345: wrong type"]));
    mockValidateLint.mockResolvedValue(passResult("lint"));
    mockValidateWorkspaceYml.mockResolvedValue(passResult("workspace-yml"));
    mockValidateAgentBuild.mockResolvedValue(passResult("agent-build"));
    mockValidateSmokeTest.mockResolvedValue(passResult("smoke-test"));

    const result = await runPostSessionValidator(validInput(), "http://test:8080");

    expect(result.validated).toBe(false);
    expect(result.discoveriesAppended).toBe(1);

    expect(mockAppendDiscoveryAsTask).toHaveBeenCalledOnce();
    const discovery = mockAppendDiscoveryAsTask.mock.calls[0]?.[1];
    expect(discovery).toMatchObject({
      discovered_by: "post-session-validator",
      discovered_session: "sess-001",
      target_workspace_id: "braised_biscuit",
      target_signal_id: "run-task",
      kind: "validator-finding",
      auto_apply: false,
      priority: 51,
    });
    expect(discovery?.title).toMatch(/^typecheck:/);
    expect(discovery?.brief).toContain("error TS2345: wrong type");
    expect(discovery?.brief).toContain("task-abc");
    expect(discovery?.brief).toContain("FIX");
    expect(discovery?.target_files).toEqual(["packages/core/src/index.ts"]);

    const backlogAppend = fetchCalls.find((c) => c.url.includes("/narrative/autopilot-backlog"));
    expect(backlogAppend?.body).toMatchObject({
      text: "task:task-abc",
      metadata: {
        status: "blocked",
        blocked_reason: "validation_failed",
        failing_validators: ["typecheck"],
      },
    });
  });

  it("multiple failures — creates one discovery per failure", async () => {
    mockValidateTypecheck.mockResolvedValue(failResult("typecheck"));
    mockValidateLint.mockResolvedValue(failResult("lint", ["error[no-unused-vars]: x is unused"]));
    mockValidateWorkspaceYml.mockResolvedValue(passResult("workspace-yml"));
    mockValidateAgentBuild.mockResolvedValue(
      failResult("agent-build", ["reflector: build failed"]),
    );
    mockValidateSmokeTest.mockResolvedValue(passResult("smoke-test"));

    const result = await runPostSessionValidator(validInput(), "http://test:8080");

    expect(result.validated).toBe(false);
    expect(result.discoveriesAppended).toBe(3);
    expect(mockAppendDiscoveryAsTask).toHaveBeenCalledTimes(3);

    const discoveryValidators = mockAppendDiscoveryAsTask.mock.calls.map(
      (call) => (call[1] as Record<string, unknown>)["discovered_by"],
    );
    expect(discoveryValidators).toEqual([
      "post-session-validator",
      "post-session-validator",
      "post-session-validator",
    ]);

    const backlogAppend = fetchCalls.find((c) => c.url.includes("/narrative/autopilot-backlog"));
    expect(backlogAppend?.body).toMatchObject({
      metadata: {
        status: "blocked",
        blocked_reason: "validation_failed",
        failing_validators: ["typecheck", "lint", "agent-build"],
      },
    });
  });

  it("priority is clamped to 100", async () => {
    mockValidateTypecheck.mockResolvedValue(failResult("typecheck"));
    mockValidateLint.mockResolvedValue(passResult("lint"));
    mockValidateWorkspaceYml.mockResolvedValue(passResult("workspace-yml"));
    mockValidateAgentBuild.mockResolvedValue(passResult("agent-build"));
    mockValidateSmokeTest.mockResolvedValue(passResult("smoke-test"));

    await runPostSessionValidator(validInput({ taskPriority: 100 }), "http://test:8080");

    const discovery = mockAppendDiscoveryAsTask.mock.calls[0]?.[1];
    expect(discovery?.priority).toBe(100);
  });

  it("buildDiscoveryBrief truncates evidence to 40 lines", async () => {
    const longEvidence = Array.from({ length: 60 }, (_, i) => `error line ${i + 1}`);
    mockValidateTypecheck.mockResolvedValue(failResult("typecheck", longEvidence));
    mockValidateLint.mockResolvedValue(passResult("lint"));
    mockValidateWorkspaceYml.mockResolvedValue(passResult("workspace-yml"));
    mockValidateAgentBuild.mockResolvedValue(passResult("agent-build"));
    mockValidateSmokeTest.mockResolvedValue(passResult("smoke-test"));

    await runPostSessionValidator(validInput(), "http://test:8080");

    const discovery = mockAppendDiscoveryAsTask.mock.calls[0]?.[1];
    const brief = discovery?.brief as string;
    expect(brief).toContain("error line 1");
    expect(brief).toContain("error line 40");
    expect(brief).not.toContain("error line 41");
    expect(brief).toContain("task-abc");
    expect(brief).toContain("FIX");
  });
});

describe("ValidatorDiscoverySchema", () => {
  it("rejects discovery with auto_apply:true", () => {
    const result = ValidatorDiscoverySchema.safeParse({
      discovered_by: "post-session-validator",
      discovered_session: "sess-001",
      target_workspace_id: "braised_biscuit",
      target_signal_id: "run-task",
      title: "typecheck: error TS2345",
      brief: "some brief",
      target_files: ["src/index.ts"],
      priority: 51,
      kind: "validator-finding",
      auto_apply: true,
    });
    expect(result.success).toBe(false);
  });

  it("accepts discovery with auto_apply:false", () => {
    const result = ValidatorDiscoverySchema.safeParse({
      discovered_by: "post-session-validator",
      discovered_session: "sess-001",
      target_workspace_id: "braised_biscuit",
      target_signal_id: "run-task",
      title: "typecheck: error TS2345",
      brief: "some brief",
      target_files: ["src/index.ts"],
      priority: 51,
      kind: "validator-finding",
      auto_apply: false,
    });
    expect(result.success).toBe(true);
  });
});

describe("PostSessionValidatorInputSchema", () => {
  it("accepts valid input", () => {
    const result = PostSessionValidatorInputSchema.safeParse(validInput());
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = PostSessionValidatorInputSchema.safeParse({ sessionId: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects wrong types", () => {
    const result = PostSessionValidatorInputSchema.safeParse(
      validInput({ taskPriority: "not-a-number" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects null payload", () => {
    const result = PostSessionValidatorInputSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects undefined payload", () => {
    const result = PostSessionValidatorInputSchema.safeParse(undefined);
    expect(result.success).toBe(false);
  });
});

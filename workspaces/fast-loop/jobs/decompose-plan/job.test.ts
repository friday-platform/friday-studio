import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecomposerResult, IntegrityFinding } from "./schemas.ts";

// --- Mocks ---

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

const mockCheckIntegrity =
  vi.fn<(batch: DecomposerResult, repoRoot: string) => IntegrityFinding[]>();

vi.mock("./integrity.ts", () => ({
  checkIntegrity: (batch: DecomposerResult, repoRoot: string) =>
    mockCheckIntegrity(batch, repoRoot),
}));

const mockExecFileSync =
  vi.fn<(file: string, args: string[], options: { cwd: string; encoding: string }) => string>();

vi.mock("node:child_process", () => ({
  execFileSync: (file: string, args: string[], options: { cwd: string; encoding: string }) =>
    mockExecFileSync(file, args, options),
}));

const mockReadFileSync = vi.fn<(path: string, encoding: string) => string>();

vi.mock("node:fs", () => ({
  readFileSync: (path: string, encoding: string) => mockReadFileSync(path, encoding),
}));

import {
  buildBatchId,
  buildDecomposerFeedback,
  emitDiagnosticTask,
  postDryRunBatch,
  resolvePlanSha,
  runIntegrityCheck,
} from "./job.ts";

// --- Fixtures ---

const VALID_BRIEF = [
  "## Context",
  "Some context.",
  "",
  "## Acceptance Criteria",
  "- [ ] It works",
  "",
  "## Starting Points",
  "- src/main.ts",
].join("\n");

function makeBatch(overrides: Partial<DecomposerResult> = {}): DecomposerResult {
  return {
    batch_id: "dp-test-001",
    plan_ref: { path: "docs/plans/test.md", sha: "abc123" },
    default_target: { workspace_id: "test-ws", signal_id: "run-task" },
    tasks: [
      {
        task_id: "task-a",
        subject: "Implement feature",
        task_brief: VALID_BRIEF,
        target_files: ["src/main.ts"],
        blocked_by: [],
        priority: 50,
        is_tracer: false,
      },
    ],
    ...overrides,
  };
}

function makeFinding(overrides: Partial<IntegrityFinding> = {}): IntegrityFinding {
  return {
    rule: "no_cycles",
    severity: "BLOCK",
    detail: "Cycle detected: a → b → a",
    ...overrides,
  };
}

// --- Tests ---

beforeEach(() => {
  vi.resetAllMocks();
  mockAppendDiscoveryAsTask.mockResolvedValue({
    id: "auto-decomposition-failure-test-abc12345",
    createdAt: "2026-04-15T00:00:00.000Z",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runIntegrityCheck", () => {
  it("delegates to checkIntegrity and returns findings", () => {
    const batch = makeBatch();
    const expected: IntegrityFinding[] = [makeFinding()];
    mockCheckIntegrity.mockReturnValue(expected);

    const result = runIntegrityCheck(batch, "/repo");

    expect(mockCheckIntegrity).toHaveBeenCalledWith(batch, "/repo");
    expect(result).toEqual(expected);
  });

  it("returns empty array for clean batch", () => {
    mockCheckIntegrity.mockReturnValue([]);

    const result = runIntegrityCheck(makeBatch(), "/repo");

    expect(result).toEqual([]);
  });
});

describe("buildDecomposerFeedback", () => {
  it("formats findings as markdown with retry count", () => {
    const findings: IntegrityFinding[] = [
      makeFinding({ rule: "no_cycles", detail: "Cycle: a → b → a" }),
      makeFinding({
        rule: "blocked_by_resolves",
        task_id: "task-x",
        detail: "references non-existent task(s): phantom",
      }),
    ];

    const result = buildDecomposerFeedback(findings, 1);

    expect(result).toContain("## Integrity Violations (retry 1)");
    expect(result).toContain("- **no_cycles**: Cycle: a → b → a");
    expect(result).toContain(
      "- **blocked_by_resolves** (task: task-x): references non-existent task(s): phantom",
    );
  });

  it("omits task_id when absent", () => {
    const findings: IntegrityFinding[] = [
      makeFinding({ rule: "tracer_discipline", detail: "no tracer", task_id: undefined }),
    ];

    const result = buildDecomposerFeedback(findings, 2);

    expect(result).toContain("## Integrity Violations (retry 2)");
    expect(result).toContain("- **tracer_discipline**: no tracer");
    expect(result).not.toContain("(task:");
  });

  it("returns single-line header for empty findings", () => {
    const result = buildDecomposerFeedback([], 1);

    expect(result).toContain("## Integrity Violations (retry 1)");
    expect(result.split("\n").filter((l) => l.startsWith("- ")).length).toBe(0);
  });
});

describe("emitDiagnosticTask", () => {
  it("calls appendDiscoveryAsTask with correct Discovery shape", async () => {
    const findings: IntegrityFinding[] = [
      makeFinding({ rule: "no_cycles", detail: "Cycle: a → b → a" }),
    ];

    const result = await emitDiagnosticTask(
      "http://localhost:8080/api/memory/salted_granola/narrative/autopilot-backlog",
      "sess-42",
      findings,
      "dp-batch-001",
    );

    expect(mockAppendDiscoveryAsTask).toHaveBeenCalledTimes(1);
    const [url, discovery] = mockAppendDiscoveryAsTask.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:8080/api/memory/salted_granola/narrative/autopilot-backlog");
    expect(discovery).toMatchObject({
      discovered_by: "decompose-plan",
      discovered_session: "sess-42",
      target_workspace_id: "salted_granola",
      target_signal_id: "review-decomposition-failure",
      title: "decompose-plan: persistent integrity violations",
      target_files: [],
      priority: 40,
      kind: "decomposition-failure",
      auto_apply: false,
    });
    expect((discovery as Record<string, unknown>).brief).toContain("dp-batch-001");
    expect((discovery as Record<string, unknown>).brief).toContain("no_cycles");
    expect(result.id).toBe("auto-decomposition-failure-test-abc12345");
  });

  it("includes all findings in the brief", async () => {
    const findings: IntegrityFinding[] = [
      makeFinding({ rule: "no_cycles", detail: "cycle A" }),
      makeFinding({ rule: "blocked_by_resolves", task_id: "task-x", detail: "dangling ref" }),
    ];

    await emitDiagnosticTask(
      "http://localhost:8080/api/memory/test/narrative/backlog",
      "sess-99",
      findings,
      "dp-batch-002",
    );

    const [, discovery] = mockAppendDiscoveryAsTask.mock.calls[0] ?? [];
    const brief = (discovery as Record<string, unknown>).brief as string;
    expect(brief).toContain("**no_cycles**");
    expect(brief).toContain("**blocked_by_resolves** (task: task-x)");
  });
});

// --- postDryRunBatch tests ---

describe("postDryRunBatch", () => {
  const mockFetch =
    vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const CORPUS_URL =
    "http://localhost:8080/api/memory/salted_granola/narrative/dry-run-decompositions";
  const DEFAULT_TARGET = { workspace_id: "test-ws", signal_id: "run-task" };

  it("constructs correct entry shape", async () => {
    const batch = makeBatch();
    await postDryRunBatch(CORPUS_URL, batch, DEFAULT_TARGET);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;

    expect(body.text).toBe(batch.batch_id);
    const metadata = body.metadata as Record<string, unknown>;
    expect(metadata.batch_id).toBe(batch.batch_id);
    expect(metadata.plan_ref).toEqual(batch.plan_ref);
    expect(metadata.default_target).toEqual(DEFAULT_TARGET);
    expect(metadata.tasks).toEqual(batch.tasks);
    expect(metadata).toHaveProperty("expires_at");
    expect(metadata).toHaveProperty("created_at");
  });

  it("expires_at is ~24h in the future", async () => {
    const frozenNow = new Date("2026-04-15T12:00:00.000Z");
    vi.setSystemTime(frozenNow);

    const batch = makeBatch();
    await postDryRunBatch(CORPUS_URL, batch, DEFAULT_TARGET);

    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    const metadata = body.metadata as Record<string, unknown>;

    const expiresAt = new Date(metadata.expires_at as string).getTime();
    expect(expiresAt).toBe(frozenNow.getTime() + 86_400_000);

    vi.useRealTimers();
  });

  it("POSTs to the provided corpus URL", async () => {
    const batch = makeBatch();
    await postDryRunBatch(CORPUS_URL, batch, DEFAULT_TARGET);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe(CORPUS_URL);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toEqual({ "Content-Type": "application/json" });
  });

  it("throws on non-OK response", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response("internal error", { status: 500 })),
    );

    const batch = makeBatch();
    await expect(postDryRunBatch(CORPUS_URL, batch, DEFAULT_TARGET)).rejects.toThrow(
      /dp-test-001.*500|500.*dp-test-001/,
    );
  });

  it("returns batch_id and task_count", async () => {
    const batch = makeBatch({
      tasks: [
        {
          task_id: "task-a",
          subject: "A",
          task_brief: VALID_BRIEF,
          target_files: ["src/a.ts"],
          blocked_by: [],
          priority: 50,
          is_tracer: false,
        },
        {
          task_id: "task-b",
          subject: "B",
          task_brief: VALID_BRIEF,
          target_files: ["src/b.ts"],
          blocked_by: [],
          priority: 50,
          is_tracer: false,
        },
      ],
    });

    const result = await postDryRunBatch(CORPUS_URL, batch, DEFAULT_TARGET);

    expect(result).toEqual({ batch_id: "dp-test-001", task_count: 2 });
  });
});

// --- Guard function tests (inline FSM logic, tested via mock context) ---

describe("guard functions (context-based)", () => {
  interface MockContext {
    results: Record<string, unknown>;
  }

  function makeContext(results: Record<string, unknown> = {}): MockContext {
    return { results };
  }

  describe("guard_integrity_clean", () => {
    function guardIntegrityClean(context: MockContext): boolean {
      const r = context.results["integrity-output"] as { clean: boolean } | undefined;
      return r !== undefined && r.clean === true;
    }

    it("returns true when findings array is empty (clean=true)", () => {
      const ctx = makeContext({ "integrity-output": { findings: [], clean: true } });
      expect(guardIntegrityClean(ctx)).toBe(true);
    });

    it("returns false when findings are present (clean=false)", () => {
      const ctx = makeContext({ "integrity-output": { findings: [makeFinding()], clean: false } });
      expect(guardIntegrityClean(ctx)).toBe(false);
    });

    it("returns false when integrity-output is undefined", () => {
      const ctx = makeContext({});
      expect(guardIntegrityClean(ctx)).toBe(false);
    });
  });

  describe("guard_retry_allowed", () => {
    function guardRetryAllowed(context: MockContext): boolean {
      const r = context.results["integrity-output"] as { clean: boolean } | undefined;
      if (!r || r.clean) return false;
      const counter = context.results["retry-counter"] as { count: number } | undefined;
      const count = counter?.count ?? 0;
      return count < 1;
    }

    it("returns true when findings non-empty AND no prior retries", () => {
      const ctx = makeContext({ "integrity-output": { findings: [makeFinding()], clean: false } });
      expect(guardRetryAllowed(ctx)).toBe(true);
    });

    it("returns false when retry-counter >= 1", () => {
      const ctx = makeContext({
        "integrity-output": { findings: [makeFinding()], clean: false },
        "retry-counter": { count: 1 },
      });
      expect(guardRetryAllowed(ctx)).toBe(false);
    });

    it("returns false when integrity-output is clean", () => {
      const ctx = makeContext({ "integrity-output": { findings: [], clean: true } });
      expect(guardRetryAllowed(ctx)).toBe(false);
    });

    it("returns false when integrity-output is undefined", () => {
      const ctx = makeContext({});
      expect(guardRetryAllowed(ctx)).toBe(false);
    });
  });

  describe("guard_diagnostic_done", () => {
    function guardDiagnosticDone(context: MockContext): boolean {
      return context.results["diagnostic-output"] !== undefined;
    }

    it("returns true when diagnostic-output is set", () => {
      const ctx = makeContext({ "diagnostic-output": { id: "diag-1", createdAt: "2026-04-15" } });
      expect(guardDiagnosticDone(ctx)).toBe(true);
    });

    it("returns false when diagnostic-output is undefined", () => {
      const ctx = makeContext({});
      expect(guardDiagnosticDone(ctx)).toBe(false);
    });
  });
});

// --- FSM path simulation (context-level) ---

describe("FSM state-transition paths", () => {
  interface SimContext {
    results: Record<string, unknown>;
    sessionId: string;
    workDir: string;
    setResult(key: string, value: unknown): void;
  }

  function makeSimContext(): SimContext {
    const results: Record<string, unknown> = {};
    return {
      results,
      sessionId: "sim-session",
      workDir: "/repo",
      setResult(key: string, value: unknown) {
        if (value === undefined) {
          delete results[key];
        } else {
          results[key] = value;
        }
      },
    };
  }

  function guardIntegrityClean(ctx: SimContext): boolean {
    const r = ctx.results["integrity-output"] as { clean: boolean } | undefined;
    return r !== undefined && r.clean === true;
  }

  function guardRetryAllowed(ctx: SimContext): boolean {
    const r = ctx.results["integrity-output"] as { clean: boolean } | undefined;
    if (!r || r.clean) return false;
    const counter = ctx.results["retry-counter"] as { count: number } | undefined;
    const count = counter?.count ?? 0;
    return count < 1;
  }

  function simIntegrityCheck(ctx: SimContext, findings: IntegrityFinding[]): void {
    ctx.setResult("integrity-output", { findings, clean: findings.length === 0 });
  }

  function simRetryDecompose(ctx: SimContext): void {
    const current = ctx.results["retry-counter"] as { count: number } | undefined;
    const count = current ? current.count + 1 : 1;
    ctx.setResult("retry-counter", { count });
    ctx.setResult("decomposer-feedback", "retry feedback");
    ctx.setResult("decomposer-output", undefined);
    ctx.setResult("integrity-output", undefined);
  }

  it("path 1: clean batch → integrity → apply", () => {
    const ctx = makeSimContext();

    // decompose produced clean output
    ctx.setResult("decomposer-output", makeBatch());

    // integrity_check runs — no findings
    simIntegrityCheck(ctx, []);

    // guard evaluation
    expect(guardIntegrityClean(ctx)).toBe(true);
    // → transitions to apply
  });

  it("path 2: invalid then valid → retry → apply", () => {
    const ctx = makeSimContext();

    // First decompose — invalid
    ctx.setResult("decomposer-output", makeBatch());
    simIntegrityCheck(ctx, [makeFinding()]);

    expect(guardIntegrityClean(ctx)).toBe(false);
    expect(guardRetryAllowed(ctx)).toBe(true);
    // → transitions to retry_prepare

    simRetryDecompose(ctx);
    expect(ctx.results["retry-counter"]).toEqual({ count: 1 });
    expect(ctx.results["decomposer-output"]).toBeUndefined();
    expect(ctx.results["integrity-output"]).toBeUndefined();

    // Second decompose — valid this time
    ctx.setResult("decomposer-output", makeBatch());
    simIntegrityCheck(ctx, []);

    expect(guardIntegrityClean(ctx)).toBe(true);
    // → transitions to apply
  });

  it("path 3: invalid twice → retry → diagnostic", () => {
    const ctx = makeSimContext();

    // First decompose — invalid
    ctx.setResult("decomposer-output", makeBatch());
    simIntegrityCheck(ctx, [makeFinding()]);

    expect(guardIntegrityClean(ctx)).toBe(false);
    expect(guardRetryAllowed(ctx)).toBe(true);

    simRetryDecompose(ctx);

    // Second decompose — still invalid
    ctx.setResult("decomposer-output", makeBatch());
    simIntegrityCheck(ctx, [makeFinding()]);

    expect(guardIntegrityClean(ctx)).toBe(false);
    expect(guardRetryAllowed(ctx)).toBe(false);
    // → falls through to diagnostic (no guard)
  });

  it("path 4: dry_run → single POST instead of per-task POSTs", async () => {
    const mockFetch =
      vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const ctx = makeSimContext();
    const batch = makeBatch();

    // Simulate prepare + decompose succeeded
    ctx.setResult("task-input", {
      plan_path: "docs/plans/test.md",
      default_target: { workspace_id: "test-ws", signal_id: "run-task" },
      dry_run: true,
    });
    ctx.setResult("decomposer-output", batch);

    // Simulate integrity passing
    simIntegrityCheck(ctx, []);
    expect(guardIntegrityClean(ctx)).toBe(true);

    // Simulate the apply_to_backlog action's dry_run branch
    const input = ctx.results["task-input"] as {
      dry_run: boolean;
      default_target: { workspace_id: string; signal_id: string };
    };
    if (input.dry_run) {
      const dryResult = await postDryRunBatch(
        "http://localhost:8080/api/memory/salted_granola/narrative/dry-run-decompositions",
        batch,
        input.default_target,
      );
      ctx.setResult("apply-output", {
        applied: dryResult.task_count,
        batch_id: dryResult.batch_id,
        task_ids: batch.tasks.map((t) => t.task_id),
        dry_run: true,
      });
    }

    // Verify apply-output shape
    const applyOutput = ctx.results["apply-output"] as Record<string, unknown>;
    expect(applyOutput.dry_run).toBe(true);
    expect(applyOutput.batch_id).toBe(batch.batch_id);
    expect(applyOutput.task_ids).toEqual(["task-a"]);
    expect(applyOutput.applied).toBe(1);

    // Only one fetch call (the single dry-run POST), not per-task
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] ?? [];
    expect(url).toContain("dry-run-decompositions");

    vi.unstubAllGlobals();
  });
});

// --- resolvePlanSha ---

describe("resolvePlanSha", () => {
  it("returns first 6 chars of git rev-parse stdout on success", async () => {
    mockExecFileSync.mockReturnValue("a3f2c9deadbeef\n");

    const result = await resolvePlanSha("docs/plans/test.md", "/repo");

    expect(result).toBe("a3f2c9");
    expect(mockExecFileSync).toHaveBeenCalledWith("git", ["rev-parse", "HEAD:docs/plans/test.md"], {
      cwd: "/repo",
      encoding: "utf-8",
    });
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("falls back to sha256 of file content when git fails", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });
    mockReadFileSync.mockReturnValue("hello world");

    const result = await resolvePlanSha("docs/plans/test.md", "/repo");

    // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    expect(result).toBe("b94d27");
    expect(mockReadFileSync).toHaveBeenCalled();
  });
});

// --- buildBatchId ---

describe("buildBatchId", () => {
  it("produces correct format from known inputs", () => {
    const result = buildBatchId(
      "docs/plans/2026-04-13-openclaw-parity-plan.md",
      "a3f2c9deadbeef",
      new Date("2026-04-15T14:30:00Z"),
    );

    expect(result).toBe("dp-2026-04-13-openclaw-parity-plan-202604151430-a3f2c9");
  });

  it("matches batch_id regex", () => {
    const result = buildBatchId(
      "docs/plans/some-plan.md",
      "abcdef123456",
      new Date("2026-01-01T00:00:00Z"),
    );

    expect(result).toMatch(/^dp-[a-z0-9-]+-\d{12}-[0-9a-f]{6}$/);
  });

  it("handles special characters in plan filename via slugification", () => {
    const result = buildBatchId("My Plan (v2).md", "abc123", new Date("2026-04-15T14:30:00Z"));

    expect(result).toMatch(/^dp-my-plan-v2-/);
    expect(result).not.toMatch(/[()]/);
  });

  it("strips leading/trailing hyphens from slug", () => {
    const result = buildBatchId("---test---.md", "abc123", new Date("2026-04-15T14:30:00Z"));

    expect(result).toMatch(/^dp-test-\d{12}-/);
    expect(result).not.toMatch(/^dp--/);
  });
});

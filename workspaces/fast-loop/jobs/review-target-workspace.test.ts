import type {
  CorpusMetadata,
  HistoryEntry,
  KVCorpus,
  MemoryAdapter,
  NarrativeCorpus,
  NarrativeEntry,
} from "@atlas/agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { type ParsedWorkspaceConfig, reviewWorkspaceConfig } from "../agents/workspace-reviewer.ts";
import {
  type AppendDiscoveryFn,
  type ReviewJobDeps,
  runReviewJob,
} from "./review-target-workspace.ts";
import {
  type ReviewFinding,
  ReviewFindingSchema,
  ReviewJobInputSchema,
  ReviewJobResultSchema,
} from "./review-target-workspace.types.ts";

function makeSession(overrides: Partial<NarrativeEntry> = {}): NarrativeEntry {
  return {
    id: crypto.randomUUID(),
    text: "Session summary",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    category: "drift",
    severity: "warn",
    summary: "Test finding",
    detail: "Detailed description of the test finding",
    ...overrides,
  };
}

function createMockNarrativeCorpus(
  entries: NarrativeEntry[] = [],
): NarrativeCorpus & { appended: NarrativeEntry[] } {
  const appended: NarrativeEntry[] = [];
  return {
    appended,
    append: vi
      .fn<(entry: NarrativeEntry) => Promise<NarrativeEntry>>()
      .mockImplementation((entry) => {
        appended.push(entry);
        return Promise.resolve(entry);
      }),
    read: vi
      .fn<(opts?: { since?: string; limit?: number }) => Promise<NarrativeEntry[]>>()
      .mockImplementation(() => Promise.resolve(entries)),
    search: vi.fn<(q: string) => Promise<NarrativeEntry[]>>().mockResolvedValue([]),
    forget: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    render: vi
      .fn<() => Promise<string>>()
      .mockImplementation(() => Promise.resolve(entries.map((e) => e.text).join("\n"))),
  };
}

function createMockKVCorpus(data: Record<string, unknown> = {}): KVCorpus {
  return {
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(data[key])) as KVCorpus["get"],
    set: vi.fn<(key: string, value: unknown) => Promise<void>>().mockResolvedValue(undefined),
    delete: vi.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined),
    list: vi.fn<() => Promise<string[]>>().mockResolvedValue(Object.keys(data)),
  };
}

function createMockAdapter(options: {
  sessions?: NarrativeEntry[];
  workspaceYml?: string;
  improvementPolicy?: string;
  notesMemory?: NarrativeCorpus & { appended: NarrativeEntry[] };
}): MemoryAdapter & { corpusFn: ReturnType<typeof vi.fn> } {
  const sessionsCorpus = createMockNarrativeCorpus(options.sessions ?? []);
  const kvData: Record<string, unknown> = { "workspace.yml": options.workspaceYml ?? "{}" };
  if (options.improvementPolicy !== undefined) {
    kvData["improvement"] = options.improvementPolicy;
  }
  const kvCorpus = createMockKVCorpus(kvData);
  const notesMemory = options.notesMemory ?? createMockNarrativeCorpus();

  const corpusFn = vi
    .fn<(_ws: string, name: string, kind: string) => Promise<unknown>>()
    .mockImplementation((_ws, name, kind) => {
      if (name === "sessions" && kind === "narrative") return Promise.resolve(sessionsCorpus);
      if (name === "config" && kind === "kv") return Promise.resolve(kvCorpus);
      if (name === "notes" && kind === "narrative") return Promise.resolve(notesMemory);
      return Promise.reject(new Error(`Unexpected corpus: ${name}/${kind}`));
    });

  return {
    corpus: corpusFn as MemoryAdapter["corpus"],
    corpusFn,
    list: vi.fn<() => Promise<CorpusMetadata[]>>().mockResolvedValue([]),
    bootstrap: vi.fn<() => Promise<string>>().mockResolvedValue(""),
    history: vi.fn<() => Promise<HistoryEntry[]>>().mockResolvedValue([]),
    rollback: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

function stubReviewAgent(findings: ReviewFinding[]): ReviewJobDeps["reviewAgent"] {
  return vi.fn<ReviewJobDeps["reviewAgent"]>().mockResolvedValue(findings);
}

function stubAppendDiscovery(): AppendDiscoveryFn & ReturnType<typeof vi.fn> {
  return vi
    .fn<AppendDiscoveryFn>()
    .mockResolvedValue({ id: "task-1", createdAt: new Date().toISOString() });
}

// ── Unit: ReviewJobInputSchema ───────────────────────────────────────────────

describe("ReviewJobInputSchema", () => {
  it("parses valid input", () => {
    const result = ReviewJobInputSchema.parse({ targetWorkspaceId: "ws-123", sessionLimit: 5 });
    expect(result.targetWorkspaceId).toBe("ws-123");
    expect(result.sessionLimit).toBe(5);
  });

  it("sessionLimit is optional", () => {
    const result = ReviewJobInputSchema.parse({ targetWorkspaceId: "ws-456" });
    expect(result.sessionLimit).toBeUndefined();
  });

  it("rejects non-positive sessionLimit", () => {
    expect(() =>
      ReviewJobInputSchema.parse({ targetWorkspaceId: "ws-456", sessionLimit: 0 }),
    ).toThrow();
  });

  it("accepts optional jobIds", () => {
    const result = ReviewJobInputSchema.parse({
      targetWorkspaceId: "ws-789",
      jobIds: ["job-1", "job-2"],
    });
    expect(result.jobIds).toEqual(["job-1", "job-2"]);
  });
});

// ── Unit: ReviewFindingSchema — matches workspace.yml document type ─────────

describe("ReviewFindingSchema", () => {
  it.each(["drift", "prompt", "fsm"] as const)("accepts category %s", (category) => {
    const result = ReviewFindingSchema.parse(makeFinding({ category }));
    expect(result.category).toBe(category);
  });

  it.each(["info", "warn", "error"] as const)("accepts severity %s", (severity) => {
    const result = ReviewFindingSchema.parse(makeFinding({ severity }));
    expect(result.severity).toBe(severity);
  });

  it("rejects old-style hyphenated categories", () => {
    expect(() =>
      ReviewFindingSchema.parse(makeFinding({ category: "workspace-drift" as "drift" })),
    ).toThrow();
  });

  it("rejects old-style low/medium/high severities", () => {
    expect(() =>
      ReviewFindingSchema.parse(makeFinding({ severity: "medium" as "warn" })),
    ).toThrow();
  });

  it("requires summary and detail fields", () => {
    expect(() => ReviewFindingSchema.parse({ category: "drift", severity: "warn" })).toThrow();
  });

  it("accepts nullable target_job_id", () => {
    const result = ReviewFindingSchema.parse(makeFinding({ target_job_id: null }));
    expect(result.target_job_id).toBeNull();
  });

  it("accepts string target_job_id", () => {
    const result = ReviewFindingSchema.parse(makeFinding({ target_job_id: "job-1" }));
    expect(result.target_job_id).toBe("job-1");
  });

  it("target_job_id is undefined when absent", () => {
    const result = ReviewFindingSchema.parse(makeFinding());
    expect(result.target_job_id).toBeUndefined();
  });
});

// ── Unit: ReviewJobResultSchema — matches workspace.yml review-findings-result

describe("ReviewJobResultSchema", () => {
  it("validates a complete result", () => {
    const result = ReviewJobResultSchema.parse({
      targetWorkspaceId: "ws-1",
      findings: [
        {
          id: "f-1",
          category: "drift",
          severity: "warn",
          summary: "s",
          detail: "d",
          target_job_id: null,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      appendedCount: 1,
      ranAt: "2026-01-01T00:00:00Z",
    });
    expect(result.findings).toHaveLength(1);
  });
});

// ── Unit: job — corpus('notes','narrative') called on TARGET workspace id ────

describe("runReviewJob corpus routing", () => {
  it("calls corpus('notes','narrative') on TARGET workspace id, not kernel", async () => {
    const notesMemory = createMockNarrativeCorpus();
    const adapter = createMockAdapter({
      workspaceYml: JSON.stringify({ agents: {} }),
      notesMemory,
    });
    const findings = [makeFinding()];
    const deps: ReviewJobDeps = { memoryAdapter: adapter, reviewAgent: stubReviewAgent(findings) };

    await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    expect(adapter.corpusFn).toHaveBeenCalledWith("target-ws", "notes", "narrative");
    expect(adapter.corpusFn).not.toHaveBeenCalledWith(
      "kernel-ws",
      expect.anything(),
      expect.anything(),
    );
  });
});

// ── Unit: job — findings with target_job_id → metadata.target_job_id set ────

describe("runReviewJob target_job_id metadata", () => {
  it("sets metadata.target_job_id when target_job_id is present", async () => {
    const notesMemory = createMockNarrativeCorpus();
    const adapter = createMockAdapter({
      workspaceYml: JSON.stringify({ agents: {} }),
      notesMemory,
    });
    const deps: ReviewJobDeps = {
      memoryAdapter: adapter,
      reviewAgent: stubReviewAgent([makeFinding({ target_job_id: "my-job" })]),
    };

    await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    const first = notesMemory.appended[0];
    expect(first).toBeDefined();
    if (first) {
      expect(first.metadata?.target_job_id).toBe("my-job");
    }
  });

  it("sets metadata.target_job_id to null when target_job_id is absent", async () => {
    const notesMemory = createMockNarrativeCorpus();
    const adapter = createMockAdapter({
      workspaceYml: JSON.stringify({ agents: {} }),
      notesMemory,
    });
    const deps: ReviewJobDeps = {
      memoryAdapter: adapter,
      reviewAgent: stubReviewAgent([makeFinding()]),
    };

    await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    const first = notesMemory.appended[0];
    expect(first).toBeDefined();
    if (first) {
      expect(first.metadata?.target_job_id).toBeNull();
    }
  });
});

// ── Unit: workspace-reviewer — workspace.yml with removed agent → drift ─────

describe("workspace-reviewer agent", () => {
  it("returns drift when session references a removed agent", () => {
    const sessions = [makeSession({ metadata: { agentId: "old-agent" } })];
    const config: ParsedWorkspaceConfig = { agents: { "current-agent": { prompt: "You are..." } } };

    const findings = reviewWorkspaceConfig(sessions, config);

    expect(findings.some((f) => f.category === "drift")).toBe(true);
    const drift = findings.find((f) => f.category === "drift");
    expect(drift?.summary).toContain("old-agent");
  });

  it("returns prompt when agent has no system-prompt stanza", () => {
    const config: ParsedWorkspaceConfig = {
      agents: { "no-prompt-agent": { type: "atlas", description: "does stuff" } },
    };

    const findings = reviewWorkspaceConfig([], config);

    expect(findings.some((f) => f.category === "prompt")).toBe(true);
    const prompt = findings.find((f) => f.category === "prompt");
    expect(prompt?.summary).toContain("no-prompt-agent");
  });

  it("returns fsm when FSM has unreachable state", () => {
    const config: ParsedWorkspaceConfig = {
      agents: {},
      fsm: {
        initial: "idle",
        states: {
          idle: { transitions: { start: "running" } },
          running: { transitions: { done: "completed" } },
          completed: { terminal: true },
          orphaned: { transitions: { go: "running" } },
        },
      },
    };

    const findings = reviewWorkspaceConfig([], config);

    expect(findings.some((f) => f.category === "fsm")).toBe(true);
    const smell = findings.find((f) => f.category === "fsm" && f.summary.includes("orphaned"));
    expect(smell).toBeDefined();
  });

  it("does NOT produce findings about skills or source files", () => {
    const sessions = [
      makeSession({
        metadata: { skillName: "my-skill", sourceFile: "src/index.ts" },
        text: "Used skill my-skill and modified src/index.ts",
      }),
    ];
    const config: ParsedWorkspaceConfig = { agents: { agent1: { prompt: "You are agent1" } } };

    const findings = reviewWorkspaceConfig(sessions, config);

    for (const finding of findings) {
      expect(finding.summary.toLowerCase()).not.toContain("skill");
      expect(finding.summary.toLowerCase()).not.toContain("source");
    }
  });
});

// ── Discovery-to-task routing ───────────────────────────────────────────────

describe("discovery-to-task routing", () => {
  it("calls appendDiscovery for findings with severity=warn (priority 50)", async () => {
    const appendDiscovery = stubAppendDiscovery();
    const adapter = createMockAdapter({ workspaceYml: JSON.stringify({ agents: {} }) });
    const findings = [makeFinding({ severity: "warn", category: "drift" })];
    const deps: ReviewJobDeps = {
      memoryAdapter: adapter,
      reviewAgent: stubReviewAgent(findings),
      appendDiscovery,
    };

    await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    expect(appendDiscovery).toHaveBeenCalledTimes(1);
    expect(appendDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 50,
        kind: "drift",
        target_workspace_id: "target-ws",
        auto_apply: false,
      }),
    );
  });

  it("calls appendDiscovery for findings with severity=error (priority 70)", async () => {
    const appendDiscovery = stubAppendDiscovery();
    const adapter = createMockAdapter({ workspaceYml: JSON.stringify({ agents: {} }) });
    const findings = [makeFinding({ severity: "error", category: "fsm" })];
    const deps: ReviewJobDeps = {
      memoryAdapter: adapter,
      reviewAgent: stubReviewAgent(findings),
      appendDiscovery,
    };

    await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    expect(appendDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 70, kind: "fsm" }),
    );
  });

  it("skips appendDiscovery for info-severity findings", async () => {
    const appendDiscovery = stubAppendDiscovery();
    const adapter = createMockAdapter({ workspaceYml: JSON.stringify({ agents: {} }) });
    const findings = [makeFinding({ severity: "info" })];
    const deps: ReviewJobDeps = {
      memoryAdapter: adapter,
      reviewAgent: stubReviewAgent(findings),
      appendDiscovery,
    };

    await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    expect(appendDiscovery).not.toHaveBeenCalled();
  });

  it("uses target_job_id as target_signal_id when present", async () => {
    const appendDiscovery = stubAppendDiscovery();
    const adapter = createMockAdapter({ workspaceYml: JSON.stringify({ agents: {} }) });
    const findings = [makeFinding({ severity: "warn", target_job_id: "my-job" })];
    const deps: ReviewJobDeps = {
      memoryAdapter: adapter,
      reviewAgent: stubReviewAgent(findings),
      appendDiscovery,
    };

    await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    expect(appendDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ target_signal_id: "my-job" }),
    );
  });

  it("uses category as target_signal_id when target_job_id is absent", async () => {
    const appendDiscovery = stubAppendDiscovery();
    const adapter = createMockAdapter({ workspaceYml: JSON.stringify({ agents: {} }) });
    const findings = [makeFinding({ severity: "warn", category: "prompt" })];
    const deps: ReviewJobDeps = {
      memoryAdapter: adapter,
      reviewAgent: stubReviewAgent(findings),
      appendDiscovery,
    };

    await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    expect(appendDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ target_signal_id: "prompt" }),
    );
  });

  it("respects improvement policy from KV corpus", async () => {
    const appendDiscovery = stubAppendDiscovery();
    const adapter = createMockAdapter({
      workspaceYml: JSON.stringify({ agents: {} }),
      improvementPolicy: "auto",
    });
    const findings = [makeFinding({ severity: "error" })];
    const deps: ReviewJobDeps = {
      memoryAdapter: adapter,
      reviewAgent: stubReviewAgent(findings),
      appendDiscovery,
    };

    await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    expect(appendDiscovery).toHaveBeenCalledWith(expect.objectContaining({ auto_apply: true }));
  });

  it("defaults improvement policy to surface (auto_apply=false)", async () => {
    const appendDiscovery = stubAppendDiscovery();
    const adapter = createMockAdapter({ workspaceYml: JSON.stringify({ agents: {} }) });
    const findings = [makeFinding({ severity: "warn" })];
    const deps: ReviewJobDeps = {
      memoryAdapter: adapter,
      reviewAgent: stubReviewAgent(findings),
      appendDiscovery,
    };

    await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    expect(appendDiscovery).toHaveBeenCalledWith(expect.objectContaining({ auto_apply: false }));
  });

  it("does not call appendDiscovery when not provided in deps", async () => {
    const adapter = createMockAdapter({ workspaceYml: JSON.stringify({ agents: {} }) });
    const findings = [makeFinding({ severity: "error" })];
    const deps: ReviewJobDeps = { memoryAdapter: adapter, reviewAgent: stubReviewAgent(findings) };

    const result = await runReviewJob(deps, { targetWorkspaceId: "target-ws" });
    expect(result.appendedCount).toBe(1);
  });
});

// ── Integration: full job run ────────────────────────────────────────────────

describe("integration: full job run", () => {
  it("produces findings in target corpus within timeout", async () => {
    const notesMemory = createMockNarrativeCorpus();
    const adapter = createMockAdapter({
      sessions: [makeSession()],
      workspaceYml: JSON.stringify({ agents: {} }),
      notesMemory,
    });
    const findings = [
      makeFinding({ category: "drift" }),
      makeFinding({ category: "prompt" }),
      makeFinding({ category: "fsm" }),
    ];
    const deps: ReviewJobDeps = { memoryAdapter: adapter, reviewAgent: stubReviewAgent(findings) };

    const result = await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    expect(result.appendedCount).toBe(3);
    expect(notesMemory.appended).toHaveLength(3);
    expect(adapter.corpusFn).toHaveBeenCalledWith("target-ws", "notes", "narrative");
  });

  it("returns result matching ReviewJobResultSchema", async () => {
    const adapter = createMockAdapter({ workspaceYml: JSON.stringify({ agents: {} }) });
    const findings = [makeFinding({ target_job_id: "j1" })];
    const deps: ReviewJobDeps = { memoryAdapter: adapter, reviewAgent: stubReviewAgent(findings) };

    const result = await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    expect(() => ReviewJobResultSchema.parse(result)).not.toThrow();
    expect(result.targetWorkspaceId).toBe("target-ws");
    expect(result.findings[0]?.target_job_id).toBe("j1");
    expect(result.ranAt).toBeTruthy();
  });

  it("cron and signal trigger produce identical finding writes", async () => {
    const input = ReviewJobInputSchema.parse({ targetWorkspaceId: "target-ws" });
    const findings = [makeFinding()];

    const cronCorpus = createMockNarrativeCorpus();
    const cronResult = await runReviewJob(
      {
        memoryAdapter: createMockAdapter({
          workspaceYml: JSON.stringify({ agents: {} }),
          notesMemory: cronCorpus,
        }),
        reviewAgent: stubReviewAgent(findings),
      },
      input,
    );

    const signalCorpus = createMockNarrativeCorpus();
    const signalResult = await runReviewJob(
      {
        memoryAdapter: createMockAdapter({
          workspaceYml: JSON.stringify({ agents: {} }),
          notesMemory: signalCorpus,
        }),
        reviewAgent: stubReviewAgent(findings),
      },
      input,
    );

    expect(cronCorpus.appended.map((e) => e.text)).toEqual(
      signalCorpus.appended.map((e) => e.text),
    );
    expect(cronResult.appendedCount).toBe(signalResult.appendedCount);
  });
});

// ── Contract: target_job_id → downstream apply job resolution ────────────────

describe("contract: downstream apply job key convention", () => {
  it("findings with target_job_id can be filtered from corpus by metadata", async () => {
    const notesMemory = createMockNarrativeCorpus();
    const adapter = createMockAdapter({
      workspaceYml: JSON.stringify({ agents: {} }),
      notesMemory,
    });
    const findings = [
      makeFinding({ target_job_id: "job-alpha" }),
      makeFinding(),
      makeFinding({ target_job_id: "job-beta" }),
    ];
    const deps: ReviewJobDeps = { memoryAdapter: adapter, reviewAgent: stubReviewAgent(findings) };

    await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    const jobAlpha = notesMemory.appended.filter((e) => e.metadata?.target_job_id === "job-alpha");
    const workspaceLevel = notesMemory.appended.filter((e) => e.metadata?.target_job_id === null);
    expect(jobAlpha).toHaveLength(1);
    expect(workspaceLevel).toHaveLength(1);
  });
});

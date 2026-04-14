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
import { type ReviewJobDeps, runReviewJob } from "./review-target-workspace.ts";
import {
  type ReviewFinding,
  ReviewFindingSchema,
  ReviewJobInputSchema,
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
  return { text: "Test finding", category: "workspace-drift", severity: "warn", ...overrides };
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
  notesCorpus?: NarrativeCorpus & { appended: NarrativeEntry[] };
}): MemoryAdapter & { corpusFn: ReturnType<typeof vi.fn> } {
  const sessionsCorpus = createMockNarrativeCorpus(options.sessions ?? []);
  const kvCorpus = createMockKVCorpus({ "workspace.yml": options.workspaceYml ?? "{}" });
  const notesCorpus = options.notesCorpus ?? createMockNarrativeCorpus();

  const corpusFn = vi
    .fn<(_ws: string, name: string, kind: string) => Promise<unknown>>()
    .mockImplementation((_ws, name, kind) => {
      if (name === "sessions" && kind === "narrative") return Promise.resolve(sessionsCorpus);
      if (name === "config" && kind === "kv") return Promise.resolve(kvCorpus);
      if (name === "notes" && kind === "narrative") return Promise.resolve(notesCorpus);
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
});

// ── Unit: ReviewFindingSchema ────────────────────────────────────────────────

describe("ReviewFindingSchema", () => {
  it.each([
    "workspace-drift",
    "agent-prompt",
    "fsm-smell",
  ] as const)("accepts category %s", (category) => {
    const result = ReviewFindingSchema.parse(makeFinding({ category }));
    expect(result.category).toBe(category);
  });

  it.each(["info", "warn", "error"] as const)("accepts severity %s", (severity) => {
    const result = ReviewFindingSchema.parse(makeFinding({ severity }));
    expect(result.severity).toBe(severity);
  });

  it("accepts optional targetJobId", () => {
    const result = ReviewFindingSchema.parse(makeFinding({ targetJobId: "job-1" }));
    expect(result.targetJobId).toBe("job-1");
  });

  it("targetJobId is undefined when absent", () => {
    const result = ReviewFindingSchema.parse(makeFinding());
    expect(result.targetJobId).toBeUndefined();
  });
});

// ── Unit: job — corpus('notes','narrative') called on TARGET workspace id ────

describe("runReviewJob corpus routing", () => {
  it("calls corpus('notes','narrative') on TARGET workspace id, not kernel", async () => {
    const notesCorpus = createMockNarrativeCorpus();
    const adapter = createMockAdapter({
      workspaceYml: JSON.stringify({ agents: {} }),
      notesCorpus,
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

// ── Unit: job — findings with targetJobId → metadata.target_job_id set ──────

describe("runReviewJob target_job_id metadata", () => {
  it("sets metadata.target_job_id when targetJobId is present", async () => {
    const notesCorpus = createMockNarrativeCorpus();
    const adapter = createMockAdapter({
      workspaceYml: JSON.stringify({ agents: {} }),
      notesCorpus,
    });
    const deps: ReviewJobDeps = {
      memoryAdapter: adapter,
      reviewAgent: stubReviewAgent([makeFinding({ targetJobId: "my-job" })]),
    };

    await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    const first = notesCorpus.appended[0];
    expect(first).toBeDefined();
    if (first) {
      expect(first.metadata?.target_job_id).toBe("my-job");
    }
  });

  it("sets metadata.target_job_id to null when targetJobId is absent", async () => {
    const notesCorpus = createMockNarrativeCorpus();
    const adapter = createMockAdapter({
      workspaceYml: JSON.stringify({ agents: {} }),
      notesCorpus,
    });
    const deps: ReviewJobDeps = {
      memoryAdapter: adapter,
      reviewAgent: stubReviewAgent([makeFinding()]),
    };

    await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    const first = notesCorpus.appended[0];
    expect(first).toBeDefined();
    if (first) {
      expect(first.metadata?.target_job_id).toBeNull();
    }
  });
});

// ── Unit: workspace-reviewer — workspace.yml with removed agent → drift ─────

describe("workspace-reviewer agent", () => {
  it("returns workspace-drift when session references a removed agent", () => {
    const sessions = [makeSession({ metadata: { agentId: "old-agent" } })];
    const config: ParsedWorkspaceConfig = { agents: { "current-agent": { prompt: "You are..." } } };

    const findings = reviewWorkspaceConfig(sessions, config);

    expect(findings.some((f) => f.category === "workspace-drift")).toBe(true);
    const drift = findings.find((f) => f.category === "workspace-drift");
    expect(drift?.text).toContain("old-agent");
  });

  it("returns agent-prompt when agent has no system-prompt stanza", () => {
    const config: ParsedWorkspaceConfig = {
      agents: { "no-prompt-agent": { type: "atlas", description: "does stuff" } },
    };

    const findings = reviewWorkspaceConfig([], config);

    expect(findings.some((f) => f.category === "agent-prompt")).toBe(true);
    const prompt = findings.find((f) => f.category === "agent-prompt");
    expect(prompt?.text).toContain("no-prompt-agent");
  });

  it("returns fsm-smell when FSM has unreachable state", () => {
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

    expect(findings.some((f) => f.category === "fsm-smell")).toBe(true);
    const smell = findings.find((f) => f.category === "fsm-smell" && f.text.includes("orphaned"));
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
      expect(finding.text.toLowerCase()).not.toContain("skill");
      expect(finding.text.toLowerCase()).not.toContain("source");
    }
  });
});

// ── Integration: full job run ────────────────────────────────────────────────

describe("integration: full job run", () => {
  it("produces findings in target corpus within timeout", async () => {
    const notesCorpus = createMockNarrativeCorpus();
    const adapter = createMockAdapter({
      sessions: [makeSession()],
      workspaceYml: JSON.stringify({ agents: {} }),
      notesCorpus,
    });
    const findings = [
      makeFinding({ category: "workspace-drift" }),
      makeFinding({ category: "agent-prompt" }),
      makeFinding({ category: "fsm-smell" }),
    ];
    const deps: ReviewJobDeps = { memoryAdapter: adapter, reviewAgent: stubReviewAgent(findings) };

    const result = await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    expect(result.appendedCount).toBe(3);
    expect(notesCorpus.appended).toHaveLength(3);
    expect(adapter.corpusFn).toHaveBeenCalledWith("target-ws", "notes", "narrative");
  });

  it("cron and signal trigger produce identical finding writes", async () => {
    const input = ReviewJobInputSchema.parse({ targetWorkspaceId: "target-ws" });
    const findings = [makeFinding()];

    const cronCorpus = createMockNarrativeCorpus();
    const cronResult = await runReviewJob(
      {
        memoryAdapter: createMockAdapter({
          workspaceYml: JSON.stringify({ agents: {} }),
          notesCorpus: cronCorpus,
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
          notesCorpus: signalCorpus,
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

// ── Contract: targetJobId → downstream apply job resolution ──────────────────

describe("contract: downstream apply job key convention", () => {
  it("findings with targetJobId can be filtered from corpus by metadata", async () => {
    const notesCorpus = createMockNarrativeCorpus();
    const adapter = createMockAdapter({
      workspaceYml: JSON.stringify({ agents: {} }),
      notesCorpus,
    });
    const findings = [
      makeFinding({ targetJobId: "job-alpha" }),
      makeFinding(),
      makeFinding({ targetJobId: "job-beta" }),
    ];
    const deps: ReviewJobDeps = { memoryAdapter: adapter, reviewAgent: stubReviewAgent(findings) };

    await runReviewJob(deps, { targetWorkspaceId: "target-ws" });

    const jobAlpha = notesCorpus.appended.filter((e) => e.metadata?.target_job_id === "job-alpha");
    const workspaceLevel = notesCorpus.appended.filter((e) => e.metadata?.target_job_id === null);
    expect(jobAlpha).toHaveLength(1);
    expect(workspaceLevel).toHaveLength(1);
  });
});

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aroundEach, describe, expect, test } from "vitest";
import { LocalSessionHistoryAdapter } from "./local-session-history-adapter.ts";
import type {
  SessionStartEvent,
  SessionStreamEvent,
  SessionSummary,
  StepCompleteEvent,
  StepStartEvent,
} from "./session-events.ts";
import { SessionStreamEventSchema, SessionSummarySchema } from "./session-events.ts";
import type { SessionHistoryAdapter } from "./session-history-adapter.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-02-13T10:00:00.000Z";

function sessionStart(sessionId = "sess-1"): SessionStartEvent {
  return {
    type: "session:start",
    sessionId,
    workspaceId: "ws-1",
    jobName: "my-job",
    task: "do the thing",
    timestamp: NOW,
  };
}

function stepStart(stepNumber = 1): StepStartEvent {
  return {
    type: "step:start",
    sessionId: "sess-1",
    stepNumber,
    agentName: "researcher",
    actionType: "agent",
    task: "research the thing",
    timestamp: NOW,
  };
}

function stepComplete(stepNumber = 1): StepCompleteEvent {
  return {
    type: "step:complete",
    sessionId: "sess-1",
    stepNumber,
    status: "completed",
    durationMs: 1234,
    toolCalls: [{ toolName: "search", args: { q: "test" } }],
    output: { answer: 42 },
    timestamp: NOW,
  };
}

function sessionComplete(): SessionStreamEvent {
  return {
    type: "session:complete",
    sessionId: "sess-1",
    status: "completed",
    durationMs: 5000,
    timestamp: NOW,
  };
}

function sessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "sess-1",
    workspaceId: "ws-1",
    jobName: "my-job",
    task: "do the thing",
    status: "completed",
    startedAt: NOW,
    completedAt: NOW,
    durationMs: 5000,
    stepCount: 1,
    agentNames: ["researcher"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let adapter: SessionHistoryAdapter;

aroundEach(async (run) => {
  testDir = join(tmpdir(), `atlas-test-${crypto.randomUUID()}`);
  await mkdir(testDir, { recursive: true });
  adapter = new LocalSessionHistoryAdapter(testDir);
  await run();
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// appendEvent
// ---------------------------------------------------------------------------

describe("appendEvent", () => {
  test("creates session directory and appends JSONL line", async () => {
    await adapter.appendEvent("sess-1", sessionStart());

    const eventsPath = join(testDir, "sess-1", "events.jsonl");
    const content = await readFile(eventsPath, "utf-8");
    const parsed = SessionStreamEventSchema.parse(JSON.parse(content.trim()));
    expect(parsed.type).toBe("session:start");
  });

  test("appends multiple events as separate JSONL lines", async () => {
    await adapter.appendEvent("sess-1", sessionStart());
    await adapter.appendEvent("sess-1", stepStart());
    await adapter.appendEvent("sess-1", stepComplete());

    const eventsPath = join(testDir, "sess-1", "events.jsonl");
    const content = await readFile(eventsPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
    const events = lines.map((line) => SessionStreamEventSchema.parse(JSON.parse(line)));
    expect(events[0]?.type).toBe("session:start");
    expect(events[1]?.type).toBe("step:start");
    expect(events[2]?.type).toBe("step:complete");
  });
});

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

describe("save", () => {
  test("writes metadata.json with session summary", async () => {
    const events = [sessionStart(), stepStart(), stepComplete(), sessionComplete()];
    const summary = sessionSummary();

    await adapter.save("sess-1", events, summary);

    const metadataPath = join(testDir, "sess-1", "metadata.json");
    const content = await readFile(metadataPath, "utf-8");
    const parsed = SessionSummarySchema.parse(JSON.parse(content));
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.status).toBe("completed");
    expect(parsed.stepCount).toBe(1);
  });

  test("writes events to events.jsonl", async () => {
    const events: SessionStreamEvent[] = [
      sessionStart(),
      stepStart(),
      stepComplete(),
      sessionComplete(),
    ];
    await adapter.save("sess-1", events, sessionSummary());

    const eventsPath = join(testDir, "sess-1", "events.jsonl");
    const content = await readFile(eventsPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("get", () => {
  test("returns null for non-existent session", async () => {
    const result = await adapter.get("nonexistent");
    expect(result).toBeNull();
  });

  test("round-trip: appendEvent then get returns correct SessionView", async () => {
    await adapter.appendEvent("sess-1", sessionStart());
    await adapter.appendEvent("sess-1", stepStart());
    await adapter.appendEvent("sess-1", stepComplete());
    await adapter.appendEvent("sess-1", sessionComplete());

    const view = await adapter.get("sess-1");
    assert(view, "expected view to exist");
    expect(view.sessionId).toBe("sess-1");
    expect(view.workspaceId).toBe("ws-1");
    expect(view.status).toBe("completed");
    expect(view.agentBlocks).toHaveLength(1);
    const block = view.agentBlocks[0];
    assert(block, "expected agent block to exist");
    expect(block.agentName).toBe("researcher");
    expect(block.toolCalls).toHaveLength(1);
  });

  test("skips corrupted JSONL lines without crashing", async () => {
    const sessionDir = join(testDir, "sess-corrupt");
    await mkdir(sessionDir, { recursive: true });
    const eventsPath = join(sessionDir, "events.jsonl");

    const lines = [
      JSON.stringify(sessionStart("sess-corrupt")),
      "this is not valid json",
      JSON.stringify(stepStart()),
    ].join("\n");
    await writeFile(eventsPath, lines, "utf-8");

    const view = await adapter.get("sess-corrupt");
    assert(view, "expected view to exist");
    // session:start + step:start parsed, corrupted line skipped
    expect(view.sessionId).toBe("sess-corrupt");
    expect(view.agentBlocks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// listByWorkspace
// ---------------------------------------------------------------------------

describe("listByWorkspace", () => {
  test("returns empty array when no sessions exist", async () => {
    const result = await adapter.listByWorkspace("ws-1");
    expect(result).toHaveLength(0);
  });

  test("round-trip: save then listByWorkspace returns summary", async () => {
    const events: SessionStreamEvent[] = [
      sessionStart(),
      stepStart(),
      stepComplete(),
      sessionComplete(),
    ];
    await adapter.save("sess-1", events, sessionSummary());

    const summaries = await adapter.listByWorkspace("ws-1");
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    assert(summary, "expected summary to exist");
    expect(summary.sessionId).toBe("sess-1");
    expect(summary.workspaceId).toBe("ws-1");
    expect(summary.stepCount).toBe(1);
  });

  test("filters by workspaceId", async () => {
    await adapter.save("sess-1", [sessionStart()], sessionSummary({ workspaceId: "ws-1" }));
    await adapter.save(
      "sess-2",
      [sessionStart("sess-2")],
      sessionSummary({ sessionId: "sess-2", workspaceId: "ws-2" }),
    );

    const ws1 = await adapter.listByWorkspace("ws-1");
    const ws2 = await adapter.listByWorkspace("ws-2");

    expect(ws1).toHaveLength(1);
    const first = ws1[0];
    assert(first, "expected ws-1 summary to exist");
    expect(first.sessionId).toBe("sess-1");
    expect(ws2).toHaveLength(1);
    const second = ws2[0];
    assert(second, "expected ws-2 summary to exist");
    expect(second.sessionId).toBe("sess-2");
  });

  test("returns summaries sorted by startedAt descending", async () => {
    await adapter.save(
      "sess-old",
      [sessionStart("sess-old")],
      sessionSummary({ sessionId: "sess-old", startedAt: "2026-02-12T10:00:00.000Z" }),
    );
    await adapter.save(
      "sess-new",
      [sessionStart("sess-new")],
      sessionSummary({ sessionId: "sess-new", startedAt: "2026-02-14T10:00:00.000Z" }),
    );

    const summaries = await adapter.listByWorkspace("ws-1");
    expect(summaries).toHaveLength(2);
    const [newest, oldest] = summaries;
    assert(newest, "expected newest summary to exist");
    assert(oldest, "expected oldest summary to exist");
    expect(newest.sessionId).toBe("sess-new");
    expect(oldest.sessionId).toBe("sess-old");
  });
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { CortexSessionHistoryAdapter } from "./cortex-session-history-adapter.ts";
import type {
  SessionStartEvent,
  SessionStreamEvent,
  SessionSummary,
  StepCompleteEvent,
  StepStartEvent,
} from "./session-events.ts";
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
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  vi.stubEnv("ATLAS_KEY", "test-key");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(data: string, status = 200): Response {
  return new Response(data, { status });
}

const BASE_URL = "https://cortex.test";
let adapter: SessionHistoryAdapter;

beforeEach(() => {
  adapter = new CortexSessionHistoryAdapter(BASE_URL);
});

// ---------------------------------------------------------------------------
// appendEvent (no-op)
// ---------------------------------------------------------------------------

describe("appendEvent", () => {
  test("is a no-op — does not make HTTP calls", async () => {
    await adapter.appendEvent("sess-1", sessionStart());
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

describe("save", () => {
  test("PUTs session data blob and sets metadata", async () => {
    // First call: POST /objects (upload blob) → returns { id: "cortex-obj-1" }
    // Second call: POST /objects/cortex-obj-1/metadata → sets metadata
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ id: "cortex-obj-1" }))
      .mockResolvedValueOnce(textResponse("ok"));

    const events: SessionStreamEvent[] = [
      sessionStart(),
      stepStart(),
      stepComplete(),
      sessionComplete(),
    ];
    await adapter.save("sess-1", events, sessionSummary());

    // Verify blob upload
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const blobCall = mockFetch.mock.calls[0];
    assert(blobCall, "expected blob upload call");
    const [blobUrl, blobInit] = blobCall;
    expect(blobUrl).toBe(`${BASE_URL}/objects`);
    expect(blobInit?.method).toBe("POST");

    assert(typeof blobInit?.body === "string", "expected body to be a string");
    const blobBody = z
      .object({ events: z.array(z.unknown()), summary: z.object({ sessionId: z.string() }) })
      .parse(JSON.parse(blobInit.body));
    expect(blobBody.events).toHaveLength(4);
    expect(blobBody.summary.sessionId).toBe("sess-1");

    // Verify metadata
    const metaCall = mockFetch.mock.calls[1];
    assert(metaCall, "expected metadata call");
    const [metaUrl, metaInit] = metaCall;
    expect(metaUrl).toBe(`${BASE_URL}/objects/cortex-obj-1/metadata`);
    expect(metaInit?.method).toBe("POST");

    assert(typeof metaInit?.body === "string", "expected body to be a string");
    const metadata = z
      .object({ session_id: z.string(), workspace_id: z.string() })
      .parse(JSON.parse(metaInit.body));
    expect(metadata.session_id).toBe("sess-1");
    expect(metadata.workspace_id).toBe("ws-1");
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("get", () => {
  test("returns null when session not found", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const result = await adapter.get("nonexistent");
    expect(result).toBeNull();
  });

  test("fetches session blob, reduces events to SessionView", async () => {
    const events: SessionStreamEvent[] = [
      sessionStart(),
      stepStart(),
      stepComplete(),
      sessionComplete(),
    ];
    const storedPayload = { events, summary: sessionSummary() };

    // First call: GET /objects?metadata.session_id=sess-1 → [{ id: "cortex-obj-1" }]
    // Second call: GET /objects/cortex-obj-1 → stored payload
    mockFetch
      .mockResolvedValueOnce(jsonResponse([{ id: "cortex-obj-1" }]))
      .mockResolvedValueOnce(textResponse(JSON.stringify(storedPayload)));

    const view = await adapter.get("sess-1");
    assert(view, "expected view to exist");
    expect(view.sessionId).toBe("sess-1");
    expect(view.status).toBe("completed");
    expect(view.agentBlocks).toHaveLength(1);
    const block = view.agentBlocks[0];
    assert(block, "expected agent block to exist");
    expect(block.agentName).toBe("researcher");
    expect(block.toolCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// listByWorkspace
// ---------------------------------------------------------------------------

describe("listByWorkspace", () => {
  test("returns empty array when no sessions exist", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const result = await adapter.listByWorkspace("ws-1");
    expect(result).toHaveLength(0);
  });

  test("returns summaries from stored session payloads", async () => {
    const summary = sessionSummary();

    // GET /objects?metadata.workspace_id=ws-1 → [{ id: "obj-1", metadata: {...} }]
    mockFetch.mockResolvedValueOnce(
      jsonResponse([{ id: "obj-1", metadata: { session_id: "sess-1", workspace_id: "ws-1" } }]),
    );
    // GET /objects/obj-1 → payload with summary
    mockFetch.mockResolvedValueOnce(
      textResponse(JSON.stringify({ events: [sessionStart()], summary })),
    );

    const result = await adapter.listByWorkspace("ws-1");
    expect(result).toHaveLength(1);
    const returned = result[0];
    assert(returned, "expected summary to exist");
    expect(returned.sessionId).toBe("sess-1");
    expect(returned.workspaceId).toBe("ws-1");
  });

  test("returns summaries sorted by startedAt descending", async () => {
    const oldSummary = sessionSummary({
      sessionId: "sess-old",
      startedAt: "2026-02-12T10:00:00.000Z",
    });
    const newSummary = sessionSummary({
      sessionId: "sess-new",
      startedAt: "2026-02-14T10:00:00.000Z",
    });

    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { id: "obj-old", metadata: { session_id: "sess-old", workspace_id: "ws-1" } },
        { id: "obj-new", metadata: { session_id: "sess-new", workspace_id: "ws-1" } },
      ]),
    );
    // Fetch blobs in order
    mockFetch
      .mockResolvedValueOnce(textResponse(JSON.stringify({ events: [], summary: oldSummary })))
      .mockResolvedValueOnce(textResponse(JSON.stringify({ events: [], summary: newSummary })));

    const result = await adapter.listByWorkspace("ws-1");
    expect(result).toHaveLength(2);
    const [newest, oldest] = result;
    assert(newest, "expected newest summary to exist");
    assert(oldest, "expected oldest summary to exist");
    expect(newest.sessionId).toBe("sess-new");
    expect(oldest.sessionId).toBe("sess-old");
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("authentication", () => {
  test("throws when ATLAS_KEY is missing", async () => {
    vi.stubEnv("ATLAS_KEY", "");

    const events: SessionStreamEvent[] = [sessionStart()];
    await expect(adapter.save("sess-1", events, sessionSummary())).rejects.toThrow("ATLAS_KEY");
  });

  test("includes Bearer token in requests", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    await adapter.listByWorkspace("ws-1");

    const call = mockFetch.mock.calls[0];
    assert(call, "expected fetch to have been called");
    const [, init] = call;
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
  });
});

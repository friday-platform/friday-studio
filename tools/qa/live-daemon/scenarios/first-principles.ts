#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * First-principles daemon eval suite for the melodic branch.
 *
 * This is intentionally not another phase-smoke runner. It encodes the
 * original architecture principles as no-auth, daemon-backed assertions:
 * refs over data, inputFrom ref resolution, compact job-tool returns, and
 * validation/output contract regressions. The fake inbox MCP models a
 * Gmail-shaped workload without OAuth/network.
 */

import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { dirname, join } from "jsr:@std/path@1";
import {
  currentGitSha,
  type DaemonHandle,
  ensureCredentialsLoaded,
  fetchSessionEvents,
  HARNESS_PATHS,
  listArtifactsForSession,
  registerWorkspace,
  type SSEEvent,
  startDaemon,
  stopDaemon,
  triggerSignalSSE,
} from "../harness.ts";

interface EvalResult {
  id: string;
  pass: boolean;
  notes: string[];
  metrics: Record<string, unknown>;
}

const FAKE_INBOX_MCP = join(HARNESS_PATHS.fixturesDir, "stub-mcp/fake-inbox-server.ts");
const REFS_FIXTURE = join(HARNESS_PATHS.fixturesDir, "first-principles-refs");

async function materializeFixture(srcDir: string, replacements: Record<string, string>) {
  const tmpDir = await Deno.makeTempDir({ prefix: "friday-first-principles-" });
  const src = await Deno.readTextFile(join(srcDir, "workspace.yml"));
  let rendered = src;
  for (const [from, to] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(from, to);
  }
  await Deno.writeTextFile(join(tmpDir, "workspace.yml"), rendered);
  return tmpDir;
}

async function natsKvGetJson(
  natsUrl: string,
  bucket: string,
  key: string,
): Promise<Record<string, unknown> | null> {
  const cmd = new Deno.Command("nats", {
    args: ["-s", natsUrl, "kv", "get", bucket, key, "--raw"],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  if (!out.success) return null;
  const text = new TextDecoder().decode(out.stdout).trim();
  if (!text) return null;
  return JSON.parse(text) as Record<string, unknown>;
}

function byteLen(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function recordJobMetrics(
  metrics: Record<string, unknown>,
  trigger: { durationMs: number; sessionId: string | null; jobComplete: unknown },
): void {
  metrics.wallTimeMs = trigger.durationMs;
  metrics.sessionId = trigger.sessionId;
  metrics.jobComplete = trigger.jobComplete;
  metrics.jobPayloadBytes = byteLen(trigger.jobComplete ?? {});
}

function recordEventMetrics(
  metrics: Record<string, unknown>,
  events: Awaited<ReturnType<typeof fetchSessionEvents>>,
): void {
  metrics.usage = events.totalUsage;
  metrics.totalTokens =
    events.totalUsage.inputTokens +
    events.totalUsage.outputTokens +
    events.totalUsage.cacheReadTokens +
    events.totalUsage.cacheWriteTokens;
  metrics.toolCallCount = events.toolCallCount;
  metrics.stepValidationCount = events.stepValidations.length;
}

async function fetchTextArtifactJson(
  d: DaemonHandle,
  artifactId: string,
): Promise<Record<string, unknown> | null> {
  const resp = await fetch(`${d.baseUrl}/api/artifacts/${encodeURIComponent(artifactId)}`);
  if (!resp.ok) return null;
  const body = (await resp.json()) as { contents?: string };
  if (!body.contents) return null;
  return JSON.parse(body.contents) as Record<string, unknown>;
}

async function listElicitations(
  d: DaemonHandle,
  workspaceId: string,
): Promise<Array<Record<string, unknown>>> {
  const resp = await fetch(
    `${d.baseUrl}/api/elicitations?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  if (!resp.ok) return [];
  const body = (await resp.json()) as { elicitations?: Array<Record<string, unknown>> };
  return body.elicitations ?? [];
}

async function waitForPendingElicitation(
  d: DaemonHandle,
  workspaceId: string,
  timeoutMs = 60_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = (await listElicitations(d, workspaceId)).find((e) => e.status === "pending");
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function answerElicitation(
  d: DaemonHandle,
  id: string,
  value: string,
): Promise<Record<string, unknown>> {
  const resp = await fetch(`${d.baseUrl}/api/elicitations/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value, answeredBy: "first-principles-eval" }),
  });
  if (!resp.ok) throw new Error(`answer elicitation ${resp.status}: ${await resp.text()}`);
  return (await resp.json()) as Record<string, unknown>;
}

async function readMemoryEntries(
  d: DaemonHandle,
  workspaceId: string,
  memoryName: string,
): Promise<Array<Record<string, unknown>>> {
  const resp = await fetch(
    `${d.baseUrl}/api/memory/${encodeURIComponent(workspaceId)}/narrative/${encodeURIComponent(
      memoryName,
    )}`,
  );
  if (!resp.ok) return [];
  const body = await resp.json();
  return Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
}

async function fetchWorkspaceConfig(
  d: DaemonHandle,
  workspaceId: string,
): Promise<Record<string, unknown> | null> {
  const resp = await fetch(`${d.baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/config`);
  if (!resp.ok) return null;
  const body = (await resp.json()) as { config?: Record<string, unknown> };
  return body.config ?? null;
}

async function fetchChatSystemPrompt(
  d: DaemonHandle,
  workspaceId: string,
  chatId: string,
): Promise<string> {
  const resp = await fetch(
    `${d.baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(
      chatId,
    )}`,
  );
  if (!resp.ok) return "";
  const body = (await resp.json()) as {
    systemPromptContext?: { systemMessages?: string[] } | null;
  };
  return (body.systemPromptContext?.systemMessages ?? []).join("\n\n");
}

interface ChatToolCall {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
}

async function postChatMessage(
  d: DaemonHandle,
  workspaceId: string,
  chatId: string,
  messageText: string,
  opts: { timeoutMs?: number } = {},
): Promise<{
  events: SSEEvent[];
  chatSessionId: string | null;
  innerSessionIds: string[];
  toolCalls: ChatToolCall[];
  durationMs: number;
}> {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 600_000);

  let resp: Response;
  try {
    resp = await fetch(`${d.baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ id: chatId, message: messageText }),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Chat POST failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!resp.ok) {
    clearTimeout(timer);
    throw new Error(`Chat POST ${resp.status}: ${await resp.text()}`);
  }
  if (!resp.body) {
    clearTimeout(timer);
    throw new Error("Chat POST response had no body");
  }

  const events: SSEEvent[] = [];
  let chatSessionId: string | null = null;
  const innerSessionIds = new Set<string>();
  const toolCallsById = new Map<string, ChatToolCall>();
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf("\n\n");
        if (idx === -1) break;
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        const raw = dataLine.slice(5).trim();
        if (raw === "[DONE]") {
          buffer = "";
          break;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof parsed.type !== "string") continue;
        const data = (parsed.data as Record<string, unknown> | undefined) ?? {};
        const evt: SSEEvent = { type: parsed.type, data, raw };
        events.push(evt);

        if (evt.type === "data-session-start" && typeof data.sessionId === "string") {
          if (chatSessionId === null) chatSessionId = data.sessionId;
          else innerSessionIds.add(data.sessionId);
        }
        if (evt.type === "data-nested-chunk") {
          const inner = data.chunk as { type?: string; data?: Record<string, unknown> } | undefined;
          if (inner?.type === "data-session-start" && typeof inner.data?.sessionId === "string") {
            innerSessionIds.add(inner.data.sessionId);
          }
        }

        if (parsed.type === "tool-input-available") {
          const toolCallId = parsed.toolCallId;
          const toolName = parsed.toolName;
          if (typeof toolCallId === "string" && typeof toolName === "string") {
            const existing = toolCallsById.get(toolCallId);
            toolCallsById.set(toolCallId, {
              toolCallId,
              toolName,
              ...(parsed.input !== undefined ? { input: parsed.input } : {}),
              ...(existing?.output !== undefined ? { output: existing.output } : {}),
            });
          }
        }
        if (parsed.type === "tool-output-available") {
          const toolCallId = parsed.toolCallId;
          if (typeof toolCallId === "string") {
            const existing = toolCallsById.get(toolCallId);
            toolCallsById.set(toolCallId, {
              toolCallId,
              toolName: existing?.toolName ?? "<unknown>",
              ...(existing?.input !== undefined ? { input: existing.input } : {}),
              output: parsed.output,
            });
          }
        }
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  return {
    events,
    chatSessionId,
    innerSessionIds: [...innerSessionIds],
    toolCalls: [...toolCallsById.values()],
    durationMs: Date.now() - startedAt,
  };
}

function artifactPayload(doc: Record<string, unknown> | null): Record<string, unknown> | undefined {
  const nested = (doc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  return nested ?? doc ?? undefined;
}

async function fetchFirstArtifactPayload(
  d: DaemonHandle,
  data: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> {
  const ref = Array.isArray(data?.artifactRefs)
    ? (data.artifactRefs[0] as { id?: string } | undefined)
    : undefined;
  if (!ref?.id) return undefined;
  return artifactPayload(await fetchTextArtifactJson(d, ref.id));
}

function hasArtifactRef(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (obj.artifactRef && typeof obj.artifactRef === "object") return true;
  if (Array.isArray(obj.artifactRefs) && obj.artifactRefs.length > 0) return true;
  if (typeof obj.artifactId === "string") return true;
  return false;
}

async function runRefsOverDataScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles Refs" });
  notes.push(`workspace ${ws.id} registered`);

  const trigger = await triggerSignalSSE(d, ws.id, "refs-event", {
    payload: { query: "first-principles" },
    timeoutMs: 8 * 60 * 1000,
  });
  recordJobMetrics(metrics, trigger);

  if (!trigger.sessionId) {
    return [
      {
        id: "refs-over-data-action-output",
        pass: false,
        notes: [...notes, "no session id returned"],
        metrics,
      },
    ];
  }

  const bucket = `WS_DOCS_${ws.id}`;
  const emailsKey = `doc/session/${trigger.sessionId}/refs-check/emails-result`;
  const reviewKey = `doc/session/${trigger.sessionId}/refs-check/review-result`;
  const emailsDoc = await natsKvGetJson(d.natsUrl, bucket, emailsKey);
  const reviewDoc = await natsKvGetJson(d.natsUrl, bucket, reviewKey);
  const emailsData = (emailsDoc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const reviewData = (reviewDoc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const artifacts = await listArtifactsForSession(d, ws.id, trigger.sessionId);
  const events = await fetchSessionEvents(d, trigger.sessionId);
  recordEventMetrics(metrics, events);

  metrics.bucket = bucket;
  metrics.emailsDocBytes = emailsDoc ? byteLen(emailsDoc) : 0;
  metrics.reviewDocBytes = reviewDoc ? byteLen(reviewDoc) : 0;
  metrics.emailsDataKeys = emailsData ? Object.keys(emailsData) : [];
  metrics.reviewData = reviewData ?? null;
  metrics.artifactCount = artifacts.length;
  metrics.toolCallCount = events.toolCallCount;
  metrics.usage = events.totalUsage;

  const reviewArtifactData = await fetchFirstArtifactPayload(d, reviewData);
  metrics.reviewArtifactData = reviewArtifactData ?? null;

  const emailDocHasRefs = hasArtifactRef(emailsData);
  const emailDocStillInlineMessages = Array.isArray(emailsData?.messages);
  const emailDocContainsBodySentinel = JSON.stringify(emailsData ?? {}).includes(
    "FIRST_PRINCIPLES_EMAIL_BODY",
  );
  const reviewPayload = reviewArtifactData ?? reviewData;
  const reviewConsumedInput =
    reviewPayload?.marker === "CONSUMED_EMAIL_BATCH" &&
    reviewPayload?.count === 12 &&
    reviewPayload?.firstId === "fake-001";
  const jobPayload = (trigger.jobComplete ?? {}) as Record<string, unknown>;
  const artifactIds = Array.isArray(jobPayload.artifactIds) ? jobPayload.artifactIds : [];
  const jobResultCompact =
    artifactIds.length > 0 &&
    typeof jobPayload.summary === "string" &&
    !JSON.stringify(jobPayload).includes("FIRST_PRINCIPLES_EMAIL_BODY") &&
    byteLen(jobPayload) < 2_000;

  return [
    {
      id: "refs-over-data-action-output",
      pass: emailDocHasRefs && !emailDocStillInlineMessages && !emailDocContainsBodySentinel,
      notes: [
        ...notes,
        `emails-result has artifact ref: ${emailDocHasRefs}`,
        `emails-result still has inline messages[]: ${emailDocStillInlineMessages}`,
        `emails-result contains body sentinel: ${emailDocContainsBodySentinel}`,
        `emails-result bytes: ${metrics.emailsDocBytes}`,
      ],
      metrics,
    },
    {
      id: "inputFrom-ref-resolution-single",
      pass: reviewConsumedInput,
      notes: [
        `review-result marker: ${String(reviewPayload?.marker ?? "(missing)")}`,
        `review-result count: ${String(reviewPayload?.count ?? "(missing)")}`,
        `review-result firstId: ${String(reviewPayload?.firstId ?? "(missing)")}`,
      ],
      metrics,
    },
    {
      id: "compact-job-tool-return",
      pass: jobResultCompact,
      notes: [
        `job artifactIds: ${artifactIds.length}`,
        `job payload bytes: ${byteLen(jobPayload)}`,
        `job payload contains body sentinel: ${JSON.stringify(jobPayload).includes("FIRST_PRINCIPLES_EMAIL_BODY")}`,
      ],
      metrics,
    },
    {
      id: "session-artifacts-created",
      pass: artifacts.length >= 2,
      notes: [`session artifact count: ${artifacts.length}`],
      metrics,
    },
  ];
}

function parseJsonResponsePayload(
  rawPayload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (
    rawPayload &&
    rawPayload.response &&
    typeof rawPayload.response === "object" &&
    !Array.isArray(rawPayload.response)
  ) {
    return rawPayload.response as Record<string, unknown>;
  }
  if (
    rawPayload &&
    rawPayload.result &&
    typeof rawPayload.result === "object" &&
    !Array.isArray(rawPayload.result)
  ) {
    return rawPayload.result as Record<string, unknown>;
  }
  const responseText =
    rawPayload && typeof rawPayload.response === "string" ? rawPayload.response.trim() : "";
  if (!responseText) return rawPayload;
  const jsonText = responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return rawPayload;
  }
}

function isTrue(value: unknown): boolean {
  return value === true || value === "true";
}

function isFalse(value: unknown): boolean {
  return value === false || value === "false";
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function validationSummary(events: Awaited<ReturnType<typeof fetchSessionEvents>>): string {
  return events.stepValidations
    .map((v) => `${v.strategy}:${v.verdict ?? v.skipReason ?? "none"}`)
    .join(",");
}

async function runInputFromArrayScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles Refs Array" });
  notes.push(`workspace ${ws.id} registered`);

  const trigger = await triggerSignalSSE(d, ws.id, "refs-array-event", {
    payload: { query: "inputFrom-array" },
    timeoutMs: 8 * 60 * 1000,
  });
  recordJobMetrics(metrics, trigger);

  if (!trigger.sessionId) {
    return [
      {
        id: "inputFrom-ref-resolution-array",
        pass: false,
        notes: [...notes, "no session id returned"],
        metrics,
      },
    ];
  }

  const bucket = `WS_DOCS_${ws.id}`;
  const reviewKey = `doc/session/${trigger.sessionId}/refs-array-check/array-review-result`;
  const reviewDoc = await natsKvGetJson(d.natsUrl, bucket, reviewKey);
  const reviewData = (reviewDoc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const reviewArtifactData = await fetchFirstArtifactPayload(d, reviewData);
  const reviewPayload = reviewArtifactData ?? reviewData;
  const artifacts = await listArtifactsForSession(d, ws.id, trigger.sessionId);
  const events = await fetchSessionEvents(d, trigger.sessionId);
  recordEventMetrics(metrics, events);

  metrics.bucket = bucket;
  metrics.reviewDocBytes = reviewDoc ? byteLen(reviewDoc) : 0;
  metrics.reviewData = reviewData ?? null;
  metrics.reviewArtifactData = reviewArtifactData ?? null;
  metrics.artifactCount = artifacts.length;

  const firstIds = Array.isArray(reviewPayload?.firstIds) ? reviewPayload.firstIds : [];
  const pass =
    reviewPayload?.marker === "CONSUMED_INPUTFROM_ARRAY" &&
    reviewPayload?.totalCount === 5 &&
    firstIds[0] === "a-001" &&
    firstIds[1] === "b-001" &&
    artifacts.length >= 3;

  return [
    {
      id: "inputFrom-ref-resolution-array",
      pass,
      notes: [
        ...notes,
        `array marker: ${String(reviewPayload?.marker ?? "(missing)")}`,
        `array totalCount: ${String(reviewPayload?.totalCount ?? "(missing)")}`,
        `array firstIds: ${JSON.stringify(firstIds)}`,
        `session artifact count: ${artifacts.length}`,
      ],
      metrics,
    },
  ];
}

async function runValidationContractScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles Validation" });
  notes.push(`workspace ${ws.id} registered`);

  const trigger = await triggerSignalSSE(d, ws.id, "validation-contract-event", {
    payload: { query: "validation-contract" },
    timeoutMs: 8 * 60 * 1000,
  });
  recordJobMetrics(metrics, trigger);

  if (!trigger.sessionId) {
    return [
      {
        id: "validation-output-contract",
        pass: false,
        notes: [...notes, "no session id returned"],
        metrics,
      },
    ];
  }

  const bucket = `WS_DOCS_${ws.id}`;
  const key = `doc/session/${trigger.sessionId}/validation-contract-check/validation-result`;
  const doc = await natsKvGetJson(d.natsUrl, bucket, key);
  const data = (doc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const artifactData = await fetchFirstArtifactPayload(d, data);
  const payload = artifactData ?? data;
  const events = await fetchSessionEvents(d, trigger.sessionId);
  recordEventMetrics(metrics, events);
  const serializedDoc = JSON.stringify(data ?? {});
  const serializedPayload = JSON.stringify(payload ?? {});
  const hasRecordValidationStub =
    serializedDoc.includes("record_validation") || serializedPayload.includes("record_validation");
  const looksTransitional = /now\s+(let|i)|record validation|validation and return/i.test(
    serializedPayload,
  );
  const validationHasImplicitPass = events.stepValidations.some(
    (v) => v.strategy === "self" && v.verdict === "pass",
  );

  metrics.bucket = bucket;
  metrics.docBytes = doc ? byteLen(doc) : 0;
  metrics.data = data ?? null;
  metrics.artifactData = artifactData ?? null;
  metrics.stepValidations = events.stepValidations;
  metrics.toolCallCount = events.toolCallCount;

  const pass =
    payload?.marker === "VALIDATION_CONTRACT_OK" &&
    payload?.value === 7 &&
    payload?.explanation === "structured output survived validation" &&
    validationHasImplicitPass &&
    !hasRecordValidationStub &&
    !looksTransitional;

  return [
    {
      id: "validation-output-contract",
      pass,
      notes: [
        ...notes,
        `marker: ${String(payload?.marker ?? "(missing)")}`,
        `value: ${String(payload?.value ?? "(missing)")}`,
        `validation: ${validationSummary(events) || "(missing)"}`,
        `record_validation stub: ${hasRecordValidationStub}`,
        `transitional prose: ${looksTransitional}`,
      ],
      metrics,
    },
  ];
}

async function runAgentOutputContractScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles Agent Contract" });
  notes.push(`workspace ${ws.id} registered`);

  const trigger = await triggerSignalSSE(d, ws.id, "agent-output-contract-event", {
    payload: { query: "agent-output-contract" },
    timeoutMs: 8 * 60 * 1000,
  });
  recordJobMetrics(metrics, trigger);

  if (!trigger.sessionId) {
    return [
      {
        id: "agent-output-contract",
        pass: false,
        notes: [...notes, "no session id returned"],
        metrics,
      },
    ];
  }

  const bucket = `WS_DOCS_${ws.id}`;
  const key = `doc/session/${trigger.sessionId}/agent-output-contract-check/agent-contract-result`;
  const doc = await natsKvGetJson(d.natsUrl, bucket, key);
  const data = (doc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const artifactData = await fetchFirstArtifactPayload(d, data);
  const payload = parseJsonResponsePayload(artifactData ?? data);
  const events = await fetchSessionEvents(d, trigger.sessionId);
  recordEventMetrics(metrics, events);
  const rawOutput = artifactData ?? data;
  const responseValue = rawOutput?.response;
  const responseText =
    typeof responseValue === "string" ? responseValue : JSON.stringify(responseValue ?? "");
  const responsePresent =
    typeof responseValue === "string"
      ? responseValue.trim().length > 0
      : responseValue !== undefined && responseText !== "{}" && responseText !== "";
  const toolNames = events.events
    .filter((ev) => ev.type === "step:complete" && Array.isArray(ev.toolCalls))
    .flatMap((ev) =>
      ((ev as { toolCalls?: Array<{ toolName?: string }> }).toolCalls ?? []).map(
        (tc) => tc.toolName,
      ),
    );
  const validationHasImplicitPass = events.stepValidations.some(
    (v) => v.strategy === "self" && v.verdict === "pass",
  );
  const containsRecordValidation = toolNames.includes("record_validation");

  metrics.bucket = bucket;
  metrics.docBytes = doc ? byteLen(doc) : 0;
  metrics.data = data ?? null;
  metrics.artifactData = artifactData ?? null;
  metrics.responseLength = responseText.length;
  metrics.toolNames = toolNames;
  metrics.stepValidations = events.stepValidations;

  const pass =
    payload?.marker === "AGENT_OUTPUT_CONTRACT_OK" &&
    numberValue(payload?.value) === 11 &&
    (responsePresent || Object.keys(payload ?? {}).length > 0) &&
    validationHasImplicitPass &&
    toolNames.includes("complete") &&
    !containsRecordValidation;

  return [
    {
      id: "agent-output-contract",
      pass,
      notes: [
        ...notes,
        `marker: ${String(payload?.marker ?? "(missing)")}`,
        `value: ${String(payload?.value ?? "(missing)")}`,
        `response length: ${responseText.length}`,
        `validation: ${validationSummary(events) || "(missing)"}`,
        `tool calls: ${toolNames.join(",") || "(missing)"}`,
        `record_validation called: ${containsRecordValidation}`,
      ],
      metrics,
    },
  ];
}

async function runLlmAgentInputFromHydrationScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles LLM Agent InputFrom" });
  notes.push(`workspace ${ws.id} registered`);

  const trigger = await triggerSignalSSE(d, ws.id, "llm-agent-inputfrom-event", {
    payload: { query: "llm-agent-inputfrom" },
    timeoutMs: 8 * 60 * 1000,
  });
  recordJobMetrics(metrics, trigger);

  if (!trigger.sessionId) {
    return [
      {
        id: "llm-agent-inputfrom-ref-hydration",
        pass: false,
        notes: [...notes, "no session id returned"],
        metrics,
      },
    ];
  }

  const bucket = `WS_DOCS_${ws.id}`;
  const key = `doc/session/${trigger.sessionId}/llm-agent-inputfrom-check/agent-hydration-result`;
  const doc = await natsKvGetJson(d.natsUrl, bucket, key);
  const data = (doc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const artifactData = await fetchFirstArtifactPayload(d, data);
  const payload = parseJsonResponsePayload(artifactData ?? data);
  const events = await fetchSessionEvents(d, trigger.sessionId);
  recordEventMetrics(metrics, events);

  const toolNames = events.events
    .filter((ev) => ev.type === "step:complete" && Array.isArray(ev.toolCalls))
    .flatMap((ev) =>
      ((ev as { toolCalls?: Array<{ toolName?: string }> }).toolCalls ?? []).map(
        (tc) => tc.toolName,
      ),
    );
  const artifactFanInTools = toolNames.filter((name) =>
    ["artifacts_get", "parse_artifact", "display_artifact", "delegate"].includes(String(name)),
  );

  metrics.bucket = bucket;
  metrics.docBytes = doc ? byteLen(doc) : 0;
  metrics.data = data ?? null;
  metrics.artifactData = artifactData ?? null;
  metrics.payload = payload ?? null;
  metrics.toolNames = toolNames;
  metrics.artifactFanInTools = artifactFanInTools;

  const pass =
    payload?.marker === "LLM_AGENT_INPUTFROM_HYDRATED" &&
    numberValue(payload?.count) === 12 &&
    payload?.firstId === "fake-001" &&
    isTrue(payload?.sawBodySentinel) &&
    artifactFanInTools.length === 0;

  return [
    {
      id: "llm-agent-inputfrom-ref-hydration",
      pass,
      notes: [
        ...notes,
        `marker: ${String(payload?.marker ?? "(missing)")}`,
        `count: ${String(payload?.count ?? "(missing)")}`,
        `firstId: ${String(payload?.firstId ?? "(missing)")}`,
        `saw body sentinel: ${String(payload?.sawBodySentinel ?? "(missing)")}`,
        `tool calls: ${toolNames.join(",") || "(missing)"}`,
        `artifact fan-in tools: ${artifactFanInTools.join(",") || "(none)"}`,
      ],
      metrics,
    },
  ];
}

async function runAutoTriageReportOutputContractScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles Report Contract" });
  notes.push(`workspace ${ws.id} registered`);

  const trigger = await triggerSignalSSE(d, ws.id, "auto-triage-report-event", {
    payload: { query: "auto-triage-report" },
    timeoutMs: 8 * 60 * 1000,
  });
  recordJobMetrics(metrics, trigger);

  if (!trigger.sessionId) {
    return [
      {
        id: "auto-triage-report-output-contract",
        pass: false,
        notes: [...notes, "no session id returned"],
        metrics,
      },
    ];
  }

  const bucket = `WS_DOCS_${ws.id}`;
  const key = `doc/session/${trigger.sessionId}/auto-triage-report-contract-check/triage-report`;
  const doc = await natsKvGetJson(d.natsUrl, bucket, key);
  const data = (doc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const artifactData = await fetchFirstArtifactPayload(d, data);
  const payload = parseJsonResponsePayload(artifactData ?? data);
  const events = await fetchSessionEvents(d, trigger.sessionId);
  recordEventMetrics(metrics, events);

  const toolNames = events.events
    .filter((ev) => ev.type === "step:complete" && Array.isArray(ev.toolCalls))
    .flatMap((ev) =>
      ((ev as { toolCalls?: Array<{ toolName?: string }> }).toolCalls ?? []).map(
        (tc) => tc.toolName,
      ),
    );
  const serialized = JSON.stringify({ jobComplete: trigger.jobComplete, data, payload });
  const reportPath = typeof payload?.reportPath === "string" ? payload.reportPath : "";
  const reportSummary = typeof payload?.reportSummary === "string" ? payload.reportSummary : "";
  const looksLikeStub =
    Object.keys(payload ?? {}).length <= 2 || /completed successfully\.?$/i.test(reportSummary);
  const containsBodySentinel = serialized.includes("FIRST_PRINCIPLES_EMAIL_BODY");
  const exploratoryTools = toolNames.filter((name) =>
    ["bash", "fs_glob", "fs_list_files", "artifacts_get", "parse_artifact", "delegate"].includes(
      String(name),
    ),
  );

  metrics.bucket = bucket;
  metrics.docBytes = doc ? byteLen(doc) : 0;
  metrics.data = data ?? null;
  metrics.artifactData = artifactData ?? null;
  metrics.payload = payload ?? null;
  metrics.toolNames = toolNames;
  metrics.reportPath = reportPath;
  metrics.reportSummary = reportSummary;
  metrics.looksLikeStub = looksLikeStub;
  metrics.containsBodySentinel = containsBodySentinel;
  metrics.exploratoryTools = exploratoryTools;

  const pass =
    payload?.marker === "AUTO_TRIAGE_REPORT_CONTRACT_OK" &&
    reportPath === "triage-reports/first-principles-triage.md" &&
    numberValue(payload?.emailsReviewed) === 4 &&
    numberValue(payload?.actionsTaken) === 0 &&
    numberValue(payload?.skippedCount) === 4 &&
    payload?.firstId === "fake-001" &&
    reportSummary.length > 20 &&
    toolNames.includes("search_messages") &&
    toolNames.includes("get_messages_content_batch") &&
    toolNames.includes("fs_write_file") &&
    toolNames.includes("complete") &&
    exploratoryTools.length === 0 &&
    !containsBodySentinel &&
    !looksLikeStub;

  return [
    {
      id: "auto-triage-report-output-contract",
      pass,
      notes: [
        ...notes,
        `marker: ${String(payload?.marker ?? "(missing)")}`,
        `reportPath: ${reportPath || "(missing)"}`,
        `emailsReviewed: ${String(payload?.emailsReviewed ?? "(missing)")}`,
        `actionsTaken: ${String(payload?.actionsTaken ?? "(missing)")}`,
        `skippedCount: ${String(payload?.skippedCount ?? "(missing)")}`,
        `firstId: ${String(payload?.firstId ?? "(missing)")}`,
        `summary: ${reportSummary || "(missing)"}`,
        `tool calls: ${toolNames.join(",") || "(missing)"}`,
        `exploratory tools: ${exploratoryTools.join(",") || "(none)"}`,
        `looks like stub: ${looksLikeStub}`,
        `contains body sentinel: ${containsBodySentinel}`,
      ],
      metrics,
    },
  ];
}

async function runAckOnlyMutationScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles Ack Mutation" });
  notes.push(`workspace ${ws.id} registered`);

  const trigger = await triggerSignalSSE(d, ws.id, "ack-mutation-event", {
    payload: { query: "ack-only" },
    timeoutMs: 8 * 60 * 1000,
  });
  recordJobMetrics(metrics, trigger);

  if (!trigger.sessionId) {
    return [
      {
        id: "ack-only-mutation",
        pass: false,
        notes: [...notes, "no session id returned"],
        metrics,
      },
    ];
  }

  const bucket = `WS_DOCS_${ws.id}`;
  const key = `doc/session/${trigger.sessionId}/ack-mutation-check/mutation-ack`;
  const doc = await natsKvGetJson(d.natsUrl, bucket, key);
  const data = (doc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const artifactData = await fetchFirstArtifactPayload(d, data);
  const rawPayload = artifactData ?? data;
  const payload = parseJsonResponsePayload(rawPayload);
  const events = await fetchSessionEvents(d, trigger.sessionId);
  recordEventMetrics(metrics, events);
  const serializedJob = JSON.stringify(trigger.jobComplete ?? {});
  const serializedDoc = JSON.stringify(data ?? {});
  const serializedPayload = JSON.stringify(payload ?? {});
  const containsBodySentinel = [serializedJob, serializedDoc, serializedPayload].some((s) =>
    s.includes("FIRST_PRINCIPLES_EMAIL_BODY"),
  );
  const containsMessagesArray = [data, payload].some(
    (v) => !!v && typeof v === "object" && Array.isArray((v as Record<string, unknown>).messages),
  );
  const toolNames = events.events
    .filter((ev) => ev.type === "step:complete" && Array.isArray(ev.toolCalls))
    .flatMap((ev) =>
      ((ev as { toolCalls?: Array<{ toolName?: string }> }).toolCalls ?? []).map(
        (tc) => tc.toolName,
      ),
    );
  const receipt = typeof payload?.receipt === "string" ? payload.receipt : "";

  metrics.bucket = bucket;
  metrics.docBytes = doc ? byteLen(doc) : 0;
  metrics.data = data ?? null;
  metrics.artifactData = artifactData ?? null;
  metrics.toolNames = toolNames;
  metrics.toolCallCount = events.toolCallCount;

  const pass =
    payload?.marker === "ACK_ONLY_MUTATION_OK" &&
    isTrue(payload?.ok) &&
    numberValue(payload?.modifiedCount) === 3 &&
    payload?.operation === "batch_modify_message_labels" &&
    receipt.startsWith("fake-mutation-") &&
    !containsBodySentinel &&
    !containsMessagesArray;

  return [
    {
      id: "ack-only-mutation",
      pass,
      notes: [
        ...notes,
        `marker: ${String(payload?.marker ?? "(missing)")}`,
        `modifiedCount: ${String(payload?.modifiedCount ?? "(missing)")}`,
        `receipt: ${receipt || "(missing)"}`,
        `tool calls: ${toolNames.join(",") || "(missing)"}`,
        `contains body sentinel: ${containsBodySentinel}`,
        `contains messages array: ${containsMessagesArray}`,
      ],
      metrics,
    },
  ];
}

async function runUnknownToolScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles Unknown Tool" });
  notes.push(`workspace ${ws.id} registered`);

  const trigger = await triggerSignalSSE(d, ws.id, "unknown-tool-event", {
    payload: { query: "unknown-tool" },
    timeoutMs: 8 * 60 * 1000,
  });
  recordJobMetrics(metrics, trigger);

  if (!trigger.sessionId) {
    return [
      {
        id: "unknown-tool-request",
        pass: false,
        notes: [...notes, "no session id returned"],
        metrics,
      },
    ];
  }

  const bucket = `WS_DOCS_${ws.id}`;
  const key = `doc/session/${trigger.sessionId}/unknown-tool-check/unknown-tool-result`;
  const doc = await natsKvGetJson(d.natsUrl, bucket, key);
  const data = (doc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const artifactData = await fetchFirstArtifactPayload(d, data);
  const payload = parseJsonResponsePayload(artifactData ?? data);
  const elicitations = await listElicitations(d, ws.id);
  const events = await fetchSessionEvents(d, trigger.sessionId);
  recordEventMetrics(metrics, events);
  const discoveryTools = Array.isArray(payload?.discoveryTools) ? payload.discoveryTools : [];
  const toolNames = events.events
    .filter((ev) => ev.type === "step:complete" && Array.isArray(ev.toolCalls))
    .flatMap((ev) =>
      ((ev as { toolCalls?: Array<{ toolName?: string }> }).toolCalls ?? []).map(
        (tc) => tc.toolName,
      ),
    );

  metrics.bucket = bucket;
  metrics.data = data ?? null;
  metrics.artifactData = artifactData ?? null;
  metrics.elicitationCount = elicitations.length;
  metrics.toolNames = toolNames;

  const pass =
    payload?.marker === "UNKNOWN_TOOL_REQUEST_DONE" &&
    isFalse(payload?.granted) &&
    payload?.reason === "unknown_tool" &&
    discoveryTools.includes("list_mcp_tools") &&
    toolNames.includes("request_tool_access") &&
    elicitations.length === 0;

  return [
    {
      id: "unknown-tool-request",
      pass,
      notes: [
        ...notes,
        `marker: ${String(payload?.marker ?? "(missing)")}`,
        `reason: ${String(payload?.reason ?? "(missing)")}`,
        `discoveryTools: ${discoveryTools.join(",") || "(missing)"}`,
        `tool calls: ${toolNames.join(",") || "(missing)"}`,
        `elicitations created: ${elicitations.length}`,
      ],
      metrics,
    },
  ];
}

async function runBlockingElicitationScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles Blocking HITL" });
  notes.push(`workspace ${ws.id} registered`);

  const startedAt = Date.now();
  const triggerPromise = triggerSignalSSE(d, ws.id, "blocking-elicitation-event", {
    payload: { query: "blocking-elicitation" },
    timeoutMs: 8 * 60 * 1000,
  });
  const pending = await waitForPendingElicitation(d, ws.id);
  metrics.pendingObservedAtMs = Date.now() - startedAt;
  metrics.pending = pending ?? null;
  if (pending?.id && typeof pending.id === "string") {
    metrics.answer = await answerElicitation(d, pending.id, "allow_once");
  }
  const trigger = await triggerPromise;
  recordJobMetrics(metrics, trigger);

  if (!trigger.sessionId) {
    return [
      {
        id: "blocking-elicitation",
        pass: false,
        notes: [...notes, "no session id returned"],
        metrics,
      },
    ];
  }

  const bucket = `WS_DOCS_${ws.id}`;
  const key = `doc/session/${trigger.sessionId}/blocking-elicitation-check/blocking-elicitation-result`;
  const doc = await natsKvGetJson(d.natsUrl, bucket, key);
  const data = (doc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const artifactData = await fetchFirstArtifactPayload(d, data);
  const payload = parseJsonResponsePayload(artifactData ?? data);
  const finalElicitations = await listElicitations(d, ws.id);
  const answered = finalElicitations.find((e) => e.id === pending?.id);
  const events = await fetchSessionEvents(d, trigger.sessionId);
  recordEventMetrics(metrics, events);

  metrics.data = data ?? null;
  metrics.artifactData = artifactData ?? null;
  metrics.finalElicitations = finalElicitations;

  const pass =
    pending !== null &&
    answered?.status === "answered" &&
    payload?.marker === "BLOCKING_ELICITATION_RESUMED" &&
    isTrue(payload?.granted) &&
    payload?.reason === "answered" &&
    payload?.answer === "allow_once";

  return [
    {
      id: "blocking-elicitation",
      pass,
      notes: [
        ...notes,
        `pending observed: ${pending !== null}`,
        `terminal status: ${String(answered?.status ?? "(missing)")}`,
        `marker: ${String(payload?.marker ?? "(missing)")}`,
        `granted: ${String(payload?.granted ?? "(missing)")}`,
        `answer: ${String(payload?.answer ?? "(missing)")}`,
      ],
      metrics,
    },
  ];
}

async function runFanoutDelegateScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles Fanout Delegate" });
  notes.push(`workspace ${ws.id} registered`);

  const trigger = await triggerSignalSSE(d, ws.id, "fanout-delegate-event", {
    payload: { query: "fanout-delegate" },
    timeoutMs: 8 * 60 * 1000,
  });
  recordJobMetrics(metrics, trigger);

  if (!trigger.sessionId) {
    return [
      {
        id: "fanout-no-fanin-delegate",
        pass: false,
        notes: [...notes, "no session id returned"],
        metrics,
      },
    ];
  }

  const bucket = `WS_DOCS_${ws.id}`;
  const key = `doc/session/${trigger.sessionId}/fanout-delegate-check/delegate-result`;
  const doc = await natsKvGetJson(d.natsUrl, bucket, key);
  const data = (doc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const artifactData = await fetchFirstArtifactPayload(d, data);
  const payload = parseJsonResponsePayload(artifactData ?? data);
  const events = await fetchSessionEvents(d, trigger.sessionId);
  recordEventMetrics(metrics, events);

  const durableSerialized = JSON.stringify({ jobComplete: trigger.jobComplete, data, payload });
  const streamSerialized = JSON.stringify(trigger.events);
  const delegateLedgerEvents = trigger.events.filter((ev) => ev.type === "data-delegate-ledger");
  const delegateChunkEvents = trigger.events.filter((ev) => ev.type === "data-delegate-chunk");
  const stepToolNames = events.events
    .filter((ev) => ev.type === "step:complete" && Array.isArray(ev.toolCalls))
    .flatMap((ev) =>
      ((ev as { toolCalls?: Array<{ toolName?: string }> }).toolCalls ?? []).map(
        (tc) => tc.toolName,
      ),
    );
  const toolsUsed = Array.isArray(payload?.toolsUsed) ? payload.toolsUsed : [];
  const childAnswer = typeof payload?.childAnswer === "string" ? payload.childAnswer : "";
  const jobPayloadBytes = byteLen(trigger.jobComplete ?? {});

  metrics.bucket = bucket;
  metrics.data = data ?? null;
  metrics.artifactData = artifactData ?? null;
  metrics.payload = payload ?? null;
  metrics.stepToolNames = stepToolNames;
  metrics.toolsUsed = toolsUsed;
  metrics.delegateLedgerEventCount = delegateLedgerEvents.length;
  metrics.delegateChunkEventCount = delegateChunkEvents.length;
  metrics.durablePayloadBytes = byteLen({ jobComplete: trigger.jobComplete, data, payload });
  metrics.streamContainsBodySentinel = streamSerialized.includes("FIRST_PRINCIPLES_EMAIL_BODY");

  const childAnswerCompact =
    childAnswer.length < 500 && !childAnswer.includes("FIRST_PRINCIPLES_EMAIL_BODY");
  const pass =
    payload?.marker === "FANOUT_DELEGATE_PARENT_OK" &&
    isTrue(payload?.childOk) &&
    childAnswerCompact &&
    toolsUsed.includes("search_messages") &&
    toolsUsed.includes("get_messages_content_batch") &&
    stepToolNames.includes("delegate") &&
    !stepToolNames.includes("search_messages") &&
    !stepToolNames.includes("get_messages_content_batch") &&
    !durableSerialized.includes("FIRST_PRINCIPLES_EMAIL_BODY") &&
    jobPayloadBytes < 2_000;

  return [
    {
      id: "fanout-no-fanin-delegate",
      pass,
      notes: [
        ...notes,
        `marker: ${String(payload?.marker ?? "(missing)")}`,
        `childOk: ${String(payload?.childOk ?? "(missing)")}`,
        `child answer compact: ${childAnswerCompact}`,
        `delegate toolsUsed: ${toolsUsed.join(",") || "(missing)"}`,
        `parent step tools: ${stepToolNames.join(",") || "(missing)"}`,
        `delegate ledger events: ${delegateLedgerEvents.length}`,
        `delegate chunk events: ${delegateChunkEvents.length}`,
        `durable payload contains body sentinel: ${durableSerialized.includes("FIRST_PRINCIPLES_EMAIL_BODY")}`,
        `child answer bytes: ${byteLen(childAnswer)}`,
        `job payload bytes: ${jobPayloadBytes}`,
      ],
      metrics,
    },
  ];
}

async function runChatFollowupCompactnessScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles Chat Compactness" });
  notes.push(`workspace ${ws.id} registered`);

  const chatId = crypto.randomUUID();
  const first = await postChatMessage(
    d,
    ws.id,
    chatId,
    [
      "Call the refs-check job tool exactly once with query 'chat-compactness'.",
      "After the job completes, do not inspect artifacts or delegate.",
      "Reply with a short acknowledgement that includes the returned summary.",
    ].join("\n"),
    { timeoutMs: 12 * 60 * 1000 },
  );

  const refsToolCalls = first.toolCalls.filter((tc) => tc.toolName === "refs-check");
  const refsOutput = refsToolCalls.find((tc) => tc.output !== undefined)?.output as
    | Record<string, unknown>
    | undefined;
  const firstSerialized = JSON.stringify({ events: first.events, toolCalls: first.toolCalls });
  const artifactIds = Array.isArray(refsOutput?.artifactIds) ? refsOutput.artifactIds : [];
  const jobToolCompact =
    refsOutput?.success === true &&
    artifactIds.length > 0 &&
    typeof refsOutput.summary === "string" &&
    !("output" in (refsOutput ?? {})) &&
    !JSON.stringify(refsOutput ?? {}).includes("FIRST_PRINCIPLES_EMAIL_BODY") &&
    byteLen(refsOutput) < 2_000;

  const second = await postChatMessage(
    d,
    ws.id,
    chatId,
    [
      "Follow-up: answer from the previous compact job-tool result only.",
      "Do not call any tools, do not fetch/display/parse artifacts, and do not delegate.",
      "Say whether artifact ids were returned.",
    ].join("\n"),
    { timeoutMs: 8 * 60 * 1000 },
  );
  const secondToolNames = second.toolCalls.map((tc) => tc.toolName);
  const fanInTools = new Set([
    "artifacts_get",
    "display_artifact",
    "parse_artifact",
    "delegate",
    "refs-check",
  ]);
  const fanInToolCalls = secondToolNames.filter((name) => fanInTools.has(name));
  const secondSerialized = JSON.stringify({ events: second.events, toolCalls: second.toolCalls });
  const followupCompact =
    fanInToolCalls.length === 0 && !secondSerialized.includes("FIRST_PRINCIPLES_EMAIL_BODY");

  metrics.chatId = chatId;
  metrics.firstChatSessionId = first.chatSessionId;
  metrics.firstInnerSessionIds = first.innerSessionIds;
  metrics.firstDurationMs = first.durationMs;
  metrics.refsToolCallCount = refsToolCalls.length;
  metrics.refsToolOutputBytes = refsOutput ? byteLen(refsOutput) : 0;
  metrics.refsToolOutput = refsOutput ?? null;
  metrics.secondChatSessionId = second.chatSessionId;
  metrics.secondDurationMs = second.durationMs;
  metrics.secondToolNames = secondToolNames;
  metrics.fanInToolCalls = fanInToolCalls;

  const pass = jobToolCompact && followupCompact;
  return [
    {
      id: "chat-followup-compactness",
      pass,
      notes: [
        ...notes,
        `refs-check tool calls: ${refsToolCalls.length}`,
        `refs-check output bytes: ${refsOutput ? byteLen(refsOutput) : 0}`,
        `refs-check artifact ids: ${artifactIds.length}`,
        `refs-check has legacy output field: ${"output" in (refsOutput ?? {})}`,
        `job-tool output contains body sentinel: ${JSON.stringify(refsOutput ?? {}).includes("FIRST_PRINCIPLES_EMAIL_BODY")}`,
        `first SSE stream contains nested body sentinel: ${firstSerialized.includes("FIRST_PRINCIPLES_EMAIL_BODY")}`,
        `follow-up tool calls: ${secondToolNames.join(",") || "(none)"}`,
        `follow-up fan-in tool calls: ${fanInToolCalls.join(",") || "(none)"}`,
        `follow-up contains body sentinel: ${secondSerialized.includes("FIRST_PRINCIPLES_EMAIL_BODY")}`,
      ],
      metrics,
    },
  ];
}

async function runAmbientArtifactInjectionPruningScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles Ambient Artifacts" });
  notes.push(`workspace ${ws.id} registered`);

  const seed = await triggerSignalSSE(d, ws.id, "refs-event", {
    payload: { query: "ambient-artifact-pruning-seed" },
    timeoutMs: 8 * 60 * 1000,
  });
  if (!seed.sessionId) {
    return [
      {
        id: "ambient-artifact-injection-pruning",
        pass: false,
        notes: [...notes, "seed job returned no session id"],
        metrics,
      },
    ];
  }

  const artifacts = await listArtifactsForSession(d, ws.id, seed.sessionId);
  const staleArtifactIds = artifacts.map((a) => a.id).filter((id): id is string => !!id);
  const chatId = crypto.randomUUID();
  const chat = await postChatMessage(
    d,
    ws.id,
    chatId,
    "Reply exactly: AMBIENT_ARTIFACT_PRUNING_OK. Do not call tools.",
    { timeoutMs: 8 * 60 * 1000 },
  );
  const systemPrompt = await fetchChatSystemPrompt(d, ws.id, chatId);
  const promptHasFilesList = systemPrompt.includes("Files (access via artifacts_get)");
  const promptHasStaleArtifactId = staleArtifactIds.some((id) => systemPrompt.includes(id));
  const toolNames = chat.toolCalls.map((tc) => tc.toolName);
  const fanInTools = toolNames.filter((name) =>
    ["artifacts_get", "display_artifact", "parse_artifact", "delegate"].includes(name),
  );

  metrics.seedSessionId = seed.sessionId;
  metrics.staleArtifactIds = staleArtifactIds;
  metrics.chatSessionId = chat.chatSessionId;
  metrics.systemPromptBytes = new TextEncoder().encode(systemPrompt).length;
  metrics.promptHasFilesList = promptHasFilesList;
  metrics.promptHasStaleArtifactId = promptHasStaleArtifactId;
  metrics.toolNames = toolNames;
  metrics.fanInTools = fanInTools;

  const pass =
    staleArtifactIds.length > 0 &&
    !promptHasFilesList &&
    !promptHasStaleArtifactId &&
    fanInTools.length === 0;

  return [
    {
      id: "ambient-artifact-injection-pruning",
      pass,
      notes: [
        ...notes,
        `seed artifacts: ${staleArtifactIds.length}`,
        `prompt has ambient Files list: ${promptHasFilesList}`,
        `prompt has stale artifact id: ${promptHasStaleArtifactId}`,
        `chat tool calls: ${toolNames.join(",") || "(none)"}`,
        `fan-in tools: ${fanInTools.join(",") || "(none)"}`,
      ],
      metrics,
    },
  ];
}

async function runReviewChoiceMemoryLearningScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles Review Memory" });
  notes.push(`workspace ${ws.id} registered`);

  const trigger = await triggerSignalSSE(d, ws.id, "review-choice-event", {
    payload: { query: "review-choice-memory" },
    timeoutMs: 8 * 60 * 1000,
  });
  recordJobMetrics(metrics, trigger);

  if (!trigger.sessionId) {
    return [
      {
        id: "review-choice-memory-learning",
        pass: false,
        notes: [...notes, "no session id returned"],
        metrics,
      },
    ];
  }

  const bucket = `WS_DOCS_${ws.id}`;
  const key = `doc/session/${trigger.sessionId}/review-choice-memory-check/review-choice-result`;
  const doc = await natsKvGetJson(d.natsUrl, bucket, key);
  const data = (doc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const artifactData = await fetchFirstArtifactPayload(d, data);
  const payload = parseJsonResponsePayload(artifactData ?? data);
  const entries = await readMemoryEntries(d, ws.id, "preferences");
  const memoryTexts = entries.map((entry) => String(entry.text ?? ""));
  const learnedText = String(payload?.learnedPreference ?? "");
  const memoryContainsLearned = memoryTexts.some((text) => text.includes(learnedText));
  const events = await fetchSessionEvents(d, trigger.sessionId);
  recordEventMetrics(metrics, events);
  const toolNames = events.events
    .filter((ev) => ev.type === "step:complete" && Array.isArray(ev.toolCalls))
    .flatMap((ev) =>
      ((ev as { toolCalls?: Array<{ toolName?: string }> }).toolCalls ?? []).map(
        (tc) => tc.toolName,
      ),
    );
  const mutationCallCount = toolNames.filter(
    (name) => name === "batch_modify_message_labels",
  ).length;
  const memorySaveCallCount = toolNames.filter((name) => name === "memory_save").length;

  metrics.bucket = bucket;
  metrics.data = data ?? null;
  metrics.artifactData = artifactData ?? null;
  metrics.payload = payload ?? null;
  metrics.memoryTexts = memoryTexts;
  metrics.toolNames = toolNames;
  metrics.mutationCallCount = mutationCallCount;
  metrics.memorySaveCallCount = memorySaveCallCount;

  const pass =
    payload?.marker === "REVIEW_CHOICE_MEMORY_LEARNED" &&
    numberValue(payload?.archivedCount) === 3 &&
    numberValue(payload?.keptCount) === 1 &&
    isTrue(payload?.memorySaved) &&
    learnedText.includes("FIRST_PRINCIPLES_REVIEW_CHOICE") &&
    memoryContainsLearned &&
    mutationCallCount === 1 &&
    memorySaveCallCount === 1;

  return [
    {
      id: "review-choice-memory-learning",
      pass,
      notes: [
        ...notes,
        `marker: ${String(payload?.marker ?? "(missing)")}`,
        `archivedCount: ${String(payload?.archivedCount ?? "(missing)")}`,
        `keptCount: ${String(payload?.keptCount ?? "(missing)")}`,
        `memorySaved: ${String(payload?.memorySaved ?? "(missing)")}`,
        `memory contains learned preference: ${memoryContainsLearned}`,
        `mutation calls: ${mutationCallCount}`,
        `memory_save calls: ${memorySaveCallCount}`,
      ],
      metrics,
    },
  ];
}

async function runSessionInflightCleanupScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles Inflight Cleanup" });
  notes.push(`workspace ${ws.id} registered`);

  const trigger = await triggerSignalSSE(d, ws.id, "refs-event", {
    payload: { query: "session-inflight-cleanup" },
    timeoutMs: 8 * 60 * 1000,
  });
  recordJobMetrics(metrics, trigger);

  if (!trigger.sessionId) {
    return [
      {
        id: "session-inflight-cleanup",
        pass: false,
        notes: [...notes, "no session id returned"],
        metrics,
      },
    ];
  }

  const metadata = await natsKvGetJson(d.natsUrl, "SESSION_METADATA", trigger.sessionId);
  const inflight = await natsKvGetJson(d.natsUrl, "SESSION_INFLIGHT", trigger.sessionId);
  metrics.metadata = metadata ?? null;
  metrics.inflight = inflight ?? null;

  const pass = metadata?.status === "completed" && inflight === null;
  return [
    {
      id: "session-inflight-cleanup",
      pass,
      notes: [
        ...notes,
        `metadata status: ${String(metadata?.status ?? "(missing)")}`,
        `inflight marker present: ${inflight !== null}`,
      ],
      metrics,
    },
  ];
}

async function runWorkspaceFixSkillGuidanceScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const wsPath = await materializeFixture(REFS_FIXTURE, {
    __FAKE_INBOX_MCP_PATH__: FAKE_INBOX_MCP,
  });
  const ws = await registerWorkspace(d, wsPath, { name: "First Principles Workspace Fix" });
  notes.push(`workspace ${ws.id} registered`);

  const targetDescription = "Skill-guided workspace repair applied.";
  const chatId = crypto.randomUUID();
  const chat = await postChatMessage(
    d,
    ws.id,
    chatId,
    [
      "Make this workspace repair now.",
      "Load @friday/workspace-api and @friday/writing-workspace-jobs first.",
      "Read the current workspace config once, then use upsert_job to update only the refs-check job description.",
      `Set the refs-check description exactly to: ${targetDescription}`,
      "Preserve refs-check triggers, config, validation, and fsm exactly as they are.",
      "Do not call fake inbox tools directly and do not delegate.",
    ].join("\n"),
    { timeoutMs: 12 * 60 * 1000 },
  );
  const config = await fetchWorkspaceConfig(d, ws.id);
  const jobs = (config?.jobs as Record<string, unknown> | undefined) ?? {};
  const refsCheck = jobs["refs-check"] as Record<string, unknown> | undefined;
  const toolNames = chat.toolCalls.map((tc) => tc.toolName);
  const serializedToolCalls = JSON.stringify(chat.toolCalls);
  const loadedWorkspaceApi = serializedToolCalls.includes("workspace-api");
  const loadedJobsSkill = serializedToolCalls.includes("writing-workspace-jobs");
  const bypassTools = toolNames.filter((name) =>
    ["delegate", "search_messages", "get_messages_content_batch"].includes(name),
  );
  const upsertJobCalled = toolNames.includes("upsert_job");

  metrics.chatId = chatId;
  metrics.chatSessionId = chat.chatSessionId;
  metrics.toolNames = toolNames;
  metrics.loadedWorkspaceApi = loadedWorkspaceApi;
  metrics.loadedJobsSkill = loadedJobsSkill;
  metrics.upsertJobCalled = upsertJobCalled;
  metrics.bypassTools = bypassTools;
  metrics.refsCheckDescription = refsCheck?.description ?? null;

  const pass =
    loadedWorkspaceApi &&
    loadedJobsSkill &&
    upsertJobCalled &&
    refsCheck?.description === targetDescription &&
    bypassTools.length === 0;

  return [
    {
      id: "workspace-fix-skill-guidance",
      pass,
      notes: [
        ...notes,
        `loaded workspace-api: ${loadedWorkspaceApi}`,
        `loaded writing-workspace-jobs: ${loadedJobsSkill}`,
        `upsert_job called: ${upsertJobCalled}`,
        `refs-check description: ${String(refsCheck?.description ?? "(missing)")}`,
        `bypass tools: ${bypassTools.join(",") || "(none)"}`,
      ],
      metrics,
    },
  ];
}

async function main() {
  await ensureCredentialsLoaded();
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    console.error("ANTHROPIC_API_KEY missing — first-principles daemon eval uses real LLM calls.");
    Deno.exit(2);
  }

  const sha = await currentGitSha();
  const startedAt = new Date().toISOString();
  const writeResult = Deno.args.includes("--write-result");
  const jsonOutputArgIndex = Deno.args.indexOf("--json-output");
  const jsonOutputPath = jsonOutputArgIndex >= 0 ? Deno.args[jsonOutputArgIndex + 1] : undefined;
  if (jsonOutputArgIndex >= 0 && !jsonOutputPath) {
    console.error("--json-output requires a path");
    Deno.exit(2);
  }
  console.log(`▶ first-principles eval @ ${sha}`);

  const daemon = await startDaemon({ healthTimeoutMs: 90_000 });
  const results: EvalResult[] = [];
  try {
    console.log(`✓ daemon up: ${daemon.baseUrl}`);
    console.log("\n── refs over data / inputFrom / compact return ──");
    results.push(...(await runRefsOverDataScenario(daemon)));
    console.log("\n── inputFrom array ref resolution ──");
    results.push(...(await runInputFromArrayScenario(daemon)));
    console.log("\n── validation output contract ──");
    results.push(...(await runValidationContractScenario(daemon)));
    console.log("\n── LLM agent output contract ──");
    results.push(...(await runAgentOutputContractScenario(daemon)));
    console.log("\n── LLM agent inputFrom ref hydration ──");
    results.push(...(await runLlmAgentInputFromHydrationScenario(daemon)));
    console.log("\n── auto-triage report output contract ──");
    results.push(...(await runAutoTriageReportOutputContractScenario(daemon)));
    console.log("\n── ack-only fake inbox mutation ──");
    results.push(...(await runAckOnlyMutationScenario(daemon)));
    console.log("\n── unknown tool request guard ──");
    results.push(...(await runUnknownToolScenario(daemon)));
    console.log("\n── blocking elicitation resume ──");
    results.push(...(await runBlockingElicitationScenario(daemon)));
    console.log("\n── fan-out delegate compactness ──");
    results.push(...(await runFanoutDelegateScenario(daemon)));
    console.log("\n── chat follow-up compactness ──");
    results.push(...(await runChatFollowupCompactnessScenario(daemon)));
    console.log("\n── ambient artifact injection pruning ──");
    results.push(...(await runAmbientArtifactInjectionPruningScenario(daemon)));
    console.log("\n── review-choice memory learning ──");
    results.push(...(await runReviewChoiceMemoryLearningScenario(daemon)));
    console.log("\n── session inflight cleanup ──");
    results.push(...(await runSessionInflightCleanupScenario(daemon)));
    console.log("\n── workspace fix skill guidance ──");
    results.push(...(await runWorkspaceFixSkillGuidanceScenario(daemon)));
  } finally {
    const keepHome = Deno.env.get("FRIDAY_QA_KEEP_HOME") === "1";
    await stopDaemon(daemon, { keepHome });
    if (keepHome) console.log(`(kept) FRIDAY_HOME=${daemon.fridayHome}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n══ first-principles summary: ${passed}/${results.length} passed ══`);
  for (const r of results) {
    console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);
    for (const note of r.notes) console.log(`    ${note}`);
  }

  const report = { gitSha: sha, startedAt, passed, failed, results };
  if (writeResult || jsonOutputPath) {
    const path = jsonOutputPath ?? join(HARNESS_PATHS.resultsDir, `${sha}-first-principles.json`);
    await ensureDir(dirname(path));
    await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
    console.log(`\n→ ${path}`);
  }

  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}

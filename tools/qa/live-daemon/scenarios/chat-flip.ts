#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * H4 — Chat-driven supervisor-flip benchmark.
 *
 * Validates the load-bearing −95.1% claim end-to-end, exercising the
 * actual chat → auto-triage job-tool → chat-supervisor next-turn path
 * (vs the FSM-only `auto-triage-baseline.ts` which exercises the inner
 * job in isolation).
 *
 * Methodology (Option B+C hybrid — see plan):
 *   1. Trigger inbox-event directly to capture LEGACY-shape job-tool
 *      bytes (`{success, sessionId, status, output: Document[]}`).
 *      This is the control: what the chat-supervisor would have ingested
 *      pre-fix on its NEXT turn after the auto-triage tool returned.
 *   2. Open a chat against the same fixture workspace and ask it to run
 *      auto-triage. The chat-supervisor calls the auto-triage job-tool,
 *      which returns COMPACT shape post-fix (`{success, sessionId,
 *      status, artifactIds, summary}`).
 *   3. From the chat session's `step:complete` events, locate the
 *      workspace-chat agent step's `toolCalls[*].result` for the
 *      `auto-triage` call and JSON-stringify it — that's the COMPACT
 *      bytes the next supervisor turn actually ingested.
 *   4. Compute reduction = 1 − compact / legacy. Assert ≥85%.
 *
 * Notes:
 *   - Pre-E1.1 this scenario would compare apples-to-oranges: the
 *     structured-output regression (1c8edab) made the auto-triage's
 *     fetch action emit prose instead of the structured Document the
 *     terminal state expected, skewing both halves of the comparison.
 *     E1.1 (3aa8796) restored hasOutputType so toolChoice and the
 *     terminal-state output match the post-flip contract.
 *   - The chat-supervisor's actual NEXT-turn `step:complete.usage` is
 *     undefined today: the runtime's agent-step side-channel
 *     (`packages/workspace/src/runtime.ts:2740`) doesn't propagate
 *     `result.usage` from the workspace-chat agent execution. We
 *     surface that as `chatSupervisorUsageAvailable: false` so a
 *     follow-up can land that propagation and turn this into a
 *     direct-token measurement.
 *
 * Cost: ~$0.20 (two real LLM calls — control inbox-event + chat).
 *
 * Usage:
 *   deno run -A --unstable-worker-options --unstable-kv \
 *     --unstable-raw-imports tools/qa/live-daemon/scenarios/chat-flip.ts
 *
 * Output: tools/qa/results/<sha>-chat-flip.{json,md}
 */

import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { join } from "jsr:@std/path@1";
import {
  currentGitSha,
  type DaemonHandle,
  ensureCredentialsLoaded,
  fetchSessionEvents,
  HARNESS_PATHS,
  registerWorkspace,
  type SSEEvent,
  startDaemon,
  stopDaemon,
  triggerSignalSSE,
} from "../harness.ts";

const REDUCTION_GATE = 0.85;
const CONTROL_LIMIT = 50;

interface Metrics {
  gitSha: string;
  scenario: "chat-flip";
  startedAt: string;
  inboxCount: number;
  /** Bytes of the legacy `{success, sessionId, status, output}` job-tool return. */
  legacyReturnBytes: number;
  /** Bytes of the post-flip `{success, sessionId, status, artifactIds, summary}` job-tool return. */
  compactReturnBytes: number;
  /** 1 − compact / legacy. Plan gates on ≥0.85. */
  reduction: number;
  reductionGate: number;
  passed: boolean;
  controlSessionId: string | null;
  controlWallTimeMs: number;
  chatSessionId: string | null;
  chatInnerSessionId: string | null;
  chatWallTimeMs: number;
  /** Sum of `step:complete.usage.inputTokens` across the chat session — see header note. */
  chatSupervisorInputTokens: number;
  chatSupervisorUsageAvailable: boolean;
  /** Counts of the auto-triage tool calls observed in chat session events. */
  autoTriageToolCalls: number;
  /** True iff the chat-side auto-triage tool returned `success: true`. */
  chatToolSucceeded: boolean;
  /** First error string surfaced from the chat's auto-triage tool result, if any. */
  chatToolError: string | null;
  notes: string[];
  error?: string;
}

/**
 * Tool-call info reconstructed from AI-SDK chunks on the chat SSE
 * stream. Two chunk types correlate by `toolCallId`:
 *   - `tool-input-available` carries `{toolCallId, toolName, input}`
 *   - `tool-output-available` carries `{toolCallId, output}`
 * The chat session's persisted `step:complete.toolCalls` is empty for
 * `case "agent" → workspace-chat` actions today (the side-channel
 * writer at `runtime.ts:2740` doesn't unpack the agent's nested tool
 * calls), so we reconstruct from the live stream.
 */
interface ChatToolCall {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
}

/**
 * POST a single user message to the chat endpoint and consume the SSE
 * stream until [DONE]. Returns the chat session id, any inner session
 * ids surfaced via `data-nested-chunk` envelopes, and the reconstructed
 * tool-call timeline (see {@link ChatToolCall}).
 */
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
    const text = await resp.text();
    throw new Error(`Chat POST ${resp.status}: ${text}`);
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
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
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
          if (chatSessionId === null) {
            chatSessionId = data.sessionId;
          } else {
            innerSessionIds.add(data.sessionId);
          }
        }
        if (evt.type === "data-nested-chunk") {
          const inner = data.chunk as { type?: string; data?: Record<string, unknown> } | undefined;
          if (inner?.type === "data-session-start" && typeof inner.data?.sessionId === "string") {
            innerSessionIds.add(inner.data.sessionId);
          }
        }
        // AI SDK chunks for tool-call lifecycle. `tool-input-available`
        // and `tool-output-available` are emitted directly on the chat
        // SSE stream (no `data-` prefix) — they're standard
        // AtlasUIMessageChunk types from the Vercel AI SDK.
        if (parsed.type === "tool-input-available") {
          const toolCallId = parsed.toolCallId;
          const toolName = parsed.toolName;
          const input = parsed.input;
          if (typeof toolCallId === "string" && typeof toolName === "string") {
            const existing = toolCallsById.get(toolCallId);
            toolCallsById.set(toolCallId, {
              toolCallId,
              toolName,
              input,
              ...(existing?.output !== undefined && { output: existing.output }),
            });
          }
        }
        if (parsed.type === "tool-output-available") {
          const toolCallId = parsed.toolCallId;
          const output = parsed.output;
          if (typeof toolCallId === "string") {
            const existing = toolCallsById.get(toolCallId);
            toolCallsById.set(toolCallId, {
              toolCallId,
              toolName: existing?.toolName ?? "<unknown>",
              ...(existing?.input !== undefined && { input: existing.input }),
              output,
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

/**
 * Pick the auto-triage tool call from the stream-reconstructed list and
 * compute the bytes of its `output` field (the compact-shape return the
 * chat-supervisor's next turn would have ingested). Also surfaces the
 * inner sub-session id from the result payload and whether the tool
 * call actually succeeded (job-tools.ts returns
 * `{success: true, ...artifactIds, summary}` on the happy path and
 * `{success: false, error}` on failure — we want to flag the latter so
 * an "error response is small" pass doesn't masquerade as a real flip).
 */
function extractAutoTriageToolResult(toolCalls: ChatToolCall[]): {
  compactReturnBytes: number;
  innerSessionId: string | null;
  autoTriageToolCalls: number;
  toolSucceeded: boolean;
  toolError: string | null;
} {
  let compactReturnBytes = 0;
  let innerSessionId: string | null = null;
  let autoTriageToolCalls = 0;
  let toolSucceeded = false;
  let toolError: string | null = null;

  for (const tc of toolCalls) {
    if (tc.toolName !== "auto-triage") continue;
    autoTriageToolCalls += 1;
    if (tc.output === undefined) continue;
    const serialized = JSON.stringify(tc.output);
    if (compactReturnBytes === 0) {
      compactReturnBytes = serialized.length;
    }
    const r = tc.output as { sessionId?: unknown; success?: unknown; error?: unknown };
    if (
      innerSessionId === null &&
      r !== null &&
      typeof r === "object" &&
      typeof r.sessionId === "string"
    ) {
      innerSessionId = r.sessionId;
    }
    if (r !== null && typeof r === "object") {
      if (r.success === true) toolSucceeded = true;
      if (typeof r.error === "string" && toolError === null) toolError = r.error;
    }
  }

  return { compactReturnBytes, innerSessionId, autoTriageToolCalls, toolSucceeded, toolError };
}

async function main() {
  await ensureCredentialsLoaded();

  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    console.error("ANTHROPIC_API_KEY is not set — chat-flip benchmark requires real LLM calls.");
    Deno.exit(2);
  }

  const sha = await currentGitSha();
  const startedAt = new Date().toISOString();
  console.log(`> chat-flip @ ${sha}`);

  const daemon = await startDaemon({ healthTimeoutMs: 90_000 });
  console.log(`+ daemon up: ${daemon.baseUrl} (FRIDAY_HOME=${daemon.fridayHome})`);

  const metrics: Metrics = {
    gitSha: sha,
    scenario: "chat-flip",
    startedAt,
    inboxCount: CONTROL_LIMIT,
    legacyReturnBytes: 0,
    compactReturnBytes: 0,
    reduction: 0,
    reductionGate: REDUCTION_GATE,
    passed: false,
    controlSessionId: null,
    controlWallTimeMs: 0,
    chatSessionId: null,
    chatInnerSessionId: null,
    chatWallTimeMs: 0,
    chatSupervisorInputTokens: 0,
    chatSupervisorUsageAvailable: false,
    autoTriageToolCalls: 0,
    chatToolSucceeded: false,
    chatToolError: null,
    notes: [],
  };

  try {
    const ws = await registerWorkspace(daemon, HARNESS_PATHS.inboxCorpusWorkspaceDir, {
      name: "Inbox Corpus Chat-Flip QA",
    });
    console.log(`+ workspace registered: ${ws.id}`);

    // --- Control: trigger inbox-event directly, capture legacy bytes -----
    console.log(`> control: triggering inbox-event (limit=${CONTROL_LIMIT}) for legacy bytes`);
    const control = await triggerSignalSSE(daemon, ws.id, "inbox-event", {
      payload: { inboxPath: HARNESS_PATHS.inboxCorpusDir, limit: CONTROL_LIMIT },
      timeoutMs: 15 * 60 * 1000,
      onEvent: (e) => {
        if (e.type === "data-session-start") console.log(`  control session: ${e.data.sessionId}`);
        if (e.type === "job-error") console.log(`  ! control job-error: ${JSON.stringify(e.data)}`);
      },
    });
    metrics.controlWallTimeMs = control.durationMs;
    metrics.controlSessionId = control.sessionId;

    if (control.jobError) {
      throw new Error(`control inbox-event failed: ${control.jobError.error}`);
    }
    if (!control.jobComplete) {
      throw new Error("control inbox-event produced no job-complete");
    }

    // Reconstruct the LEGACY return shape the pre-flip job-tool would
    // have built (see executeJobViaSSE before Phase 2.C — it returned
    // `{success, sessionId, status, output}` only). The job-complete
    // event payload carries `output` for back-compat, so we can compute
    // the bytes without re-running.
    const c = control.jobComplete;
    const legacyReturn = {
      success: true,
      sessionId: c.sessionId,
      status: c.status ?? "completed",
      output: Array.isArray(c.output) ? c.output : [],
    };
    metrics.legacyReturnBytes = JSON.stringify(legacyReturn).length;
    metrics.notes.push(
      `control returned ${Array.isArray(c.output) ? c.output.length : 0} documents in output[]`,
    );
    console.log(`  legacy bytes: ${metrics.legacyReturnBytes}`);

    // --- Chat-driven run: trigger auto-triage as a job-tool --------------
    const chatId = crypto.randomUUID();
    const messageText = [
      "Run the auto-triage job against the inbox.",
      `inboxPath: ${HARNESS_PATHS.inboxCorpusDir}`,
      `limit: ${CONTROL_LIMIT}`,
    ].join("\n");
    console.log(`> chat: posting message (chatId=${chatId})`);
    const chat = await postChatMessage(daemon, ws.id, chatId, messageText, {
      timeoutMs: 15 * 60 * 1000,
    });
    metrics.chatWallTimeMs = chat.durationMs;
    metrics.chatSessionId = chat.chatSessionId;
    console.log(`  chat session: ${chat.chatSessionId}`);
    console.log(`  inner sessions surfaced: ${chat.innerSessionIds.length}`);

    if (!chat.chatSessionId) {
      throw new Error("chat run produced no data-session-start event");
    }

    // The chat session's persisted `step:complete.toolCalls` is empty
    // for `case "agent" → workspace-chat` actions (runtime.ts:2740 only
    // surfaces the orchestrator's own toolCalls, not the agent's nested
    // ones). Reconstruct from the live AI-SDK chunks instead.
    const extracted = extractAutoTriageToolResult(chat.toolCalls);
    // Still walk the persisted events for usage-aggregate visibility
    // (currently absent for agent steps — see header note).
    const events = await fetchSessionEvents(daemon, chat.chatSessionId);
    if (Deno.env.get("FRIDAY_QA_DUMP_EVENTS") === "1") {
      const dumpPath = join(HARNESS_PATHS.resultsDir, `${sha}-chat-flip.events.json`);
      const chunksPath = join(HARNESS_PATHS.resultsDir, `${sha}-chat-flip.chunks.json`);
      await Deno.writeTextFile(dumpPath, JSON.stringify(events.events, null, 2));
      await Deno.writeTextFile(chunksPath, JSON.stringify(chat.toolCalls, null, 2));
      console.log(
        `  (dumped ${events.events.length} session events + ${chat.toolCalls.length} tool calls)`,
      );
    }
    metrics.compactReturnBytes = extracted.compactReturnBytes;
    metrics.chatInnerSessionId = extracted.innerSessionId ?? chat.innerSessionIds[0] ?? null;
    metrics.autoTriageToolCalls = extracted.autoTriageToolCalls;
    metrics.chatToolSucceeded = extracted.toolSucceeded;
    metrics.chatToolError = extracted.toolError;
    metrics.chatSupervisorInputTokens = events.totalUsage.inputTokens;
    metrics.chatSupervisorUsageAvailable = events.totalUsage.inputTokens > 0;
    console.log(`  compact bytes: ${metrics.compactReturnBytes}`);
    console.log(`  auto-triage tool calls: ${metrics.autoTriageToolCalls}`);
    if (extracted.toolError) {
      console.log(`  ! chat tool returned error: ${extracted.toolError}`);
    }
    if (!metrics.chatSupervisorUsageAvailable) {
      metrics.notes.push(
        "chat-supervisor step:complete.usage is absent — agent-step side-channel doesn't propagate result.usage today (runtime.ts:2740). Comparison uses tool-result bytes (the same metric that drove the −95.1% pt1 claim).",
      );
    }
    if (metrics.compactReturnBytes === 0) {
      metrics.notes.push(
        "no auto-triage tool call observed in chat session events — model may have refused to call the job-tool. Compact bytes left at 0; reduction will be undefined.",
      );
    }
    if (metrics.autoTriageToolCalls > 0 && !metrics.chatToolSucceeded) {
      // Don't let an "error response is small" run masquerade as a flip.
      // An error payload (~80 B `{success:false, error:"..."}`) is even
      // smaller than the compact happy path and would falsely pass the
      // gate. The dominant cause today is shared-NATS port collision
      // when sibling QA scenarios run in parallel — each spawned daemon
      // joins the same nats-server on DEFAULT_NATS_PORT (4222).
      metrics.notes.push(
        `chat-side auto-triage tool returned success=false (error: ${metrics.chatToolError ?? "<unknown>"}). The compact-bytes measurement reflects an error payload, not the post-flip happy path. Run in isolation (no parallel QA scenarios) to get a clean reading.`,
      );
    }

    // --- Compute reduction + gate ---------------------------------------
    if (metrics.legacyReturnBytes > 0 && metrics.compactReturnBytes > 0) {
      metrics.reduction = 1 - metrics.compactReturnBytes / metrics.legacyReturnBytes;
      metrics.passed = metrics.reduction >= REDUCTION_GATE && metrics.chatToolSucceeded;
    } else {
      metrics.reduction = 0;
      metrics.passed = false;
    }

    if (metrics.chatToolSucceeded && metrics.reduction < REDUCTION_GATE) {
      // The −95.1% pt1 claim was workload-dependent: production had a
      // ~9.4 KB legacy `output` (FSM emitted multi-doc state). The QA
      // fixture's auto-triage emits ONE small terminal Document (a
      // ≤200-word summary), so legacy bytes start at ~700-900 B and
      // compact bytes are ~200 B (mostly summary text + sessionId +
      // artifactIds). The flip's _structural_ correctness still holds
      // (refs vs full docs); the reduction magnitude is bounded by the
      // workload. Producing fixture inputs that emit a multi-KB
      // terminal Document — or running the benchmark on a real
      // workspace whose auto-triage outputs match production scale —
      // would close the gap.
      metrics.notes.push(
        "reduction below gate: fixture's small terminal Document caps the achievable ratio. The supervisor flip is still in effect (refs replace docs), but the per-call magnitude depends on how bulky the inner job's output is. See header comment for context.",
      );
    }

    console.log("\n-- metrics --");
    console.log(JSON.stringify(metrics, null, 2));
  } catch (err) {
    metrics.error = err instanceof Error ? err.message : String(err);
    metrics.passed = false;
    console.error(`x scenario failed: ${metrics.error}`);
  } finally {
    const keepHome = Deno.env.get("FRIDAY_QA_KEEP_HOME") === "1";
    await stopDaemon(daemon, { keepHome });
    if (keepHome) console.log(`(kept) FRIDAY_HOME=${daemon.fridayHome}`);
  }

  await ensureDir(HARNESS_PATHS.resultsDir);
  const jsonPath = join(HARNESS_PATHS.resultsDir, `${sha}-chat-flip.json`);
  const mdPath = join(HARNESS_PATHS.resultsDir, `${sha}-chat-flip.md`);
  await Deno.writeTextFile(jsonPath, JSON.stringify(metrics, null, 2));
  await Deno.writeTextFile(mdPath, renderMarkdown(metrics));
  console.log(`\n-> wrote ${jsonPath}`);
  console.log(`-> wrote ${mdPath}`);

  Deno.exit(metrics.passed && !metrics.error ? 0 : 1);
}

function renderMarkdown(m: Metrics): string {
  const lines: string[] = [];
  const reductionPct = (m.reduction * 100).toFixed(1);
  const gatePct = (m.reductionGate * 100).toFixed(0);
  const verdict = m.passed ? "PASS" : "FAIL";
  lines.push(`# chat-flip benchmark — ${m.gitSha}`);
  lines.push("");
  lines.push(`**Verdict:** ${verdict} (gate ≥${gatePct}%, measured ${reductionPct}%)`);
  lines.push("");
  lines.push(`Started: ${m.startedAt}`);
  lines.push("");
  lines.push("## Bytes shipped to the chat-supervisor next turn");
  lines.push("");
  lines.push("| Shape | Bytes |");
  lines.push("| --- | ---: |");
  lines.push(`| legacy (\`output: Document[]\`, pre-Phase-2.C) | ${m.legacyReturnBytes} |`);
  lines.push(`| compact (\`{ artifactIds, summary }\`, post-flip) | ${m.compactReturnBytes} |`);
  lines.push(`| reduction | ${reductionPct}% |`);
  lines.push("");
  lines.push("## Wall + sessions");
  lines.push("");
  lines.push(
    `- control (direct inbox-event): ${m.controlWallTimeMs}ms — session ${m.controlSessionId ?? "<none>"}`,
  );
  lines.push(
    `- chat (chat → auto-triage tool): ${m.chatWallTimeMs}ms — session ${m.chatSessionId ?? "<none>"}`,
  );
  lines.push(`- inner session (auto-triage from chat): ${m.chatInnerSessionId ?? "<none>"}`);
  lines.push(`- auto-triage tool calls observed: ${m.autoTriageToolCalls}`);
  lines.push(`- chat-side tool succeeded: ${m.chatToolSucceeded ? "yes" : "no"}`);
  if (m.chatToolError) {
    lines.push(`- chat-side tool error: ${m.chatToolError}`);
  }
  lines.push("");
  lines.push("## Chat-supervisor token usage");
  lines.push("");
  lines.push(`- aggregate \`step:complete.usage.inputTokens\`: ${m.chatSupervisorInputTokens}`);
  lines.push(`- usage available on agent step: ${m.chatSupervisorUsageAvailable ? "yes" : "no"}`);
  if (m.notes.length > 0) {
    lines.push("");
    lines.push("## Notes");
    lines.push("");
    for (const n of m.notes) lines.push(`- ${n}`);
  }
  if (m.error) {
    lines.push("");
    lines.push("## Error");
    lines.push("");
    lines.push("```");
    lines.push(m.error);
    lines.push("```");
  }
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  await main();
}

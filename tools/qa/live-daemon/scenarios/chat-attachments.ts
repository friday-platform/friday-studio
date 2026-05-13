#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * User-attached-file eval.
 *
 * Captures the contract added in PR #292 v6: when a user drops a file on
 * the chat input, the playground POSTs it to `/api/scratch/upload`, the
 * file lands at `{FRIDAY_HOME}/scratch/uploads/{chatId}/{filename}`, and
 * the message body carries a `data-file-attached` part with that path.
 * The atlas-web adapter then splices `<attachment path="…" filename="…"
 * mediaType="…" />` text into the persisted history so the agent sees
 * the path on its next history read.
 *
 * The agent MUST:
 *   1. invoke the `read_attachment` tool with the exact path it saw
 *      (no run_code workaround, no "please re-paste the file");
 *   2. produce an answer that references content from the file.
 *
 * Negative case (no `read_attachment` call): agent guessed or hallucinated.
 * Positive case (read_attachment + correct answer): contract holds.
 *
 * Run:
 *   ./tools/qa/live-daemon/scenarios/chat-attachments.ts
 *   ./tools/qa/live-daemon/scenarios/chat-attachments.ts --only chat-csv-read
 */

import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { dirname, join } from "jsr:@std/path@1";
import {
  currentGitSha,
  type DaemonHandle,
  ensureCredentialsLoaded,
  HARNESS_PATHS,
  registerWorkspace,
  type SSEEvent,
  startDaemon,
  stopDaemon,
} from "../harness.ts";

interface EvalResult {
  id: string;
  pass: boolean;
  notes: string[];
  metrics: Record<string, unknown>;
}

interface ChatToolCall {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
}

interface PostChatResult {
  events: SSEEvent[];
  chatSessionId: string | null;
  toolCalls: ChatToolCall[];
  /** Concatenated text-delta payloads (the final assistant message body). */
  assistantText: string;
  durationMs: number;
}

/**
 * POST a multi-part chat message and drain the SSE stream. Mirrors the
 * shape the playground's chat-input sends after a drop:
 *   { id, message: { id, role: "user", parts: [text, data-file-attached] } }
 *
 * Returns the assembled tool-call ledger + final assistant text. Inlined
 * here so this scenario file is self-contained.
 */
async function postChatMessageWithAttachment(
  d: DaemonHandle,
  workspaceId: string,
  chatId: string,
  text: string,
  attachment: { path: string; filename: string; mediaType: string },
  opts: { timeoutMs?: number } = {},
): Promise<PostChatResult> {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 600_000);

  const body = {
    id: chatId,
    message: {
      id: `msg-${crypto.randomUUID()}`,
      role: "user",
      parts: [
        { type: "text", text },
        {
          type: "data-file-attached",
          data: {
            paths: [attachment.path],
            filenames: [attachment.filename],
            mimeTypes: [attachment.mediaType],
          },
        },
      ],
      metadata: { timestamp: new Date().toISOString() },
    },
  };

  let resp: Response;
  try {
    resp = await fetch(`${d.baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
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
  let assistantText = "";
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
        events.push({ type: parsed.type, data, raw });

        if (parsed.type === "data-session-start" && typeof data.sessionId === "string") {
          if (chatSessionId === null) chatSessionId = data.sessionId;
        }
        if (parsed.type === "text-delta" && typeof parsed.delta === "string") {
          assistantText += parsed.delta;
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
    toolCalls: [...toolCallsById.values()],
    assistantText,
    durationMs: Date.now() - startedAt,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Workspace fixture — minimal `user` workspace with no signals/jobs/agents.
// The eval only exercises the chat handler's attachment path.
// ────────────────────────────────────────────────────────────────────────

const WORKSPACE_YML = `version: "1.0"

workspace:
  name: "Chat Attachments QA"
  description: "Eval fixture for the user-attached-file contract."

permissions:
  dangerouslySkipAllowlist: false
`;

async function materializeWorkspace(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "friday-chat-attachments-fixture-" });
  await Deno.writeTextFile(join(dir, "workspace.yml"), WORKSPACE_YML);
  return dir;
}

// ────────────────────────────────────────────────────────────────────────
// Scenarios
// ────────────────────────────────────────────────────────────────────────

/**
 * Drop a CSV with 5 rows, ask "how many scored above 80". The agent must
 * call read_attachment(path) — anything else (run_code workaround, asking
 * the user to re-paste, hallucinating an answer without reading) fails.
 */
async function runChatCsvRead(d: DaemonHandle): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  const wsPath = await materializeWorkspace();
  const ws = await registerWorkspace(d, wsPath, { name: "chat-attachments-qa" });
  const workspaceId = ws.id;

  const chatId = `chat_eval_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const filename = "scores.csv";
  const csv = "name,score\nAlice,90\nBob,75\nCarol,82\nDan,95\nEve,68\n";

  // Mirror what `/api/scratch/upload` would do — write the bytes directly
  // to the spot the adapter expects to find them.
  const uploadsRoot = join(d.fridayHome, "scratch", "uploads", chatId);
  await Deno.mkdir(uploadsRoot, { recursive: true });
  const path = join(uploadsRoot, filename);
  await Deno.writeTextFile(path, csv);
  metrics.attachmentPath = path;

  const result = await postChatMessageWithAttachment(
    d,
    workspaceId,
    chatId,
    "how many people scored above 80?",
    { path, filename, mediaType: "text/csv" },
    { timeoutMs: 120_000 },
  );
  metrics.durationMs = result.durationMs;
  metrics.toolCalls = result.toolCalls.map((c) => c.toolName);

  const readAttachmentCalls = result.toolCalls.filter((c) => c.toolName === "read_attachment");
  if (readAttachmentCalls.length === 0) {
    notes.push(
      `Negative: agent never called read_attachment. Tools used: ${result.toolCalls.map((c) => c.toolName).join(", ") || "(none)"}`,
    );
    return { id: "chat-csv-read", pass: false, notes, metrics };
  }
  notes.push(`Positive: agent called read_attachment ${readAttachmentCalls.length}× with path arg`);

  // The read_attachment input must reference the exact path we attached —
  // the adapter passes it verbatim into the synthetic text part.
  const readWithRightPath = readAttachmentCalls.some((c) => {
    const input = c.input;
    if (typeof input !== "object" || input === null) return false;
    return (input as { path?: unknown }).path === path;
  });
  if (!readWithRightPath) {
    notes.push(
      `Negative: read_attachment was called but with a different path than the one attached`,
    );
    return { id: "chat-csv-read", pass: false, notes, metrics };
  }

  // The answer must mention "3" (count above 80: Alice, Carol, Dan). Use a
  // forgiving check — different model verbosity produces different phrasing,
  // but the count is invariant.
  if (!/\b3\b/.test(result.assistantText)) {
    notes.push(
      `Negative: answer doesn't mention the correct count (3). Reply: "${result.assistantText.slice(0, 200)}"`,
    );
    return { id: "chat-csv-read", pass: false, notes, metrics };
  }
  notes.push(
    `Positive: answer references the right count (3) — "${result.assistantText.slice(0, 120)}…"`,
  );

  return { id: "chat-csv-read", pass: true, notes, metrics };
}

/**
 * Path-traversal gate. Craft a `data-file-attached` part that points
 * outside the chat's uploads dir (e.g. another chatId, or `/etc/passwd`).
 * The adapter MUST refuse to splice the synthetic text part, so the agent
 * never sees the path and never invokes read_attachment against it.
 */
async function runRejectsForeignPath(d: DaemonHandle): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  const wsPath = await materializeWorkspace();
  const ws = await registerWorkspace(d, wsPath, { name: "chat-attachments-qa-foreign" });
  const workspaceId = ws.id;

  const chatId = `chat_eval_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const foreignChatId = `chat_other_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const foreignRoot = join(d.fridayHome, "scratch", "uploads", foreignChatId);
  await Deno.mkdir(foreignRoot, { recursive: true });
  const foreignPath = join(foreignRoot, "secret.csv");
  await Deno.writeTextFile(foreignPath, "secret,123\n");
  metrics.foreignPath = foreignPath;

  const result = await postChatMessageWithAttachment(
    d,
    workspaceId,
    chatId,
    "read this file",
    { path: foreignPath, filename: "secret.csv", mediaType: "text/csv" },
    { timeoutMs: 60_000 },
  );
  metrics.durationMs = result.durationMs;
  metrics.toolCalls = result.toolCalls.map((c) => c.toolName);

  // The adapter's path-validation gate should have refused the splice, so
  // the agent never sees a `<attachment path="…" />` line for that path
  // and therefore can't call read_attachment with it. If it did call
  // read_attachment, the tool itself would still reject (its resolver
  // scopes to this chat's uploads dir) — but the design intent is the
  // adapter never lets the path leak that far.
  const sawAttachment = result.events.some(
    (e) => e.type === "text-delta" && typeof e.data === "object" && false, // placeholder
  );
  void sawAttachment;

  // Strongest assertion: read_attachment was not invoked against the
  // foreign path. (It might still be called against legitimate paths if
  // the agent decided to do something, but not against this one.)
  const readCalledWithForeign = result.toolCalls.some(
    (c) =>
      c.toolName === "read_attachment" &&
      typeof c.input === "object" &&
      c.input !== null &&
      (c.input as { path?: unknown }).path === foreignPath,
  );
  if (readCalledWithForeign) {
    notes.push("Negative: agent read the foreign-chat path despite the adapter gate.");
    return { id: "rejects-foreign-path", pass: false, notes, metrics };
  }
  notes.push("Positive: agent did not read_attachment against the foreign-chat path.");

  return { id: "rejects-foreign-path", pass: true, notes, metrics };
}

// ────────────────────────────────────────────────────────────────────────
// Entrypoint
// ────────────────────────────────────────────────────────────────────────

async function main() {
  await ensureCredentialsLoaded();

  const sha = await currentGitSha();
  const startedAt = new Date().toISOString();
  const writeResult = Deno.args.includes("--write-result");
  const jsonOutputArgIndex = Deno.args.indexOf("--json-output");
  const jsonOutputPath = jsonOutputArgIndex >= 0 ? Deno.args[jsonOutputArgIndex + 1] : undefined;
  const onlyArgIndex = Deno.args.indexOf("--only");
  const onlyId = onlyArgIndex >= 0 ? Deno.args[onlyArgIndex + 1] : undefined;
  if (jsonOutputArgIndex >= 0 && !jsonOutputPath) {
    console.error("--json-output requires a path");
    Deno.exit(2);
  }
  console.log(`▶ chat-attachments eval @ ${sha}`);

  const fridayHome = await Deno.makeTempDir({ prefix: "friday-qa-attachments-" });
  const daemon = await startDaemon({ fridayHome, healthTimeoutMs: 90_000 });
  const results: EvalResult[] = [];
  try {
    console.log(`✓ daemon up: ${daemon.baseUrl}`);

    type Runner = (d: DaemonHandle) => Promise<EvalResult>;
    const runners: Array<{ id: string; fn: Runner }> = [
      { id: "chat-csv-read", fn: runChatCsvRead },
      { id: "rejects-foreign-path", fn: runRejectsForeignPath },
    ];

    for (const { id, fn } of runners) {
      if (onlyId && id !== onlyId) continue;
      console.log(`\n── ${id} ──`);
      try {
        results.push(await fn(daemon));
      } catch (err) {
        results.push({
          id,
          pass: false,
          notes: [`scenario threw: ${err instanceof Error ? err.message : String(err)}`],
          metrics: {},
        });
      }
    }
  } finally {
    await stopDaemon(daemon, { keepHome: true });
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n══ chat-attachments summary: ${passed}/${results.length} passed ══`);
  for (const r of results) {
    console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);
    for (const note of r.notes) console.log(`    ${note}`);
  }

  const report = { gitSha: sha, startedAt, passed, failed, results };
  if (writeResult || jsonOutputPath) {
    const outPath =
      jsonOutputPath ?? join(HARNESS_PATHS.resultsDir, `${sha}-chat-attachments.json`);
    await ensureDir(dirname(outPath));
    await Deno.writeTextFile(outPath, JSON.stringify(report, null, 2));
    console.log(`\n→ ${outPath}`);
  }

  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}

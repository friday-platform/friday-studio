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
import { createHash } from "node:crypto";
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
interface AttachmentDescriptor {
  path: string;
  filename: string;
  mediaType: string;
}

async function postChatMessageWithAttachment(
  d: DaemonHandle,
  workspaceId: string,
  chatId: string,
  text: string,
  attachment: AttachmentDescriptor | AttachmentDescriptor[],
  opts: { timeoutMs?: number } = {},
): Promise<PostChatResult> {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 600_000);

  const list = Array.isArray(attachment) ? attachment : [attachment];
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
            paths: list.map((a) => a.path),
            filenames: list.map((a) => a.filename),
            mimeTypes: list.map((a) => a.mediaType),
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

/**
 * Mirror `apps/atlasd/routes/scratch-upload.ts`'s content-addressed
 * storage layout: bytes land at `{uploadsRoot}/{md5(bytes)}` regardless of
 * the original filename. Scenarios skip the HTTP upload and write
 * directly, but the path the agent eventually sees in the
 * `<attachment path="…">` tag MUST match production exactly — otherwise
 * the eval drifts from real-world behavior and a path-shape regression
 * could ship.
 */
async function writeAttachmentBytes(
  uploadsRoot: string,
  content: Uint8Array | string,
): Promise<string> {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const md5 = createHash("md5").update(bytes).digest("hex");
  await Deno.mkdir(uploadsRoot, { recursive: true });
  const path = join(uploadsRoot, md5);
  await Deno.writeFile(path, bytes);
  return path;
}

// ────────────────────────────────────────────────────────────────────────
// Routing helper — collapses the "drop a file, observe which tool the
// agent picked" pattern that 80% of these scenarios share. Each scenario
// declares: the file content + mediaType (the routing signal), the
// question to ask, and the assertions about which tools must / must not
// be called with this attachment's path. Plus optional regex checks on
// the assistant answer.
// ────────────────────────────────────────────────────────────────────────

interface RoutingExpectation {
  id: string;
  workspaceName: string;
  filename: string;
  content: Uint8Array | string;
  mediaType: string;
  question: string;
  /** Tool names — at least ONE must appear somewhere in the agent's tool calls. */
  mustCallSome?: string[];
  /** Tool names that must NOT be called with this attachment's path as input. */
  mustNotCallWithPath?: string[];
  /** Assistant answer must match this regex (used for content-extraction checks). */
  answerMustMatch?: RegExp;
  /** Assistant answer must NOT match this regex (used for guardrails — e.g. "please re-upload"). */
  answerMustNotMatch?: RegExp;
  timeoutMs?: number;
}

async function runRoutingExpectation(
  d: DaemonHandle,
  exp: RoutingExpectation,
): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  const wsPath = await materializeWorkspace();
  const ws = await registerWorkspace(d, wsPath, { name: exp.workspaceName });
  const workspaceId = ws.id;

  const chatId = `chat_eval_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const uploadsRoot = join(d.fridayHome, "scratch", "uploads", chatId);
  const path = await writeAttachmentBytes(uploadsRoot, exp.content);
  metrics.attachmentPath = path;
  metrics.mediaType = exp.mediaType;

  const result = await postChatMessageWithAttachment(
    d,
    workspaceId,
    chatId,
    exp.question,
    { path, filename: exp.filename, mediaType: exp.mediaType },
    { timeoutMs: exp.timeoutMs ?? 180_000 },
  );
  metrics.durationMs = result.durationMs;
  metrics.toolCalls = result.toolCalls.map((c) => c.toolName);
  metrics.assistantText = result.assistantText.slice(0, 250);

  // Negative: agent must NOT have called any of these tools WITH THIS PATH.
  // (The agent might still use them on something else — e.g. read_attachment
  // on a DIFFERENT path during run_code-style multi-step work. We only
  // forbid the specific routing for THIS attachment.)
  if (exp.mustNotCallWithPath?.length) {
    for (const toolName of exp.mustNotCallWithPath) {
      const sneakyCall = result.toolCalls.some(
        (c) =>
          c.toolName === toolName &&
          typeof c.input === "object" &&
          c.input !== null &&
          (c.input as { path?: unknown }).path === path,
      );
      if (sneakyCall) {
        notes.push(
          `Negative: agent called ${toolName} with the attachment path — that's the forbidden routing for mediaType=${exp.mediaType}.`,
        );
        return { id: exp.id, pass: false, notes, metrics };
      }
    }
    notes.push(
      `Positive: agent did NOT call ${exp.mustNotCallWithPath.join(" / ")} with the attachment path.`,
    );
  }

  // Positive: at least one of the listed tools was called somewhere.
  if (exp.mustCallSome?.length) {
    const matched = result.toolCalls.filter((c) => exp.mustCallSome?.includes(c.toolName));
    if (matched.length === 0) {
      notes.push(
        `Negative: agent didn't call any of [${exp.mustCallSome.join(", ")}]. Tools used: ${result.toolCalls.map((c) => c.toolName).join(", ") || "(none)"}.`,
      );
      return { id: exp.id, pass: false, notes, metrics };
    }
    notes.push(
      `Positive: agent called ${[...new Set(matched.map((c) => c.toolName))].join(", ")}.`,
    );
  }

  // Positive content extraction — answer must reference something in the file.
  if (exp.answerMustMatch) {
    if (!exp.answerMustMatch.test(result.assistantText)) {
      notes.push(
        `Negative: answer doesn't match ${exp.answerMustMatch}. Reply: "${result.assistantText.slice(0, 250)}"`,
      );
      return { id: exp.id, pass: false, notes, metrics };
    }
    notes.push(`Positive: answer matches ${exp.answerMustMatch}.`);
  }

  // Negative guardrail — answer must NOT match a forbidden pattern
  // (e.g. "please paste the contents" / "I can't open this file").
  if (exp.answerMustNotMatch) {
    if (exp.answerMustNotMatch.test(result.assistantText)) {
      notes.push(
        `Negative: answer matched the forbidden pattern ${exp.answerMustNotMatch}. Reply: "${result.assistantText.slice(0, 250)}"`,
      );
      return { id: exp.id, pass: false, notes, metrics };
    }
    notes.push(`Positive: answer does NOT match the forbidden pattern ${exp.answerMustNotMatch}.`);
  }

  return { id: exp.id, pass: true, notes, metrics };
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
  // to the spot the adapter expects to find them, using the same
  // content-addressed (md5) on-disk filename.
  const uploadsRoot = join(d.fridayHome, "scratch", "uploads", chatId);
  const path = await writeAttachmentBytes(uploadsRoot, csv);
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
  const foreignPath = await writeAttachmentBytes(foreignRoot, "secret,123\n");
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

/**
 * PDF routing — locks the `prompt.txt` guidance that PDFs MUST go through
 * `parse_artifact`/`create_artifact`/`run_code` instead of `read_attachment`
 * (binary bytes corrupted as UTF-8 would blow up the prompt).
 *
 * Negative case: agent calls `read_attachment` on a PDF path → fail.
 *   This is the regression the prompt edit specifically prevents — without
 *   that nudge the agent will happily call `read_attachment` because the
 *   tool's description doesn't forbid binary.
 * Positive case: agent reaches for the right tool — any of
 *   `create_artifact`, `parse_artifact`, `display_artifact`, or `run_code`.
 *   The exact path doesn't matter (different models pick differently); what
 *   matters is the model rejects the "just read_attachment it" path.
 */
async function runPdfRoutesToParseNotReadAttachment(d: DaemonHandle): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  const wsPath = await materializeWorkspace();
  const ws = await registerWorkspace(d, wsPath, { name: "chat-attachments-qa-pdf" });
  const workspaceId = ws.id;

  const chatId = `chat_eval_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const filename = "report.pdf";
  // Minimal valid PDF — enough for any reader to identify the magic
  // header. We don't care about extracted content for this eval, only
  // about which tool the agent picks based on mediaType.
  const minimalPdf = new TextEncoder().encode(
    [
      "%PDF-1.4",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj",
      "xref",
      "0 4",
      "0000000000 65535 f",
      "0000000009 00000 n",
      "0000000052 00000 n",
      "0000000101 00000 n",
      "trailer<</Size 4/Root 1 0 R>>",
      "startxref",
      "148",
      "%%EOF",
      "",
    ].join("\n"),
  );

  const uploadsRoot = join(d.fridayHome, "scratch", "uploads", chatId);
  const path = await writeAttachmentBytes(uploadsRoot, minimalPdf);
  metrics.attachmentPath = path;

  const result = await postChatMessageWithAttachment(
    d,
    workspaceId,
    chatId,
    "give me a one-line summary of what this PDF is about",
    { path, filename, mediaType: "application/pdf" },
    { timeoutMs: 180_000 },
  );
  metrics.durationMs = result.durationMs;
  metrics.toolCalls = result.toolCalls.map((c) => c.toolName);

  // Negative: read_attachment on the PDF path is the failure mode.
  const readAttachmentOnPdf = result.toolCalls.some(
    (c) =>
      c.toolName === "read_attachment" &&
      typeof c.input === "object" &&
      c.input !== null &&
      (c.input as { path?: unknown }).path === path,
  );
  if (readAttachmentOnPdf) {
    notes.push(
      `Negative: agent called read_attachment on a PDF path — would corrupt the prompt with binary bytes. ` +
        `Prompt nudge ('PDF/DOCX/PPTX → DON'T read_attachment') regressed.`,
    );
    return { id: "pdf-routes-to-parse-not-read-attachment", pass: false, notes, metrics };
  }
  notes.push("Positive: agent did NOT call read_attachment on the PDF.");

  // Positive: agent reached for at least one of the right alternatives.
  // The prompt names parse_artifact + create_artifact specifically; run_code
  // (with a Python parser) is also acceptable per the prompt's last clause.
  const acceptableTools = new Set([
    "create_artifact",
    "parse_artifact",
    "display_artifact",
    "run_code",
    "save_artifact",
  ]);
  const acceptableCalls = result.toolCalls.filter((c) => acceptableTools.has(c.toolName));
  if (acceptableCalls.length === 0) {
    notes.push(
      `Negative: agent neither read_attachment'd (good) nor reached for a PDF-capable tool (bad). ` +
        `Tools used: ${result.toolCalls.map((c) => c.toolName).join(", ") || "(none)"}. ` +
        `Reply: "${result.assistantText.slice(0, 200)}"`,
    );
    return { id: "pdf-routes-to-parse-not-read-attachment", pass: false, notes, metrics };
  }
  notes.push(
    `Positive: agent picked a PDF-capable tool — ${acceptableCalls.map((c) => c.toolName).join(", ")}.`,
  );

  return { id: "pdf-routes-to-parse-not-read-attachment", pass: true, notes, metrics };
}

/**
 * Multi-file splice contract. The adapter's `inlineAttachedFiles` walks
 * `data-file-attached.paths` in order and emits one `<attachment …/>`
 * line per path inside a single synthetic text part. Drop two files at
 * once, ask a question that needs BOTH, and assert the agent called
 * `read_attachment` for each path.
 *
 * Negative: agent reads only one and hallucinates the other → fail.
 * Positive: agent reads both, answer references content from both.
 */
async function runMultiFileRead(d: DaemonHandle): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  const wsPath = await materializeWorkspace();
  const ws = await registerWorkspace(d, wsPath, { name: "chat-attachments-qa-multi" });
  const workspaceId = ws.id;

  const chatId = `chat_eval_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const uploadsRoot = join(d.fridayHome, "scratch", "uploads", chatId);
  const pathA = await writeAttachmentBytes(uploadsRoot, "name,score\nAlice,42\nBob,17\n");
  const pathB = await writeAttachmentBytes(uploadsRoot, "name,score\nCarol,99\nDan,8\n");
  metrics.paths = [pathA, pathB];

  const result = await postChatMessageWithAttachment(
    d,
    workspaceId,
    chatId,
    "what is the highest score across both teams? Show me the name and the number.",
    [
      { path: pathA, filename: "team-a.csv", mediaType: "text/csv" },
      { path: pathB, filename: "team-b.csv", mediaType: "text/csv" },
    ],
    { timeoutMs: 180_000 },
  );
  metrics.durationMs = result.durationMs;
  metrics.toolCalls = result.toolCalls.map((c) => c.toolName);

  const readCalls = result.toolCalls.filter((c) => c.toolName === "read_attachment");
  const readPaths = new Set(
    readCalls
      .map((c) =>
        typeof c.input === "object" && c.input !== null
          ? (c.input as { path?: unknown }).path
          : null,
      )
      .filter((p): p is string => typeof p === "string"),
  );
  metrics.readPaths = [...readPaths];

  if (!readPaths.has(pathA)) {
    notes.push(`Negative: agent never read team-a.csv (${pathA}).`);
    return { id: "multi-file-read", pass: false, notes, metrics };
  }
  if (!readPaths.has(pathB)) {
    notes.push(`Negative: agent never read team-b.csv (${pathB}).`);
    return { id: "multi-file-read", pass: false, notes, metrics };
  }
  notes.push("Positive: agent called read_attachment on BOTH attached paths.");

  // Highest score: Carol with 99. Answer must mention "Carol" AND "99".
  // Forgiving check — the agent might format as table, prose, or list.
  const mentionsCarol = /carol/i.test(result.assistantText);
  const mentions99 = /\b99\b/.test(result.assistantText);
  if (!mentionsCarol || !mentions99) {
    notes.push(
      `Negative: answer doesn't identify Carol (99) as the highest. mentionsCarol=${mentionsCarol}, mentions99=${mentions99}. ` +
        `Reply: "${result.assistantText.slice(0, 250)}"`,
    );
    return { id: "multi-file-read", pass: false, notes, metrics };
  }
  notes.push(
    `Positive: answer correctly identifies Carol (99) — "${result.assistantText.slice(0, 120)}…"`,
  );

  return { id: "multi-file-read", pass: true, notes, metrics };
}

// ────────────────────────────────────────────────────────────────────────
// Routing scenarios — one per format / branch the prompt distinguishes.
// Each declares a tiny RoutingExpectation that the helper drives.
// ────────────────────────────────────────────────────────────────────────

const MD_NOTES = `# Project Status

## Owners
- Alice (backend)
- Bob (frontend)
- Carol (infra)

## Blockers
None currently.
`;

const JSON_CONFIG = JSON.stringify(
  { version: "1.2.3", debug: false, database: { host: "primary.db.local", port: 5432, ssl: true } },
  null,
  2,
);

const YAML_CONFIG = `version: "1.2.3"
servers:
  - name: api
    port: 8421
  - name: worker
    port: 7777
secret_keyword: gabbro
`;

const HTML_PAGE = `<!doctype html><html><head><title>Onboarding</title></head><body>
<h1>Welcome new hire</h1><p>Your buddy: <strong>Lukasz</strong>.</p>
<ul><li>Slack: #team-friday</li><li>Repo: friday-studio</li></ul>
</body></html>`;

const LOG_FILE = [
  "2026-05-13T10:00:00Z INFO startup ok",
  "2026-05-13T10:00:05Z INFO connected to db",
  "2026-05-13T10:00:12Z ERROR auth refresh failed: token expired (correlationId=abc-42)",
  "2026-05-13T10:00:13Z INFO retry scheduled in 5s",
  "2026-05-13T10:00:18Z INFO auth refreshed ok",
].join("\n");

const PY_SCRIPT = `def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

# prints the 10th fibonacci number
print(fib(10))
`;

// 4-byte ZIP magic — enough to be a "DOCX/PPTX" file as far as the agent
// is concerned (the routing decision is on the mediaType, not the bytes).
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
// 8-byte PNG signature.
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// MP3 with an ID3v2 header tag (no actual audio frames — just enough that
// the file isn't empty and looks like audio to anyone inspecting bytes).
const MP3_MAGIC = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

const ROUTING_SCENARIOS: RoutingExpectation[] = [
  // ── text/markup positives ─────────────────────────────────────────────
  {
    id: "chat-md-read",
    workspaceName: "chat-attachments-qa-md",
    filename: "notes.md",
    content: MD_NOTES,
    mediaType: "text/markdown",
    question: "who owns infra?",
    mustCallSome: ["read_attachment"],
    answerMustMatch: /carol/i,
  },
  {
    id: "chat-json-extract",
    workspaceName: "chat-attachments-qa-json",
    filename: "config.json",
    content: JSON_CONFIG,
    mediaType: "application/json",
    question: "what database port is in this config?",
    mustCallSome: ["read_attachment"],
    answerMustMatch: /\b5432\b/,
  },
  {
    id: "chat-yaml-extract",
    workspaceName: "chat-attachments-qa-yaml",
    filename: "deploy.yml",
    content: YAML_CONFIG,
    mediaType: "application/x-yaml",
    question: "what's the value of secret_keyword?",
    mustCallSome: ["read_attachment"],
    answerMustMatch: /gabbro/i,
  },
  {
    id: "chat-html-read",
    workspaceName: "chat-attachments-qa-html",
    filename: "onboarding.html",
    content: HTML_PAGE,
    mediaType: "text/html",
    question: "who is the buddy in this onboarding doc?",
    mustCallSome: ["read_attachment"],
    answerMustMatch: /lukasz/i,
  },
  {
    id: "chat-log-grep",
    workspaceName: "chat-attachments-qa-log",
    filename: "app.log",
    content: LOG_FILE,
    mediaType: "text/plain",
    question: "what correlationId is on the ERROR line?",
    mustCallSome: ["read_attachment"],
    answerMustMatch: /abc-42/i,
  },
  // ── source code positive ──────────────────────────────────────────────
  {
    id: "chat-python-source",
    workspaceName: "chat-attachments-qa-py",
    filename: "fib.py",
    content: PY_SCRIPT,
    mediaType: "text/x-python",
    question: "what number does this script print to stdout?",
    mustCallSome: ["read_attachment"],
    // fib(10) = 55. The script comment also says "10th fibonacci".
    answerMustMatch: /\b55\b/,
  },
  // ── binary negatives (DOCX/PPTX mirror PDF) ───────────────────────────
  {
    id: "docx-routes-to-parse-not-read-attachment",
    workspaceName: "chat-attachments-qa-docx",
    filename: "spec.docx",
    content: ZIP_MAGIC,
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    question: "summarize this doc",
    mustNotCallWithPath: ["read_attachment"],
    mustCallSome: [
      "create_artifact",
      "parse_artifact",
      "display_artifact",
      "run_code",
      "save_artifact",
    ],
  },
  {
    id: "pptx-routes-to-parse-not-read-attachment",
    workspaceName: "chat-attachments-qa-pptx",
    filename: "deck.pptx",
    content: ZIP_MAGIC,
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    question: "what is this deck about?",
    mustNotCallWithPath: ["read_attachment"],
    mustCallSome: [
      "create_artifact",
      "parse_artifact",
      "display_artifact",
      "run_code",
      "save_artifact",
    ],
  },
  // ── image negative (prompt: images → create_artifact / display_artifact) ─
  {
    id: "image-not-read-via-attachment",
    workspaceName: "chat-attachments-qa-png",
    filename: "screenshot.png",
    content: PNG_MAGIC,
    mediaType: "image/png",
    question: "what's in this screenshot?",
    mustNotCallWithPath: ["read_attachment"],
  },
  // ── audio negative ────────────────────────────────────────────────────
  {
    id: "audio-not-read-via-attachment",
    workspaceName: "chat-attachments-qa-mp3",
    filename: "voicenote.mp3",
    content: MP3_MAGIC,
    mediaType: "audio/mpeg",
    question: "what's said in this audio?",
    mustNotCallWithPath: ["read_attachment"],
  },
  // ── prompt guardrail: never ask the user to re-upload / re-paste ──────
  {
    id: "agent-does-not-ask-user-to-reupload",
    workspaceName: "chat-attachments-qa-noreupload",
    filename: "answer.md",
    content: "# The answer\n\nThe answer to life, the universe, and everything is **42**.\n",
    mediaType: "text/markdown",
    question: "what's the answer in this file?",
    mustCallSome: ["read_attachment"],
    answerMustMatch: /\b42\b/,
    answerMustNotMatch:
      /\b(re-?upload|re-?paste|paste (the )?(contents?|file)|share (the )?(contents?|file)|can'?t (open|read|access))\b/i,
  },
];

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
      { id: "pdf-routes-to-parse-not-read-attachment", fn: runPdfRoutesToParseNotReadAttachment },
      { id: "multi-file-read", fn: runMultiFileRead },
      // Routing matrix — one entry per file-format branch the prompt
      // distinguishes. Each runs through `runRoutingExpectation`.
      ...ROUTING_SCENARIOS.map(({ id }) => ({
        id,
        fn: (d: DaemonHandle) => {
          const exp = ROUTING_SCENARIOS.find((e) => e.id === id);
          if (!exp) throw new Error(`routing scenario gone: ${id}`);
          return runRoutingExpectation(d, exp);
        },
      })),
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

#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * Chat job-tool routing eval.
 *
 * When a workspace declares a job triggered by an HTTP signal (e.g.
 * `reindex` → `reindex-knowledge-base`), `createJobTools()` (in
 * `packages/system/agents/workspace-chat/tools/job-tools.ts`) registers
 * that job as a callable tool on the workspace-chat agent. A user
 * asking "reindex the knowledge base" in chat MUST trigger that tool —
 * not fall back to `web_fetch` against an invented `/webhooks/reindex`
 * URL.
 *
 * Observed regression (2026-05-14 QA round): the chat agent issued
 * `web_fetch` against `http://localhost:3000/webhooks/reindex`, then
 * 3001, 3002, 8080. The job tool was registered (visible in the
 * AtlasAgentsMCPServer log) but the model bypassed it for an HTTP call
 * the prompt explicitly forbids for non-public endpoints (prompt.txt
 * line 52: "web_fetch is public internet only — internal API calls
 * must go through run_code with bash").
 *
 * Eval pair:
 *   - NEGATIVE (proves the bug): agent calls `web_fetch` and never
 *     calls `reindex-knowledge-base`. Fails this assertion on the
 *     pre-fix prompt.
 *   - POSITIVE (proves the fix): agent calls `reindex-knowledge-base`
 *     with no `web_fetch` to localhost. Passes after we add explicit
 *     steering to prompt.txt.
 *
 * Run:
 *   ./tools/qa/live-daemon/scenarios/chat-job-tool-routing.ts
 *   ./tools/qa/live-daemon/scenarios/chat-job-tool-routing.ts --only routes-to-job-tool
 */

import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import {
  currentGitSha,
  type DaemonHandle,
  ensureCredentialsLoaded,
  HARNESS_PATHS,
  makeFixtureDir,
  registerWorkspace,
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
  toolCalls: ChatToolCall[];
  assistantText: string;
  durationMs: number;
}

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..", "..", "..", "..");
const FIXTURE_DIR = join(ROOT, "tools/qa/fixtures/chat-job-tool-routing");

/**
 * POST a plain chat message and drain the SSE stream. Mirrors the chat-
 * attachments helper but trimmed to text-only (no `data-file-attached`).
 */
async function postChatMessage(
  d: DaemonHandle,
  workspaceId: string,
  chatId: string,
  text: string,
  opts: { timeoutMs?: number } = {},
): Promise<PostChatResult> {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 240_000);

  const body = {
    id: chatId,
    message: {
      id: `msg-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text }],
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
        let parsedRaw: unknown;
        try {
          parsedRaw = JSON.parse(raw);
        } catch {
          continue;
        }
        if (typeof parsedRaw !== "object" || parsedRaw === null) continue;
        const parsed: Record<string, unknown> = { ...parsedRaw };
        if (typeof parsed.type !== "string") continue;
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
    toolCalls: [...toolCallsById.values()],
    assistantText,
    durationMs: Date.now() - startedAt,
  };
}

/** True when the call is a `web_fetch` to a localhost / internal URL —
 * the exact failure mode observed in production QA. We don't forbid all
 * `web_fetch` here (the agent might legitimately use it for unrelated
 * reasoning); we only forbid the localhost-targeted ones. */
function extractUrl(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("url" in input)) return undefined;
  const url = input.url;
  return typeof url === "string" ? url : undefined;
}

function isLocalhostWebFetch(call: ChatToolCall): boolean {
  if (call.toolName !== "web_fetch") return false;
  const url = extractUrl(call.input);
  if (!url) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)\b|\/webhooks\//i.test(url);
}

async function runRoutesToJobTool(d: DaemonHandle): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  // Materialize the fixture INTO FRIDAY_HOME — manager.find() masks any
  // workspace whose path isn't under the active home (see manager.ts:
  // isUnderHome). Reading the static repo fixture directly would
  // register fine but then 404 on every subsequent lookup.
  const fixtureCopy = await makeFixtureDir(d.fridayHome, "chat-job-tool-routing-");
  await Deno.copyFile(join(FIXTURE_DIR, "workspace.yml"), join(fixtureCopy, "workspace.yml"));

  const ws = await registerWorkspace(d, fixtureCopy, { name: "chat-job-tool-routing-qa" });
  const workspaceId = ws.id;

  const chatId = `chat_eval_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  // Phrasing chosen to mirror the failing 2026-05-14 QA: an imperative
  // "trigger" verb plus the bare signal name, no surrounding context.
  // The pre-fix bug was that the model saw `<signals>reindex (POST
  // /webhooks/reindex)</signals>` in the workspace section and
  // web_fetched localhost:3000/webhooks/reindex (then 3001/3002/8080)
  // instead of calling the bound job tool.
  const result = await postChatMessage(
    d,
    workspaceId,
    chatId,
    "Hit the reindex webhook to rebuild the knowledge corpus.",
    { timeoutMs: 240_000 },
  );
  metrics.durationMs = result.durationMs;
  metrics.toolCalls = result.toolCalls.map((c) => ({ name: c.toolName, input: c.input }));
  metrics.assistantText = result.assistantText.slice(0, 250);

  // Negative — agent must NOT have web_fetched a localhost / webhook URL.
  // This is the exact failure mode logged in 2026-05-14 QA: web_fetch
  // against http://localhost:3000/webhooks/reindex (then 3001, 3002, 8080).
  const localhostFetches = result.toolCalls.filter(isLocalhostWebFetch);
  if (localhostFetches.length > 0) {
    notes.push(
      `Negative: agent called web_fetch ${localhostFetches.length}× against localhost / webhook URLs ` +
        `instead of using the registered job tool. URLs: ${localhostFetches
          .map((c) => extractUrl(c.input) ?? "?")
          .join(", ")}`,
    );
    return { id: "routes-to-job-tool", pass: false, notes, metrics };
  }
  notes.push("Positive: agent did NOT web_fetch any localhost/webhook URL.");

  // Positive — agent must have called the job tool exposed by createJobTools.
  // The tool name matches the job name verbatim (per job-tools.ts:118).
  const jobToolCalls = result.toolCalls.filter((c) => c.toolName === "reindex-knowledge-base");
  if (jobToolCalls.length === 0) {
    const allTools = result.toolCalls.map((c) => c.toolName).join(", ") || "(none)";
    notes.push(
      `Negative: agent did NOT call the registered \`reindex-knowledge-base\` tool. ` +
        `Tools used: ${allTools}. Reply: "${result.assistantText.slice(0, 200)}"`,
    );
    return { id: "routes-to-job-tool", pass: false, notes, metrics };
  }
  notes.push(`Positive: agent called \`reindex-knowledge-base\` ${jobToolCalls.length}×.`);

  return { id: "routes-to-job-tool", pass: true, notes, metrics };
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
  console.log(`▶ chat-job-tool-routing eval @ ${sha}`);

  const fridayHome = await Deno.makeTempDir({ prefix: "friday-qa-job-tool-routing-" });
  console.log(`✓ FRIDAY_HOME: ${fridayHome}`);
  const daemon = await startDaemon({ fridayHome, healthTimeoutMs: 90_000 });
  const results: EvalResult[] = [];
  try {
    console.log(`✓ daemon up: ${daemon.baseUrl}`);

    type Runner = (d: DaemonHandle) => Promise<EvalResult>;
    const runners: Array<{ id: string; fn: Runner }> = [
      { id: "routes-to-job-tool", fn: runRoutesToJobTool },
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
  console.log(`\n══ chat-job-tool-routing summary: ${passed}/${results.length} passed ══`);
  for (const r of results) {
    console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);
    for (const note of r.notes) console.log(`    ${note}`);
  }

  const report = { gitSha: sha, startedAt, passed, failed, results };
  if (writeResult || jsonOutputPath) {
    const outPath =
      jsonOutputPath ?? join(HARNESS_PATHS.resultsDir, `${sha}-chat-job-tool-routing.json`);
    await ensureDir(dirname(outPath));
    await Deno.writeTextFile(outPath, JSON.stringify(report, null, 2));
    console.log(`\n→ ${outPath}`);
  }

  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}

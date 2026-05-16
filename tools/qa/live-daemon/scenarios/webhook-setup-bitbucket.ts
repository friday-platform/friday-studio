#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * Webhook-setup (Bitbucket) eval.
 *
 * When a workspace exposes an HTTP signal meant to be fed by a Bitbucket
 * Cloud webhook (`provider: http`, `config.path: /...`), the user
 * typically asks in chat: "how do I configure Bitbucket to send events
 * here?". The chat agent MUST answer correctly — using the canonical
 * tunnel URL pattern, the right env var, the right signature header, the
 * embedded event allowlist, and the /status debugging shortcut.
 *
 * Observed regression (2026-05-15 chat dump vVf "Webhook URL Format",
 * 50 msgs): the chat agent invented `BITBUCKET_WEBHOOK_SECRET`
 * (the tunnel reads `WEBHOOK_SECRET` — config.go:60), wrote a
 * `~/.friday/local/webhook-mappings.json` with a schema-incompatible
 * shape (no `providers:` root key, `extract:` instead of `mapping:` —
 * collapsed providers list to just `[raw]`), then suggested
 * `/hook/raw/{ws}/{signal}` as a bypass — sidestepping both HMAC
 * verification and the per-provider event filtering. ~3 hours of user
 * pain that the right skill would have prevented.
 *
 * Eval pair:
 *   - NEGATIVE (proves the bug): without the wiring-external-webhooks
 *     skill, the agent's response misses or contradicts at least one of
 *     the contract points below.
 *   - POSITIVE (proves the fix): with the new skill in
 *     `<available_skills>`, the agent loads it and produces an answer
 *     that satisfies every contract point.
 *
 * Contract (lock these against pre-fix behavior):
 *   1. URL pattern includes `/hook/bitbucket/{workspaceId}/bitbucket-pipeline-failed`
 *      (or the exact rendered workspace id + signal name).
 *   2. Env var named `WEBHOOK_SECRET` (NOT `BITBUCKET_WEBHOOK_SECRET`).
 *   3. Header `x-hub-signature` (NOT `x-hub-signature-256` — that's GitHub).
 *   4. Mentions at least one event from the embedded allowlist
 *      (`pullrequest:created`, `pullrequest:updated`, `repo:push`).
 *   5. Mentions GET /status as the debugging shortcut.
 *   6. Does NOT suggest `BITBUCKET_WEBHOOK_SECRET`.
 *   7. Does NOT suggest writing a `webhook-mappings.json` file with the
 *      Marc-shape (top-level provider key without `providers:` wrapper,
 *      or `extract:` keys instead of `mapping:`).
 *   8. Does NOT suggest `/hook/raw/...` as a workaround.
 *
 * Run:
 *   ./tools/qa/live-daemon/scenarios/webhook-setup-bitbucket.ts
 *   ./tools/qa/live-daemon/scenarios/webhook-setup-bitbucket.ts --only explains-bitbucket-webhook-wiring
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
const FIXTURE_DIR = join(ROOT, "tools/qa/fixtures/webhook-setup-bitbucket");

/**
 * POST a plain chat message and drain the SSE stream. Mirrors the
 * chat-job-tool-routing helper — text + tool-call shapes only.
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

interface ContractCheck {
  id: string;
  description: string;
  pass: boolean;
  evidence?: string;
}

/**
 * Run all 8 contract checks against the assistant's full response text
 * plus its tool-call inputs/outputs (the agent might also have loaded a
 * skill, in which case we want the loaded content to count).
 */
function runContractChecks(
  text: string,
  workspaceId: string,
  signalName: string,
  toolCalls: ChatToolCall[],
): ContractCheck[] {
  const haystack = (
    text +
    "\n" +
    toolCalls
      .map((c) => JSON.stringify(c.input ?? {}) + "\n" + JSON.stringify(c.output ?? {}))
      .join("\n")
  ).toLowerCase();

  const has = (needle: string) => haystack.includes(needle.toLowerCase());
  // Match the URL pattern flexibly — agent may format it with backticks,
  // angle-brackets, or full https://...trycloudflare.com URL.
  const urlPatternRe = new RegExp(
    `/hook/bitbucket/(\\{workspaceid\\}|${workspaceId.toLowerCase()})/(\\{signalid\\}|${signalName.toLowerCase()})`,
  );
  return [
    {
      id: "url-pattern",
      description: `mentions /hook/bitbucket/{workspaceId}/${signalName}`,
      pass: urlPatternRe.test(haystack),
      evidence: urlPatternRe.exec(haystack)?.[0],
    },
    {
      id: "env-var",
      description: "names WEBHOOK_SECRET as the env var",
      pass: has("webhook_secret") && !/(?:BITBUCKET|GITHUB|JIRA)_WEBHOOK_SECRET/i.test(text),
      evidence: text.match(/[A-Z_]*WEBHOOK_SECRET[A-Z_]*/g)?.join(", "),
    },
    {
      id: "sig-header",
      description: "mentions x-hub-signature (not -256)",
      pass: has("x-hub-signature") && !/x-hub-signature-256/i.test(text),
      evidence: text.match(/x-hub-signature(-256)?/gi)?.join(", "),
    },
    {
      id: "event-allowlist",
      description: "mentions at least one embedded bitbucket event",
      pass: has("repo:push") || has("pullrequest:created") || has("pullrequest:updated"),
      evidence: ["repo:push", "pullrequest:created", "pullrequest:updated"]
        .filter((e) => has(e))
        .join(", "),
    },
    {
      id: "status-endpoint",
      description: "points at GET /status for debugging",
      pass: /\/status\b/.test(text),
      evidence: text.match(/[A-Z]+\s+[^\s]*\/status[^\s]*/)?.[0],
    },
    {
      id: "no-wrong-env-var",
      description: "does NOT suggest BITBUCKET_WEBHOOK_SECRET",
      pass: !/BITBUCKET_WEBHOOK_SECRET/i.test(text),
      evidence: text.match(/BITBUCKET_WEBHOOK_SECRET/i)?.[0],
    },
    {
      id: "no-bogus-mappings-file",
      description:
        "does NOT suggest a malformed webhook-mappings.json (no providers: wrapper or `extract:`)",
      // Pre-fix shape Marc was given:
      //   { "bitbucket": { "<event>": { "extract": {...} } } }
      // The right shape uses top-level `providers:` and `mapping:`.
      // Flag if the agent writes a mappings file but skips `providers:`
      // OR uses `extract:` instead of `mapping:`.
      pass: !(
        /webhook-?mappings(\.json|\.yaml|\.yml)?/i.test(text) &&
        (/"extract"\s*:/.test(text) ||
          (/"bitbucket"\s*:\s*\{/.test(text) && !/"providers"\s*:/i.test(text)))
      ),
      evidence: text
        .match(/(?:webhook-?mappings|"extract"|"providers")[^\n]{0,40}/gi)
        ?.slice(0, 3)
        .join(" | "),
    },
    {
      id: "no-raw-bypass",
      description: "does NOT recommend /hook/raw/... as a workaround",
      pass:
        !/\/hook\/raw\/[^\s]+(?:\s*(?:as|to|instead|workaround|bypass))/i.test(text) &&
        !(/recommend|use|switch|change|update/i.test(text) && /\/hook\/raw\b/.test(text)),
      evidence: text.match(/\/hook\/raw\/[^\s)\]]+/)?.[0],
    },
  ];
}

async function runExplainsBitbucketWebhookWiring(d: DaemonHandle): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  // Materialize the fixture INTO FRIDAY_HOME so manager.find() can resolve it.
  const fixtureCopy = await makeFixtureDir(d.fridayHome, "webhook-setup-bitbucket-");
  await Deno.copyFile(join(FIXTURE_DIR, "workspace.yml"), join(fixtureCopy, "workspace.yml"));

  const ws = await registerWorkspace(d, fixtureCopy, { name: "webhook-setup-bitbucket-qa" });
  const workspaceId = ws.id;
  const signalName = "bitbucket-pipeline-failed";

  const chatId = `chat_eval_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  // Phrasing matches the 2026-05-15 chat dump: user has just set up the
  // signal and asks how to wire Bitbucket to fire it. They name the
  // signal explicitly so the agent has the workspace context it needs.
  const result = await postChatMessage(
    d,
    workspaceId,
    chatId,
    `I added a \`${signalName}\` HTTP signal to this workspace. How do I configure Bitbucket Cloud to send pipeline-failure events to it? I want full steps — the URL to paste in Bitbucket, what secret to set, which events to subscribe to, and how to debug if it doesn't work.`,
    { timeoutMs: 240_000 },
  );

  metrics.durationMs = result.durationMs;
  metrics.toolNames = result.toolCalls.map((c) => c.toolName);
  metrics.assistantTextLen = result.assistantText.length;
  metrics.assistantTextHead = result.assistantText.slice(0, 400);

  const checks = runContractChecks(result.assistantText, workspaceId, signalName, result.toolCalls);
  metrics.checks = checks;

  const failed = checks.filter((c) => !c.pass);
  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} contract checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description} ${c.evidence ? `[${c.evidence}]` : ""}`);
    return { id: "explains-bitbucket-webhook-wiring", pass: true, notes, metrics };
  }

  notes.push(`Negative: ${failed.length}/${checks.length} contract checks failed.`);
  for (const c of checks) {
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  }
  notes.push(`Reply head: "${result.assistantText.slice(0, 400)}"`);
  return { id: "explains-bitbucket-webhook-wiring", pass: false, notes, metrics };
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
  console.log(`▶ webhook-setup-bitbucket eval @ ${sha}`);

  const fridayHome = await Deno.makeTempDir({ prefix: "friday-qa-webhook-setup-bitbucket-" });
  console.log(`✓ FRIDAY_HOME: ${fridayHome}`);
  const daemon = await startDaemon({ fridayHome, healthTimeoutMs: 90_000 });
  const results: EvalResult[] = [];
  try {
    console.log(`✓ daemon up: ${daemon.baseUrl}`);

    type Runner = (d: DaemonHandle) => Promise<EvalResult>;
    const runners: Array<{ id: string; fn: Runner }> = [
      { id: "explains-bitbucket-webhook-wiring", fn: runExplainsBitbucketWebhookWiring },
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
  console.log(`\n══ webhook-setup-bitbucket summary: ${passed}/${results.length} passed ══`);
  for (const r of results) {
    console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);
    for (const note of r.notes) console.log(`    ${note}`);
  }

  const report = { gitSha: sha, startedAt, passed, failed, results };
  if (writeResult || jsonOutputPath) {
    const outPath =
      jsonOutputPath ?? join(HARNESS_PATHS.resultsDir, `${sha}-webhook-setup-bitbucket.json`);
    await ensureDir(dirname(outPath));
    await Deno.writeTextFile(outPath, JSON.stringify(report, null, 2));
    console.log(`\n→ ${outPath}`);
  }

  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}

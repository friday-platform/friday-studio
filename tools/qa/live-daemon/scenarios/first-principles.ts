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
import { join } from "jsr:@std/path@1";
import {
  currentGitSha,
  type DaemonHandle,
  ensureCredentialsLoaded,
  fetchSessionEvents,
  HARNESS_PATHS,
  listArtifactsForSession,
  registerWorkspace,
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

async function natsKvGetJson(bucket: string, key: string): Promise<Record<string, unknown> | null> {
  const cmd = new Deno.Command("nats", {
    args: ["-s", "nats://localhost:4222", "kv", "get", bucket, key, "--raw"],
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
  metrics.wallTimeMs = trigger.durationMs;
  metrics.sessionId = trigger.sessionId;
  metrics.jobComplete = trigger.jobComplete;

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
  const emailsDoc = await natsKvGetJson(bucket, emailsKey);
  const reviewDoc = await natsKvGetJson(bucket, reviewKey);
  const emailsData = (emailsDoc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const reviewData = (reviewDoc?.data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const artifacts = await listArtifactsForSession(d, ws.id, trigger.sessionId);
  const events = await fetchSessionEvents(d, trigger.sessionId);

  metrics.bucket = bucket;
  metrics.emailsDocBytes = emailsDoc ? byteLen(emailsDoc) : 0;
  metrics.reviewDocBytes = reviewDoc ? byteLen(reviewDoc) : 0;
  metrics.emailsDataKeys = emailsData ? Object.keys(emailsData) : [];
  metrics.reviewData = reviewData ?? null;
  metrics.artifactCount = artifacts.length;
  metrics.toolCallCount = events.toolCallCount;
  metrics.usage = events.totalUsage;

  const emailDocHasRefs = hasArtifactRef(emailsData);
  const emailDocStillInlineMessages = Array.isArray(emailsData?.messages);
  const emailDocContainsBodySentinel = JSON.stringify(emailsData ?? {}).includes(
    "FIRST_PRINCIPLES_EMAIL_BODY",
  );
  const reviewConsumedInput =
    reviewData?.marker === "CONSUMED_EMAIL_BATCH" &&
    reviewData?.count === 12 &&
    reviewData?.firstId === "fake-001";
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
        `review-result marker: ${String(reviewData?.marker ?? "(missing)")}`,
        `review-result count: ${String(reviewData?.count ?? "(missing)")}`,
        `review-result firstId: ${String(reviewData?.firstId ?? "(missing)")}`,
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

async function main() {
  await ensureCredentialsLoaded();
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    console.error("ANTHROPIC_API_KEY missing — first-principles daemon eval uses real LLM calls.");
    Deno.exit(2);
  }

  const sha = await currentGitSha();
  const startedAt = new Date().toISOString();
  const writeResult = Deno.args.includes("--write-result");
  console.log(`▶ first-principles eval @ ${sha}`);

  const daemon = await startDaemon({ healthTimeoutMs: 90_000 });
  const results: EvalResult[] = [];
  try {
    console.log(`✓ daemon up: ${daemon.baseUrl}`);
    console.log("\n── refs over data / inputFrom / compact return ──");
    results.push(...(await runRefsOverDataScenario(daemon)));
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

  if (writeResult) {
    await ensureDir(HARNESS_PATHS.resultsDir);
    const path = join(HARNESS_PATHS.resultsDir, `${sha}-first-principles.json`);
    await Deno.writeTextFile(
      path,
      JSON.stringify({ gitSha: sha, startedAt, passed, failed, results }, null, 2),
    );
    console.log(`\n→ ${path}`);
  }

  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}

#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * Headline benchmark: trigger auto-triage on the no-auth inbox-corpus
 * fixture, capture metrics, and write to tools/qa/results/<sha>-auto-triage.json.
 *
 * The supervisor-flip claim (Phase 2.C) lives or dies on this scenario:
 *   pre-fix:   jobToolResultShape: "legacy" — full Document[]
 *   post-fix:  jobToolResultShape: "compact" — { artifactIds, summary }
 *
 * Usage:
 *   deno run -A --unstable-worker-options --unstable-kv --unstable-raw-imports \
 *     tools/qa/live-daemon/scenarios/auto-triage-baseline.ts [--limit 50]
 *
 * Cost: real LLM call against ANTHROPIC_API_KEY (~$0.10–0.30).
 */

import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { join } from "jsr:@std/path@1";
import {
  countLogMatches,
  currentGitSha,
  ensureCredentialsLoaded,
  fetchSessionEvents,
  HARNESS_PATHS,
  listArtifactsForSession,
  registerWorkspace,
  startDaemon,
  stopDaemon,
  triggerSignalSSE,
} from "../harness.ts";

interface Metrics {
  gitSha: string;
  scenario: "auto-triage-baseline";
  startedAt: string;
  inboxCount: number;
  wallTimeMs: number;
  jobToolResultShape: "compact" | "legacy" | "error" | "missing";
  artifactCountInPayload: number;
  artifactCountInJetStream: number;
  summaryLength: number;
  supervisorInputTokens: number;
  supervisorOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  validatorRunCount: number;
  validatorSkipCount: number;
  toolCallCount: number;
  sessionId: string | null;
  error?: string;
}

function parseArgs(): { limit: number; outputName: string } {
  let limit = 50;
  let outputName = "auto-triage-baseline";
  for (let i = 0; i < Deno.args.length; i++) {
    const a = Deno.args[i];
    if (a === "--limit" && Deno.args[i + 1]) {
      limit = Number(Deno.args[++i]);
    } else if (a === "--name" && Deno.args[i + 1]) {
      outputName = Deno.args[++i] as string;
    }
  }
  return { limit, outputName };
}

async function main() {
  const { limit, outputName } = parseArgs();

  await ensureCredentialsLoaded();

  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    console.error("ANTHROPIC_API_KEY is not set — auto-triage requires a real LLM call.");
    console.error("Set it via .env or shell, then re-run.");
    Deno.exit(2);
  }

  const sha = await currentGitSha();
  const startedAt = new Date().toISOString();
  console.log(`▶ auto-triage-baseline @ ${sha} — limit=${limit}`);

  const daemon = await startDaemon({ healthTimeoutMs: 90_000 });
  console.log(`✓ daemon up: ${daemon.baseUrl} (FRIDAY_HOME=${daemon.fridayHome})`);

  const metrics: Metrics = {
    gitSha: sha,
    scenario: "auto-triage-baseline",
    startedAt,
    inboxCount: limit,
    wallTimeMs: 0,
    jobToolResultShape: "missing",
    artifactCountInPayload: 0,
    artifactCountInJetStream: 0,
    summaryLength: 0,
    supervisorInputTokens: 0,
    supervisorOutputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    validatorRunCount: 0,
    validatorSkipCount: 0,
    toolCallCount: 0,
    sessionId: null,
  };

  try {
    const ws = await registerWorkspace(daemon, HARNESS_PATHS.inboxCorpusWorkspaceDir, {
      name: "Inbox Corpus QA",
    });
    console.log(`✓ workspace registered: ${ws.id}`);

    const trigger = await triggerSignalSSE(daemon, ws.id, "inbox-event", {
      payload: { inboxPath: HARNESS_PATHS.inboxCorpusDir, limit },
      timeoutMs: 15 * 60 * 1000, // 15 min cap
      onEvent: (e) => {
        if (e.type === "data-session-start") console.log(`  session: ${e.data.sessionId}`);
        if (e.type === "job-complete") console.log(`  ✓ job-complete`);
        if (e.type === "job-error") console.log(`  ✗ job-error: ${JSON.stringify(e.data)}`);
      },
    });

    metrics.wallTimeMs = trigger.durationMs;
    metrics.sessionId = trigger.sessionId;

    if (trigger.jobError) {
      metrics.jobToolResultShape = "error";
      metrics.error = trigger.jobError.error;
    } else if (trigger.jobComplete) {
      const c = trigger.jobComplete;
      const hasRefs = Array.isArray(c.artifactIds) && c.artifactIds.length > 0;
      const hasSummary = typeof c.summary === "string" && c.summary.length > 0;
      metrics.jobToolResultShape = hasRefs && hasSummary ? "compact" : "legacy";
      metrics.artifactCountInPayload = c.artifactIds?.length ?? 0;
      metrics.summaryLength = c.summary?.length ?? 0;
    }

    if (trigger.sessionId) {
      try {
        const artifacts = await listArtifactsForSession(daemon, ws.id, trigger.sessionId);
        metrics.artifactCountInJetStream = artifacts.length;
        const events = await fetchSessionEvents(daemon, trigger.sessionId);
        metrics.supervisorInputTokens = events.totalUsage.inputTokens;
        metrics.supervisorOutputTokens = events.totalUsage.outputTokens;
        metrics.cacheReadTokens = events.totalUsage.cacheReadTokens;
        metrics.cacheWriteTokens = events.totalUsage.cacheWriteTokens;
        metrics.validatorRunCount = events.validatorRunCount;
        metrics.validatorSkipCount = events.validatorSkipCount;
        metrics.toolCallCount = events.toolCallCount;
        // Phase 4 skip-on-tool-passthrough has no on-wire marker —
        // count the debug log line instead.
        metrics.validatorSkipCount =
          metrics.validatorSkipCount +
          (await countLogMatches(daemon, "Skipping validation for tool-passthrough"));
      } catch (err) {
        console.warn(
          `  ! session events fetch failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    console.log("\n── metrics ──");
    console.log(JSON.stringify(metrics, null, 2));
  } catch (err) {
    metrics.error = err instanceof Error ? err.message : String(err);
    metrics.jobToolResultShape = "error";
    console.error(`✗ scenario failed: ${metrics.error}`);
  } finally {
    const keepHome = Deno.env.get("FRIDAY_QA_KEEP_HOME") === "1";
    await stopDaemon(daemon, { keepHome });
    if (keepHome) console.log(`(kept) FRIDAY_HOME=${daemon.fridayHome}`);
  }

  await ensureDir(HARNESS_PATHS.resultsDir);
  const outPath = join(HARNESS_PATHS.resultsDir, `${sha}-${outputName}.json`);
  await Deno.writeTextFile(outPath, JSON.stringify(metrics, null, 2));
  console.log(`\n→ wrote ${outPath}`);

  Deno.exit(metrics.error ? 1 : 0);
}

if (import.meta.main) {
  await main();
}

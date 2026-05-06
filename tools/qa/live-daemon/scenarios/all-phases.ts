#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports

/**
 * Per-phase QA runner. Spins up a single daemon, registers all fixture
 * workspaces, runs each scenario, captures pass/fail + diagnostic
 * metrics, tears down. Writes a summary JSON + a human-readable
 * markdown report to `tools/qa/results/<sha>-all-phases.{json,md}`.
 *
 * Phases tested live (others have unit-test coverage):
 *   1.A  — workspace-level permissions strict; narrow tool allowlist
 *          enforced (fs_read_file denied)
 *   1.B  — per-job dangerouslySkipAllowlist: true bypasses narrowing
 *   2.B  — Phase 2.B artifact persists in JetStream Object Store
 *   2.C  — Phase 2.C SSE job-complete carries compact { artifactIds, summary }
 *   4    — validator runs on prose-emitting actions (skip path covered
 *          by unit tests; this confirms the run path)
 *   11   — Phase 11 step:complete events carry `usage`
 *   12   — request_tool_access emits a tool-allowlist elicitation
 *          surfaced via GET /api/elicitations
 *
 * Cost: ~$0.50 of LLM calls (4 short scenarios + 1 medium baseline).
 */

import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { join } from "jsr:@std/path@1";
import {
  countLogMatches,
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

interface PhaseResult {
  phase: string;
  pass: boolean;
  notes: string[];
  metrics: Record<string, unknown>;
}

const NARROW_WS = join(HARNESS_PATHS.fixturesDir, "inbox-corpus-qa-narrow");
const BYPASS_WS = join(HARNESS_PATHS.fixturesDir, "inbox-corpus-qa-bypass");
const ELICIT_WS = join(HARNESS_PATHS.fixturesDir, "inbox-corpus-qa-elicitation");
const STANDARD_WS = HARNESS_PATHS.inboxCorpusWorkspaceDir;

async function runPhase1A(d: DaemonHandle): Promise<PhaseResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  try {
    const ws = await registerWorkspace(d, NARROW_WS, { name: "Inbox QA Narrow" });
    notes.push(`workspace ${ws.id} registered`);
    const t = await triggerSignalSSE(d, ws.id, "inbox-event", {
      payload: { inboxPath: HARNESS_PATHS.inboxCorpusDir, limit: 3 },
      timeoutMs: 4 * 60 * 1000,
    });
    metrics.wallTimeMs = t.durationMs;
    metrics.sessionId = t.sessionId;
    if (!t.sessionId) {
      return { phase: "1.A", pass: false, notes: [...notes, "no sessionId"], metrics };
    }

    // The runtime emits a debug log "Executing LLM action" with a
    // `toolCount: N` field. For the narrow scenario, the action's
    // declared `tools: [fs_glob]` should resolve to 1. The architectural
    // assertion is "allowlist narrowing happened", not "the LLM
    // happened to call the tool" — model behavior is non-deterministic.
    const log = await Deno.readTextFile(`${d.fridayHome}/logs/global.log`).catch(() => "");
    // Find the LLM action log entry whose outputTo identifies the
    // narrow scenario's emit doc (`triage-summary-narrow`).
    const matches = log
      .split("\n")
      .filter((l) => l.includes('"outputTo":"triage-summary-narrow"') && l.includes("toolCount"));
    let resolvedToolCount: number | null = null;
    for (const line of matches) {
      const m = line.match(/"toolCount":(\d+)/);
      if (m) resolvedToolCount = Number(m[1]);
    }
    metrics.resolvedToolCount = resolvedToolCount;
    notes.push(`resolved toolCount for narrow action: ${resolvedToolCount ?? "(not found)"}`);

    return {
      phase: "1.A — narrow allowlist enforced (toolCount=1)",
      pass: resolvedToolCount === 1,
      notes,
      metrics,
    };
  } catch (err) {
    return {
      phase: "1.A",
      pass: false,
      notes: [...notes, `error: ${err instanceof Error ? err.message : String(err)}`],
      metrics,
    };
  }
}

async function runPhase1B(d: DaemonHandle): Promise<PhaseResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  try {
    const ws = await registerWorkspace(d, BYPASS_WS, { name: "Inbox QA Bypass" });
    notes.push(`workspace ${ws.id} registered`);
    const t = await triggerSignalSSE(d, ws.id, "inbox-event-bypass", {
      payload: { inboxPath: HARNESS_PATHS.inboxCorpusDir, limit: 3 },
      timeoutMs: 4 * 60 * 1000,
    });
    metrics.wallTimeMs = t.durationMs;
    metrics.sessionId = t.sessionId;
    if (!t.sessionId) {
      return { phase: "1.B", pass: false, notes: [...notes, "no sessionId"], metrics };
    }
    const events = await fetchSessionEvents(d, t.sessionId);
    const toolNamesCalled = new Set<string>();
    for (const e of events.events) {
      const tcs = (e as { toolCalls?: Array<{ name?: string }> }).toolCalls;
      if (Array.isArray(tcs)) for (const tc of tcs) if (tc.name) toolNamesCalled.add(tc.name);
    }
    metrics.toolNamesCalled = [...toolNamesCalled];

    // Bypass marker — the runtime emits an info-level log on bypass
    // resolution. Count occurrences in the daemon log.
    const bypassLogCount = await countLogMatches(d, "Bypassing per-agent");
    metrics.bypassLogCount = bypassLogCount;
    notes.push(`tool names called: ${[...toolNamesCalled].join(", ") || "(none)"}`);
    notes.push(`bypass info-log lines: ${bypassLogCount}`);

    const calledNonAllowlisted = toolNamesCalled.has("fs_read_file");
    return {
      phase: "1.B — per-job bypass grants full tool set",
      pass: calledNonAllowlisted || bypassLogCount > 0,
      notes,
      metrics,
    };
  } catch (err) {
    return {
      phase: "1.B",
      pass: false,
      notes: [...notes, `error: ${err instanceof Error ? err.message : String(err)}`],
      metrics,
    };
  }
}

async function runPhase2BC4_11_baseline(d: DaemonHandle): Promise<PhaseResult[]> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  try {
    const ws = await registerWorkspace(d, STANDARD_WS, { name: "Inbox QA Standard" });
    notes.push(`workspace ${ws.id} registered`);
    const t = await triggerSignalSSE(d, ws.id, "inbox-event", {
      payload: { inboxPath: HARNESS_PATHS.inboxCorpusDir, limit: 5 },
      timeoutMs: 5 * 60 * 1000,
    });
    metrics.wallTimeMs = t.durationMs;
    metrics.sessionId = t.sessionId;

    // Phase 2.C — compact SSE shape
    const compact =
      t.jobComplete &&
      Array.isArray(t.jobComplete.artifactIds) &&
      t.jobComplete.artifactIds.length > 0 &&
      typeof t.jobComplete.summary === "string" &&
      t.jobComplete.summary.length > 0;
    metrics.jobToolResultShape = compact ? "compact" : "legacy";
    metrics.artifactIdsInPayload = t.jobComplete?.artifactIds?.length ?? 0;
    metrics.summaryLength = t.jobComplete?.summary?.length ?? 0;

    if (!t.sessionId) {
      return [
        {
          phase: "2.B/2.C/4/11 — baseline",
          pass: false,
          notes: [...notes, "no sessionId"],
          metrics,
        },
      ];
    }

    // Phase 2.B — artifact persisted to JetStream
    const artifacts = await listArtifactsForSession(d, ws.id, t.sessionId);
    metrics.artifactsInJetStream = artifacts.length;

    const events = await fetchSessionEvents(d, t.sessionId);
    metrics.toolCallCount = events.toolCallCount;
    metrics.supervisorInputTokens = events.totalUsage.inputTokens;
    metrics.supervisorOutputTokens = events.totalUsage.outputTokens;
    metrics.cacheReadTokens = events.totalUsage.cacheReadTokens;
    metrics.validatorRunCount = events.validatorRunCount;
    // Phase 4 — skip-on-tool-passthrough emits a debug log line
    const skipLogCount = await countLogMatches(d, "Skipping validation for tool-passthrough");
    metrics.validatorSkipCountFromLog = skipLogCount;

    return [
      {
        phase: "2.B — outputTo doc persists as artifact",
        pass: artifacts.length >= 1,
        notes: [`artifact count in JetStream: ${artifacts.length}`],
        metrics: { artifactsInJetStream: artifacts.length },
      },
      {
        phase: "2.C — SSE job-complete carries { artifactIds, summary }",
        pass: !!compact,
        notes: [
          `artifactIds: ${metrics.artifactIdsInPayload}`,
          `summary length: ${metrics.summaryLength}`,
          `shape: ${metrics.jobToolResultShape}`,
        ],
        metrics: {
          jobToolResultShape: metrics.jobToolResultShape,
          artifactIdsInPayload: metrics.artifactIdsInPayload,
          summaryLength: metrics.summaryLength,
        },
      },
      {
        phase: "4 — validator runs on prose-emitting actions",
        pass: events.validatorRunCount >= 1,
        notes: [
          `validator runs (events): ${events.validatorRunCount}`,
          `skip-log lines: ${skipLogCount}`,
        ],
        metrics: {
          validatorRunCount: events.validatorRunCount,
          validatorSkipCountFromLog: skipLogCount,
        },
      },
      {
        phase: "11 — step:complete events carry usage{inputTokens,outputTokens}",
        pass: events.totalUsage.inputTokens > 0 && events.totalUsage.outputTokens > 0,
        notes: [
          `inputTokens total: ${events.totalUsage.inputTokens}`,
          `outputTokens total: ${events.totalUsage.outputTokens}`,
          `tool calls captured: ${events.toolCallCount}`,
        ],
        metrics: { totalUsage: events.totalUsage, toolCallCount: events.toolCallCount },
      },
    ];
  } catch (err) {
    return [
      {
        phase: "2.B/2.C/4/11 — baseline",
        pass: false,
        notes: [...notes, `error: ${err instanceof Error ? err.message : String(err)}`],
        metrics,
      },
    ];
  }
}

async function runPhase12(d: DaemonHandle): Promise<PhaseResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  try {
    const ws = await registerWorkspace(d, ELICIT_WS, { name: "Inbox QA Elicit" });
    notes.push(`workspace ${ws.id} registered`);
    const t = await triggerSignalSSE(d, ws.id, "elicit-event", {
      payload: { toolName: "secret_tool", reason: "I need to do a secret thing." },
      timeoutMs: 2 * 60 * 1000,
    });
    metrics.wallTimeMs = t.durationMs;
    metrics.sessionId = t.sessionId;

    // Pull elicitations for this workspace.
    const url = new URL(`${d.baseUrl}/api/elicitations`);
    url.searchParams.set("workspaceId", ws.id);
    const resp = await fetch(url.toString());
    let elicitations: Array<Record<string, unknown>> = [];
    if (resp.ok) {
      const body = (await resp.json()) as { elicitations?: Array<Record<string, unknown>> };
      elicitations = body.elicitations ?? [];
    }
    metrics.elicitationCount = elicitations.length;

    const found = elicitations.find((e) => (e as { kind?: string }).kind === "tool-allowlist");
    metrics.firstElicitationKind = found ? (found as { kind?: string }).kind : null;
    metrics.firstElicitationToolName =
      found && (found as { pendingTool?: { name?: string } }).pendingTool
        ? (found as { pendingTool?: { name?: string } }).pendingTool?.name
        : null;

    notes.push(`elicitations returned: ${elicitations.length}`);
    notes.push(`first elicitation kind: ${metrics.firstElicitationKind ?? "(none)"}`);

    return {
      phase: "12 — request_tool_access emits tool-allowlist elicitation",
      pass: elicitations.length >= 1 && (found as { kind?: string })?.kind === "tool-allowlist",
      notes,
      metrics,
    };
  } catch (err) {
    return {
      phase: "12",
      pass: false,
      notes: [...notes, `error: ${err instanceof Error ? err.message : String(err)}`],
      metrics,
    };
  }
}

async function main() {
  await ensureCredentialsLoaded();
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    console.error("ANTHROPIC_API_KEY missing — set in ~/.atlas/.env or shell.");
    Deno.exit(2);
  }

  const sha = await currentGitSha();
  const startedAt = new Date().toISOString();
  console.log(`▶ all-phases @ ${sha}`);

  const daemon = await startDaemon({ healthTimeoutMs: 90_000 });
  console.log(`✓ daemon up: ${daemon.baseUrl}`);

  const results: PhaseResult[] = [];

  try {
    console.log("\n── Phase 1.A (narrow allowlist) ──");
    results.push(await runPhase1A(daemon));

    console.log("\n── Phase 1.B (bypass) ──");
    results.push(await runPhase1B(daemon));

    console.log("\n── Phase 2.B/2.C/4/11 (baseline-derived) ──");
    results.push(...(await runPhase2BC4_11_baseline(daemon)));

    console.log("\n── Phase 12 (elicitation) ──");
    results.push(await runPhase12(daemon));
  } finally {
    const keepHome = Deno.env.get("FRIDAY_QA_KEEP_HOME") === "1";
    await stopDaemon(daemon, { keepHome });
    if (keepHome) console.log(`(kept) FRIDAY_HOME=${daemon.fridayHome}`);
  }

  // Report
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n══ summary: ${passed}/${results.length} passed ══`);
  for (const r of results) {
    const tag = r.pass ? "✓" : "✗";
    console.log(`${tag} ${r.phase}`);
    for (const n of r.notes) console.log(`    ${n}`);
  }

  await ensureDir(HARNESS_PATHS.resultsDir);
  const jsonPath = join(HARNESS_PATHS.resultsDir, `${sha}-all-phases.json`);
  await Deno.writeTextFile(
    jsonPath,
    JSON.stringify({ gitSha: sha, startedAt, passed, failed, results }, null, 2),
  );

  const mdPath = join(HARNESS_PATHS.resultsDir, `${sha}-all-phases.md`);
  const md = [
    `# QA Run: ${sha}`,
    `**Started:** ${startedAt}`,
    `**Result:** ${passed}/${results.length} phases passed`,
    "",
    "## Per-phase",
    "",
    "| # | Phase | Result | Notes |",
    "|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.phase.split(" ")[0]} | ${r.phase} | ${r.pass ? "✓ pass" : "✗ fail"} | ${r.notes.join("; ")} |`,
    ),
    "",
    "## Detail metrics",
    "",
    "```json",
    JSON.stringify(results, null, 2),
    "```",
  ].join("\n");
  await Deno.writeTextFile(mdPath, md);

  console.log(`\n→ ${jsonPath}`);
  console.log(`→ ${mdPath}`);
  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}

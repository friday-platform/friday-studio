#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * Tool-suite management chat-driven evals.
 *
 * Exercises the retrieval tools added by `plans/tool-suite-management.md`
 * by driving the workspace-chat handler through a real LLM and asserting
 * the chat picks the new per-domain tools instead of falling back to
 * inline-prompt reading or run_code curl.
 *
 * Scenarios (one per phase that has behavior-changing surface):
 *   - skills-retrieval-via-tool          (Phase 1)
 *   - agent-registry-via-tool            (Phase 2)
 *   - integrations-retrieval-via-tool    (Phase 3)
 *   - domain-list-tool-pick              (Phase 4)
 *   - foreground-via-describe            (Phase 5)
 *   - router-vs-domain-list              (Phase 7)
 *
 * Each scenario spins up a workspace from the shared fixture, sends a
 * chat message, and inspects the tool-call trace. Phase 6 is a
 * mechanical rename and reuses scenarios 1, 4, 5 as its regression
 * battery.
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

const FIXTURE_DIR = join(HARNESS_PATHS.fixturesDir, "tool-suite-mgmt");

// ────────────────────────────────────────────────────────────────────────
// Chat helpers — minimal subset of first-principles' chat-driven harness.
// Inlined so this scenario file is self-contained and the parent doesn't
// have to expose them publicly.
// ────────────────────────────────────────────────────────────────────────

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
  durationMs: number;
}

async function postChatMessage(
  d: DaemonHandle,
  workspaceId: string,
  chatId: string,
  messageText: string,
  opts: { timeoutMs?: number; foregroundWorkspaceIds?: string[] } = {},
): Promise<PostChatResult> {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 600_000);

  const body: Record<string, unknown> = { id: chatId, message: messageText };
  if (opts.foregroundWorkspaceIds) {
    body.foregroundWorkspaceIds = opts.foregroundWorkspaceIds;
  }

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
    durationMs: Date.now() - startedAt,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Workspace + skill setup
// ────────────────────────────────────────────────────────────────────────

interface SetupResult {
  workspaceId: string;
}

async function materializeFixture(srcDir: string): Promise<string> {
  const tmpDir = await Deno.makeTempDir({ prefix: "friday-tsm-fixture-" });
  const src = await Deno.readTextFile(join(srcDir, "workspace.yml"));
  await Deno.writeTextFile(join(tmpDir, "workspace.yml"), src);
  return tmpDir;
}

async function setupWorkspace(d: DaemonHandle, name: string): Promise<SetupResult> {
  const wsPath = await materializeFixture(FIXTURE_DIR);
  const ws = await registerWorkspace(d, wsPath, { name });
  return { workspaceId: ws.id };
}

/**
 * Assign a bundled `@friday/*` skill to the workspace so list_skills /
 * describe_skill / load_skill have at least one stable target. The
 * bundled-skill bootstrap publishes these at daemon start, so they're
 * always in the catalog by the time scenarios run.
 *
 * Two-step: GET /api/skills/@{ns}/{name} → skillId, then
 * POST /api/skills/scoping/:skillId/assignments with {assignments: [...]}.
 */
async function assignSkill(
  d: DaemonHandle,
  workspaceId: string,
  skillRef: string,
): Promise<{ ok: boolean; error?: string }> {
  const slash = skillRef.indexOf("/");
  if (!skillRef.startsWith("@") || slash < 0) {
    return { ok: false, error: `Invalid skillRef: ${skillRef}` };
  }
  const namespace = skillRef.slice(1, slash);
  const name = skillRef.slice(slash + 1);

  const getRes = await fetch(
    `${d.baseUrl}/api/skills/@${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
  );
  if (!getRes.ok) {
    const text = await getRes.text();
    return { ok: false, error: `lookup ${skillRef}: HTTP ${getRes.status} ${text}` };
  }
  const lookup = (await getRes.json()) as { skill?: { skillId?: string } };
  const skillId = lookup.skill?.skillId;
  if (!skillId) {
    return { ok: false, error: `lookup ${skillRef}: no skillId in response` };
  }

  const assignRes = await fetch(
    `${d.baseUrl}/api/skills/scoping/${encodeURIComponent(skillId)}/assignments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignments: [{ workspaceId }] }),
    },
  );
  if (!assignRes.ok && assignRes.status !== 207) {
    const text = await assignRes.text();
    return {
      ok: false,
      error: `assign ${skillRef} → ${workspaceId}: HTTP ${assignRes.status} ${text}`,
    };
  }
  return { ok: true };
}

// ────────────────────────────────────────────────────────────────────────
// Tool-call assertion helpers
// ────────────────────────────────────────────────────────────────────────

const RETRIEVAL_TOOLS_FOR_SKILLS = new Set([
  "list_skills",
  "search_skills",
  "describe_skill",
  "load_skill",
]);

const INTEGRATION_TOOLS = new Set(["list_integrations", "describe_integration"]);

const PER_DOMAIN_LIST_TOOLS = new Set([
  "list_skills",
  "list_agents",
  "list_jobs",
  "list_signals",
  "list_memory_stores",
  "list_communicators",
  "list_workspaces",
  "list_artifacts",
  "list_sessions",
  "list_bundled_agents",
  "list_mcp_servers",
]);

function toolNames(calls: ChatToolCall[]): string[] {
  return calls.map((c) => c.toolName);
}

function anyToolMatches(calls: ChatToolCall[], allow: ReadonlySet<string>): boolean {
  return calls.some((c) => allow.has(c.toolName));
}

function noToolMatches(calls: ChatToolCall[], deny: ReadonlySet<string>): boolean {
  return !calls.some((c) => deny.has(c.toolName));
}

// ────────────────────────────────────────────────────────────────────────
// Scenarios
// ────────────────────────────────────────────────────────────────────────

const CHAT_TIMEOUT_MS = 4 * 60 * 1000;

async function runSkillsRetrievalViaTool(d: DaemonHandle): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  const { workspaceId } = await setupWorkspace(d, "TSM Skills Retrieval");
  notes.push(`workspace ${workspaceId} registered`);

  const assigned = await assignSkill(d, workspaceId, "@friday/workspace-api");
  if (!assigned.ok) {
    notes.push(`skill assignment failed: ${assigned.error ?? "unknown"}`);
    return { id: "skills-retrieval-via-tool", pass: false, notes, metrics };
  }
  notes.push("assigned @friday/workspace-api to workspace");

  const chatId = crypto.randomUUID();
  const result = await postChatMessage(
    d,
    workspaceId,
    chatId,
    [
      "List my workspace's skills and pick the one that helps with workspace authoring (creating/editing workspaces).",
      "Tell me what it does in one sentence — pull the description from the right tool",
      "rather than guessing or echoing the names index.",
    ].join(" "),
    { timeoutMs: CHAT_TIMEOUT_MS },
  );

  const names = toolNames(result.toolCalls);
  metrics.toolCalls = names;
  metrics.durationMs = result.durationMs;

  const usedRetrieval = anyToolMatches(result.toolCalls, RETRIEVAL_TOOLS_FOR_SKILLS);
  const avoidedRunCode = noToolMatches(result.toolCalls, new Set(["run_code"]));

  const pass = usedRetrieval && avoidedRunCode;
  if (!usedRetrieval) {
    notes.push(
      `expected at least one of ${[...RETRIEVAL_TOOLS_FOR_SKILLS].join("/")}; got [${names.join(", ") || "(none)"}]`,
    );
  }
  if (!avoidedRunCode) {
    notes.push("chat dropped to run_code instead of using a skill retrieval tool");
  }
  if (pass) notes.push(`tool-pick OK: [${names.join(", ")}]`);

  return { id: "skills-retrieval-via-tool", pass, notes, metrics };
}

async function runAgentRegistryViaTool(d: DaemonHandle): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  const { workspaceId } = await setupWorkspace(d, "TSM Agent Registry");
  notes.push(`workspace ${workspaceId} registered`);

  // Use a fictitious entrypoint path. We're asserting the chat picks
  // `register_agent` rather than reaching for run_code curl. The daemon
  // call may fail because the path doesn't exist — that's fine; we only
  // care about which tool the LLM chose first.
  const fakeEntrypoint = "/tmp/tool-suite-mgmt-fake-agent/agent.py";

  const chatId = crypto.randomUUID();
  const result = await postChatMessage(
    d,
    workspaceId,
    chatId,
    [
      "Register a new user agent in the global registry.",
      `The entrypoint is at ${fakeEntrypoint}.`,
      "Call the right tool. Do not curl any HTTP endpoints with run_code.",
      "If the call fails, report the error and stop — don't substitute a different path.",
    ].join(" "),
    { timeoutMs: CHAT_TIMEOUT_MS },
  );

  const names = toolNames(result.toolCalls);
  metrics.toolCalls = names;
  metrics.durationMs = result.durationMs;

  const usedRegister = names.includes("register_agent");
  const avoidedRunCode = noToolMatches(result.toolCalls, new Set(["run_code"]));

  const pass = usedRegister && avoidedRunCode;
  if (!usedRegister) {
    notes.push(`expected register_agent in tool calls; got [${names.join(", ") || "(none)"}]`);
  }
  if (!avoidedRunCode) {
    notes.push("chat used run_code curl despite register_agent being available");
  }
  if (pass) notes.push(`tool-pick OK: [${names.join(", ")}]`);

  return { id: "agent-registry-via-tool", pass, notes, metrics };
}

async function runIntegrationsRetrievalViaTool(d: DaemonHandle): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  const { workspaceId } = await setupWorkspace(d, "TSM Integrations Retrieval");
  notes.push(`workspace ${workspaceId} registered`);

  const chatId = crypto.randomUUID();
  const result = await postChatMessage(
    d,
    workspaceId,
    chatId,
    [
      "Is my Gmail connected? If not, tell me what to do to connect it.",
      "Check the integration status with the right tool — don't guess from your prior knowledge.",
    ].join(" "),
    { timeoutMs: CHAT_TIMEOUT_MS },
  );

  const names = toolNames(result.toolCalls);
  metrics.toolCalls = names;
  metrics.durationMs = result.durationMs;

  const usedIntegrationTool = anyToolMatches(result.toolCalls, INTEGRATION_TOOLS);

  const pass = usedIntegrationTool;
  if (!pass) {
    notes.push(
      `expected list_integrations or describe_integration; got [${names.join(", ") || "(none)"}]`,
    );
  } else {
    notes.push(`tool-pick OK: [${names.join(", ")}]`);
  }

  return { id: "integrations-retrieval-via-tool", pass, notes, metrics };
}

async function runDomainListToolPick(d: DaemonHandle): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  const { workspaceId } = await setupWorkspace(d, "TSM Domain List Pick");
  notes.push(`workspace ${workspaceId} registered`);

  const chatId = crypto.randomUUID();
  const result = await postChatMessage(
    d,
    workspaceId,
    chatId,
    [
      "Give me a quick inventory of this workspace.",
      "List the agents, jobs, and signals — use the right per-domain inventory tool for each.",
      "Don't reach for list_capabilities (that's for cross-domain routing); use the per-domain list_X tools.",
    ].join(" "),
    { timeoutMs: CHAT_TIMEOUT_MS },
  );

  const names = toolNames(result.toolCalls);
  metrics.toolCalls = names;
  metrics.durationMs = result.durationMs;

  const perDomainCount = result.toolCalls.filter((c) =>
    PER_DOMAIN_LIST_TOOLS.has(c.toolName),
  ).length;
  const reachedForRouter = names.includes("list_capabilities");

  const pass = perDomainCount >= 2 && !reachedForRouter;
  if (perDomainCount < 2) {
    notes.push(
      `expected ≥2 per-domain list_X calls; got ${perDomainCount} in [${names.join(", ") || "(none)"}]`,
    );
  }
  if (reachedForRouter) {
    notes.push("chat reached for list_capabilities even though the question was inventory-shaped");
  }
  if (pass) notes.push(`tool-pick OK (${perDomainCount} per-domain calls): [${names.join(", ")}]`);

  return { id: "domain-list-tool-pick", pass, notes, metrics };
}

async function runForegroundViaDescribe(d: DaemonHandle): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  const primary = await setupWorkspace(d, "TSM Foreground Primary");
  const foreground = await setupWorkspace(d, "TSM Foreground Other");
  notes.push(`primary ${primary.workspaceId}, foreground ${foreground.workspaceId}`);

  const chatId = crypto.randomUUID();
  const result = await postChatMessage(
    d,
    primary.workspaceId,
    chatId,
    [
      "I have another workspace pinned in foreground.",
      "What's in it? Get its name + description + workspace config — use the right tool to fetch the details on demand.",
    ].join(" "),
    { timeoutMs: CHAT_TIMEOUT_MS, foregroundWorkspaceIds: [foreground.workspaceId] },
  );

  const names = toolNames(result.toolCalls);
  metrics.toolCalls = names;
  metrics.durationMs = result.durationMs;

  const usedDescribe = result.toolCalls.some(
    (c) =>
      c.toolName === "describe_workspace" && typeof (c.input as { id?: unknown })?.id === "string",
  );

  const pass = usedDescribe;
  if (!pass) {
    notes.push(`expected describe_workspace({id: …}); got [${names.join(", ") || "(none)"}]`);
  } else {
    notes.push(`tool-pick OK: [${names.join(", ")}]`);
  }

  return { id: "foreground-via-describe", pass, notes, metrics };
}

async function runRouterVsDomainList(d: DaemonHandle): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  const { workspaceId } = await setupWorkspace(d, "TSM Router vs Domain");
  notes.push(`workspace ${workspaceId} registered`);

  // Cross-domain question — should reach for list_capabilities.
  const chatId = crypto.randomUUID();
  const result = await postChatMessage(
    d,
    workspaceId,
    chatId,
    [
      "I want to send a Slack message. I don't know what's available in this workspace yet —",
      "could be a bundled agent, an enabled MCP server, or something I need to install.",
      "Find me the right capability across all the domains.",
    ].join(" "),
    { timeoutMs: CHAT_TIMEOUT_MS },
  );

  const names = toolNames(result.toolCalls);
  metrics.toolCalls = names;
  metrics.durationMs = result.durationMs;

  const usedRouter = names.includes("list_capabilities");
  const pass = usedRouter;

  if (!pass) {
    notes.push(
      `expected list_capabilities for cross-domain routing; got [${names.join(", ") || "(none)"}]`,
    );
  } else {
    notes.push(`tool-pick OK: [${names.join(", ")}]`);
  }

  return { id: "router-vs-domain-list", pass, notes, metrics };
}

// ────────────────────────────────────────────────────────────────────────
// Entry point
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
  console.log(`▶ tool-suite-management eval @ ${sha}`);

  const fridayHome = await Deno.makeTempDir({ prefix: "friday-qa-tsm-" });
  const daemon = await startDaemon({ fridayHome, healthTimeoutMs: 90_000 });
  const results: EvalResult[] = [];
  try {
    console.log(`✓ daemon up: ${daemon.baseUrl}`);

    type Runner = (d: DaemonHandle) => Promise<EvalResult>;
    const runners: Array<{ id: string; fn: Runner }> = [
      { id: "skills-retrieval-via-tool", fn: runSkillsRetrievalViaTool },
      { id: "agent-registry-via-tool", fn: runAgentRegistryViaTool },
      { id: "integrations-retrieval-via-tool", fn: runIntegrationsRetrievalViaTool },
      { id: "domain-list-tool-pick", fn: runDomainListToolPick },
      { id: "foreground-via-describe", fn: runForegroundViaDescribe },
      { id: "router-vs-domain-list", fn: runRouterVsDomainList },
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
  console.log(`\n══ tool-suite-management summary: ${passed}/${results.length} passed ══`);
  for (const r of results) {
    console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);
    for (const note of r.notes) console.log(`    ${note}`);
  }

  const report = { gitSha: sha, startedAt, passed, failed, results };
  if (writeResult || jsonOutputPath) {
    const outPath =
      jsonOutputPath ?? join(HARNESS_PATHS.resultsDir, `${sha}-tool-suite-management.json`);
    await ensureDir(dirname(outPath));
    await Deno.writeTextFile(outPath, JSON.stringify(report, null, 2));
    console.log(`\n→ ${outPath}`);
  }

  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}

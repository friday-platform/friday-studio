/**
 * Reference validator for LLM-authored workspace configs.
 *
 * Runs at `POST /api/workspaces/create`, `PUT /api/workspaces/:id/config`, and
 * `POST /api/workspaces/:id/lint`. Catches the class of bug where an LLM
 * invents a reference (npm package, agent id, signal name, skill ref, model
 * id, memory store) that looks plausible but doesn't resolve — Yena's
 * knowledge-base workspace referenced `@joshuarileydev/sqlite-mcp-server`,
 * which doesn't exist on npm, and we only discovered that at runtime when
 * the MCP subprocess spawn failed.
 *
 * Hybrid failure model:
 *   - Registry-confirmed 404 / internal cross-ref miss / catalog miss → error
 *     (hard fail, caller returns 422 and does not persist).
 *   - Registry unreachable / 5xx / 401 / 403 → warning (persist with
 *     `validationWarnings` metadata; don't block import).
 *   - Per-server `skipResolverCheck: true` opts out of package resolution.
 *
 * The validator is pure and async. All external state flows in via
 * `ValidationContext` — no daemon-internal singletons. This is the test seam:
 * every reader is injected and trivially mockable.
 */

import type { JobExecutionAgent, WorkspaceConfig } from "@atlas/config";
import { extractFSMAgents, parseInlineFSM } from "@atlas/config/mutations";
import { mcpServersRegistry } from "./registry-consolidated.ts";

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * One problem found during validation. `path` is a YAML JSONPath-ish pointer
 * (`tools.mcp.servers.sqlite.args[1]`) so an LLM reading this back on its
 * correction turn can patch the exact field.
 */
export interface ValidationIssue {
  severity: "error" | "warning";
  code: ValidationIssueCode;
  path: string;
  message: string;
  /** The offending reference value, when applicable. */
  value?: string;
  /** Near-matches, when the validator has a useful suggestion to make. */
  suggest?: string[];
}

export type ValidationIssueCode =
  // Cross-refs within the same YAML
  | "unknown_agent_id"
  | "unknown_signal_name"
  | "unknown_mcp_server_ref"
  | "unknown_memory_store"
  | "unreachable_agent"
  | "job_without_trigger"
  // Cross-system
  | "unknown_skill"
  | "unknown_model"
  | "unknown_mount_workspace"
  // External packages
  | "npm_package_not_found"
  | "pypi_package_not_found"
  | "local_path_not_found"
  | "registry_unreachable"
  | "registry_auth_required"
  // FSM structure
  | "fsm_structural_error";

export interface ValidationReport {
  status: "ok" | "hard_fail" | "warn";
  issues: ValidationIssue[];
}

/**
 * Owns one ecosystem's command shape (e.g. `npx -y <pkg>`) and its registry
 * lookup (e.g. `registry.npmjs.org`). Adding a new ecosystem is a single
 * resolver added to the injected array.
 */
export interface PackageResolver {
  /** Does this command+args belong to my ecosystem? If so, what's the ref? */
  matches(command: string, args: readonly string[]): { ref: string } | null;

  /**
   * Is the ref a real thing in my registry? Distinguish:
   *   - `not_found` → hard fail (registry says it doesn't exist)
   *   - `unreachable` → soft fail (network/5xx; can't conclude)
   *   - `auth_required` → soft fail (401/403; likely private)
   */
  check(
    ref: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: "not_found" | "unreachable" | "auth_required"; suggest?: string[] }
  >;
}

export interface ValidationContext {
  resolvers: readonly PackageResolver[];
  skillDb: { has(namespace: string, name: string): Promise<boolean> };
  modelCatalog: { has(provider: string, modelId: string): boolean };
  workspaceList: { has(workspaceId: string): Promise<boolean> };
}

// ─── Entry point ───────────────────────────────────────────────────────────

/**
 * Run every check and aggregate. Passes never depend on each other — the
 * order below is authorial, not semantic. If one pass throws unexpectedly,
 * the others still run (a faulty resolver shouldn't hide a bad agentId).
 */
export async function validateWorkspaceConfig(
  config: WorkspaceConfig,
  ctx: ValidationContext,
): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [];

  const passes: Array<Promise<ValidationIssue[]>> = [
    Promise.resolve(checkInternalCrossRefs(config)),
    Promise.resolve(checkFsmStructures(config)),
    checkExternalPackages(config, ctx.resolvers),
    checkSkillRefs(config, ctx.skillDb),
    Promise.resolve(checkModelRefs(config, ctx.modelCatalog)),
    checkMountWorkspaces(config, ctx.workspaceList),
  ];

  const settled = await Promise.allSettled(passes);
  for (const result of settled) {
    if (result.status === "fulfilled") {
      issues.push(...result.value);
    }
    // Rejected passes are intentionally dropped — a broken pass should not
    // surface as user-facing validation noise. Upstream logging catches it.
  }

  const hasError = issues.some((i) => i.severity === "error");
  const hasWarning = issues.some((i) => i.severity === "warning");
  return { status: hasError ? "hard_fail" : hasWarning ? "warn" : "ok", issues };
}

// ─── Pass: internal cross-references ───────────────────────────────────────

function checkInternalCrossRefs(config: WorkspaceConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definedAgents = new Set(Object.keys(config.agents ?? {}));
  const definedSignals = new Set(Object.keys(config.signals ?? {}));
  const definedServers = new Set(
    Object.keys(
      (config.tools as { mcp?: { servers?: Record<string, unknown> } })?.mcp?.servers ?? {},
    ),
  );
  const ownMemory = new Set((config.memory?.own ?? []).map((m) => m.name));
  const mountMemory = new Set((config.memory?.mounts ?? []).map((m) => m.name));
  const definedMemory = new Set([...ownMemory, ...mountMemory]);

  const jobs = config.jobs ?? {};
  const handleChatJobs = new Set(["handle-chat"]);
  for (const [jobName, job] of Object.entries(jobs)) {
    // Chat ↔ jobs contract: jobs without a trigger signal are unreachable
    // from workspace-chat. `createJobTools` (which surfaces jobs as MCP
    // tools) skips any job whose `triggers[0].signal` is missing, so the
    // meta-agent silently can't see the job and falls back to hallucinating
    // plausible-sounding tool names. Reject the shape so the author either
    // adds a trigger + signal or removes the dead job.
    // `handle-chat` is auto-injected by the runtime and doesn't need a
    // trigger, so exempt it here.
    if (!handleChatJobs.has(jobName) && (job.triggers ?? []).length === 0) {
      issues.push({
        severity: "error",
        code: "job_without_trigger",
        path: `jobs.${jobName}.triggers`,
        value: jobName,
        message:
          `Job '${jobName}' has no triggers. Chat reaches a workspace through ` +
          `signal-triggered jobs; a job with no 'triggers[]' entry is unreachable ` +
          `and won't appear as a tool. Add a signal under signals.* and reference ` +
          `it: triggers: [{ signal: '<signal-name>' }].`,
      });
    }
    // Every trigger's signal must be defined.
    for (const [i, trigger] of (job.triggers ?? []).entries()) {
      if (trigger.signal && !definedSignals.has(trigger.signal)) {
        issues.push({
          severity: "error",
          code: "unknown_signal_name",
          path: `jobs.${jobName}.triggers[${i}].signal`,
          value: trigger.signal,
          message:
            `Job '${jobName}' triggers on signal '${trigger.signal}', ` +
            `but no such signal is defined under signals.*. ` +
            `Define the signal, or remove the trigger.`,
          suggest: nearestStrings(trigger.signal, [...definedSignals]),
        });
      }
    }

    // Every agent referenced by execution-style jobs must be defined.
    for (const [i, agentSpec] of (job.execution?.agents ?? []).entries()) {
      const id = agentIdFromSpec(agentSpec);
      if (id && !definedAgents.has(id)) {
        issues.push({
          severity: "error",
          code: "unknown_agent_id",
          path: `jobs.${jobName}.execution.agents[${i}]`,
          value: id,
          message:
            `Job '${jobName}' references agent '${id}', ` +
            `but no such agent is defined under agents.*.`,
          suggest: nearestStrings(id, [...definedAgents]),
        });
      }
    }

    // `outputs.memory` must resolve.
    if (job.outputs?.memory && !definedMemory.has(job.outputs.memory)) {
      issues.push({
        severity: "error",
        code: "unknown_memory_store",
        path: `jobs.${jobName}.outputs.memory`,
        value: job.outputs.memory,
        message:
          `Job '${jobName}' writes output to memory '${job.outputs.memory}', ` +
          `but no such store exists under memory.own or memory.mounts.`,
        suggest: nearestStrings(job.outputs.memory, [...definedMemory]),
      });
    }
  }

  // Every agent referenced inside any FSM must be defined.
  const fsmAgents = extractFSMAgents(config);
  const referencedAgentIds = new Set<string>();
  for (const response of Object.values(fsmAgents)) {
    if (response.type !== "agent") continue;
    const id = response.agentId;
    if (!id) continue;
    referencedAgentIds.add(id);
    if (definedAgents.has(id)) continue;
    issues.push({
      severity: "error",
      code: "unknown_agent_id",
      path: `jobs.${response.jobId}.fsm.states.${response.stateId}.entry[${response.entryIndex}].agentId`,
      value: id,
      message:
        `Job '${response.jobId}' FSM state '${response.stateId}' references agent '${id}', ` +
        `but no such agent is defined under agents.*.`,
      suggest: nearestStrings(id, [...definedAgents]),
    });
  }
  // Execution-style jobs reference agents too — count them as reached.
  for (const job of Object.values(jobs)) {
    for (const agentSpec of job.execution?.agents ?? []) {
      const id = agentIdFromSpec(agentSpec);
      if (id) referencedAgentIds.add(id);
    }
  }

  // Chat ↔ jobs contract: chat can only call agents through jobs. An agent
  // declared but never invoked by any FSM or execution-style job is
  // unreachable from chat and produces the "silent save failure" pattern —
  // user types "save this", the workspace-chat meta-agent has no tool for
  // the declared agent, falls back to defaults, and the intended pipeline
  // never runs. Reject the config so the author either wraps the agent in
  // a job or removes it.
  for (const agentId of definedAgents) {
    if (referencedAgentIds.has(agentId)) continue;
    issues.push({
      severity: "error",
      code: "unreachable_agent",
      path: `agents.${agentId}`,
      value: agentId,
      message:
        `Agent '${agentId}' is declared but no job's FSM or execution invokes it. ` +
        `Chat reaches the workspace through jobs; agents declared without a wrapping ` +
        `job are unreachable and silently ignored at runtime. Either wrap it in a ` +
        `job (add a state whose 'entry' includes { type: agent, agentId: '${agentId}' }), ` +
        `or delete the agent and use platform tools (memory_save, etc.) ` +
        `directly from chat.`,
    });
  }

  // Agent tools referencing MCP servers: warn on near-miss typos.
  // Tools can also be platform-provided strings (memory_*, bash, etc.) so we
  // only surface when the name looks like a typo of a declared server.
  for (const [agentName, agent] of Object.entries(config.agents ?? {})) {
    const tools = (agent as { config?: { tools?: unknown } }).config?.tools;
    const toolList = Array.isArray(tools) ? tools : [];
    for (const [i, tool] of toolList.entries()) {
      if (typeof tool !== "string") continue;
      if (definedServers.has(tool)) continue;
      const suggest = nearestStrings(tool, [...definedServers]);
      if (suggest.length === 0) continue;
      issues.push({
        severity: "warning",
        code: "unknown_mcp_server_ref",
        path: `agents.${agentName}.config.tools[${i}]`,
        value: tool,
        message:
          `Agent '${agentName}' lists tool '${tool}', which is not a declared ` +
          `MCP server in tools.mcp.servers.* and looks like a near-match to one ` +
          `that is. If this is a platform tool (memory_save, bash, etc.) you ` +
          `can ignore this warning.`,
        suggest,
      });
    }
  }

  return issues;
}

// ─── Pass: FSM structural validation ───────────────────────────────────────

/**
 * Reject FSM shapes that won't execute at runtime. Catches the failure mode
 * where an LLM emits a plausible-looking state machine with the wrong schema
 * (state.type="action", action: {...}, next: "..." — vs. the real schema's
 * entry: [...] + on: {EVENT: {target: ...}}). Without this pass, the
 * workspace imports fine, the lint endpoint says "ok", and the first signal
 * dispatch returns 500 with a Zod parse error.
 *
 * Each Zod issue becomes one ValidationIssue so the LLM reading the response
 * can patch the exact broken field rather than one error about a top-level
 * FSM blob.
 */
function checkFsmStructures(config: WorkspaceConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const jobs = config.jobs ?? {};
  for (const [jobName, job] of Object.entries(jobs)) {
    if (!job.fsm) continue;
    const parsed = parseInlineFSM(job.fsm, jobName);
    if (parsed.success) continue;
    for (const issue of parsed.error.issues) {
      const zodPath = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
      issues.push({
        severity: "error",
        code: "fsm_structural_error",
        path: `jobs.${jobName}.fsm${zodPath}`,
        message:
          `Job '${jobName}' FSM is structurally invalid at '${issue.path.join(".") || "<root>"}': ` +
          `${issue.message}. ` +
          `FSM states must use { entry: [...actions], on: { EVENT: { target: "next-state" } } } — ` +
          `not { type: "action", action: {...}, next: "..." }. The only valid state.type value is "final".`,
      });
    }
  }
  return issues;
}

// ─── Pass: external package resolution ─────────────────────────────────────

async function checkExternalPackages(
  config: WorkspaceConfig,
  resolvers: readonly PackageResolver[],
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const servers = ((config.tools as { mcp?: { servers?: Record<string, unknown> } })?.mcp
    ?.servers ?? {}) as Record<string, McpServerLike>;

  const checks: Array<Promise<void>> = [];

  for (const [serverName, server] of Object.entries(servers)) {
    if (server.skipResolverCheck) continue;
    const transport = server.transport;
    if (!transport || transport.type !== "stdio") continue;
    if (typeof transport.command !== "string") continue;
    const args = Array.isArray(transport.args) ? transport.args.map(String) : [];

    // Fast path: blessed MCP registry entries are known-good, skip network.
    if (isBlessedTransport(transport.command, args)) continue;

    // Find the resolver that owns this command shape.
    let matched: { resolver: PackageResolver; ref: string } | null = null;
    for (const resolver of resolvers) {
      const m = resolver.matches(transport.command, args);
      if (m) {
        matched = { resolver, ref: m.ref };
        break;
      }
    }
    if (!matched) continue; // unknown command shape — out of our scope, leave alone
    const found = matched;

    checks.push(
      (async () => {
        const result = await found.resolver
          .check(found.ref)
          .catch<{ ok: false; reason: "unreachable" }>(() => ({
            ok: false,
            reason: "unreachable",
          }));

        if (result.ok) return;

        const path = `tools.mcp.servers.${serverName}.transport.args`;
        if (result.reason === "not_found") {
          issues.push({
            severity: "error",
            code: codeForCommand(transport.command ?? ""),
            path,
            value: found.ref,
            message:
              `MCP server '${serverName}' is configured to spawn ` +
              `'${transport.command} ${args.join(" ")}', but the package ` +
              `'${found.ref}' does not exist in its registry. This is the ` +
              `single biggest failure mode for LLM-authored MCP configs — ` +
              `the package name is likely hallucinated.`,
            suggest: result.suggest,
          });
        } else if (result.reason === "auth_required") {
          issues.push({
            severity: "warning",
            code: "registry_auth_required",
            path,
            value: found.ref,
            message:
              `Package registry required auth to resolve '${found.ref}' ` +
              `(likely private-scope). Skipping existence check. If this is ` +
              `intentional, set tools.mcp.servers.${serverName}.skipResolverCheck = true ` +
              `to suppress this warning.`,
          });
        } else {
          issues.push({
            severity: "warning",
            code: "registry_unreachable",
            path,
            value: found.ref,
            message:
              `Could not reach package registry to verify '${found.ref}'. ` +
              `Accepting the config, but we can't confirm the package exists.`,
          });
        }
      })(),
    );
  }

  await Promise.all(checks);
  return issues;
}

interface McpServerLike {
  transport?: { type?: string; command?: string; args?: unknown[] };
  skipResolverCheck?: boolean;
}

/**
 * Does this (command, args) match a known blessed MCP server entry? If so,
 * we skip network resolution — blessed entries are curated and the package
 * is known to exist. Comparison is exact on command + args tuple.
 *
 * Blessed entries nest transport under `configTemplate.transport`; we
 * reach through that.
 */
function isBlessedTransport(command: string, args: readonly string[]): boolean {
  for (const server of Object.values(mcpServersRegistry.servers)) {
    const transport = (
      server as { configTemplate?: { transport?: { command?: string; args?: string[] } } }
    ).configTemplate?.transport;
    if (!transport?.command) continue;
    if (transport.command !== command) continue;
    if (!Array.isArray(transport.args)) continue;
    if (transport.args.length !== args.length) continue;
    if (transport.args.every((a, i) => a === args[i])) return true;
  }
  return false;
}

function codeForCommand(command: string): ValidationIssueCode {
  if (command === "npx" || command === "bunx" || command === "pnpm") return "npm_package_not_found";
  if (command === "uvx" || command === "pipx") return "pypi_package_not_found";
  if (command.startsWith("/") || command.startsWith("./") || command.startsWith("../")) {
    return "local_path_not_found";
  }
  return "npm_package_not_found";
}

// ─── Pass: skill references ────────────────────────────────────────────────

async function checkSkillRefs(
  config: WorkspaceConfig,
  skillDb: ValidationContext["skillDb"],
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const checks: Array<Promise<void>> = [];

  const skills = config.skills ?? [];
  for (const [i, skill] of skills.entries()) {
    const name = (skill as { name?: string }).name;
    if (!name) continue;
    checks.push(
      checkOneSkill(name, `skills[${i}].name`, skillDb).then((issue) => {
        if (issue) issues.push(issue);
      }),
    );
  }

  // Also check job-level skill refs.
  const jobs = config.jobs ?? {};
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const [i, skill] of (job.skills ?? []).entries()) {
      const name = (skill as { name?: string }).name;
      if (!name) continue;
      checks.push(
        checkOneSkill(name, `jobs.${jobName}.skills[${i}].name`, skillDb).then((issue) => {
          if (issue) issues.push(issue);
        }),
      );
    }
  }

  await Promise.all(checks);
  return issues;
}

async function checkOneSkill(
  ref: string,
  path: string,
  skillDb: ValidationContext["skillDb"],
): Promise<ValidationIssue | null> {
  const parsed = /^@([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(ref);
  if (!parsed) return null; // malformed — Zod catches this
  const [, namespace, name] = parsed;
  if (!namespace || !name) return null;
  // Friday's built-in namespaces are always available.
  if (namespace === "friday" || namespace === "atlas") return null;
  // Swallowed failures default to "exists" — a broken DB reader shouldn't
  // block workspace creation. Upstream logging catches the broken read.
  const exists = await skillDb.has(namespace, name).catch(() => true);
  if (exists) return null;
  return {
    severity: "error",
    code: "unknown_skill",
    path,
    value: ref,
    message:
      `Skill '${ref}' is referenced but not installed. Install it via the ` +
      `skills registry before importing this workspace.`,
  };
}

// ─── Pass: model references ────────────────────────────────────────────────

function checkModelRefs(
  config: WorkspaceConfig,
  modelCatalog: ValidationContext["modelCatalog"],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const agents = config.agents ?? {};
  for (const [agentName, agent] of Object.entries(agents)) {
    const cfg = (agent as { config?: { provider?: string; model?: string } }).config;
    if (!cfg?.provider || !cfg?.model) continue;
    if (modelCatalog.has(cfg.provider, cfg.model)) continue;
    issues.push({
      severity: "error",
      code: "unknown_model",
      path: `agents.${agentName}.config.model`,
      value: `${cfg.provider}:${cfg.model}`,
      message:
        `Agent '${agentName}' is configured with model '${cfg.provider}:${cfg.model}', ` +
        `which is not in the platform model catalog. Check the provider ID and ` +
        `model ID for typos.`,
    });
  }
  return issues;
}

// ─── Pass: memory mount workspaces ─────────────────────────────────────────

async function checkMountWorkspaces(
  config: WorkspaceConfig,
  workspaceList: ValidationContext["workspaceList"],
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const mounts = config.memory?.mounts ?? [];
  const checks: Array<Promise<void>> = [];
  for (const [i, mount] of mounts.entries()) {
    const source = mount.source;
    // Schema shape: "{workspaceId|_global}/{kind}/{memoryName}".
    const parsed = /^([a-zA-Z0-9_][a-zA-Z0-9_-]*)\//.exec(source);
    if (!parsed) continue;
    const workspaceId = parsed[1];
    if (!workspaceId || workspaceId === "_global") continue;
    checks.push(
      (async () => {
        const exists = await workspaceList.has(workspaceId).catch(() => true);
        if (exists) return;
        issues.push({
          severity: "error",
          code: "unknown_mount_workspace",
          path: `memory.mounts[${i}].source`,
          value: source,
          message:
            `Memory mount references workspace '${workspaceId}', which does ` +
            `not exist. Either create the workspace first, or remove the mount.`,
        });
      })(),
    );
  }
  await Promise.all(checks);
  return issues;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function agentIdFromSpec(spec: JobExecutionAgent): string | null {
  if (typeof spec === "string") return spec;
  if (typeof spec === "object" && spec !== null && typeof spec.id === "string") return spec.id;
  return null;
}

/**
 * Tiny edit-distance near-miss detector. Good enough for "did you mean X?"
 * suggestions. Not a full spell checker — just enough to spot typos.
 */
function nearestStrings(target: string, pool: readonly string[], maxSuggestions = 2): string[] {
  if (target.length === 0 || pool.length === 0) return [];
  const threshold = Math.max(1, Math.floor(target.length / 3));
  const scored = pool
    .map((candidate) => ({ candidate, distance: editDistance(target, candidate) }))
    .filter((x) => x.distance > 0 && x.distance <= threshold)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxSuggestions);
  return scored.map((x) => x.candidate);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr: number[] = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

import { PLATFORM_TOOL_NAMES } from "@atlas/agent-sdk";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { extractFSMAgents } from "./mutations/fsm-agents.ts";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "./workspace.ts";

const AgentIdSpecSchema = z.union([z.string(), z.object({ id: z.string() })]);

// ==============================================================================
// TYPES
// ==============================================================================

/**
 * A single validation issue with a dot-notation path and plain-English message.
 */
export interface Issue {
  /** Issue code (e.g., "invalid_type", "unknown_agent_id", "missing_tools_array") */
  code: string;
  /** Dot-notation path into the config object (e.g., "agents.email-triager.config.model") */
  path: string;
  /** Human-readable error or warning message */
  message: string;
}

/**
 * Result of validating a workspace configuration.
 */
export interface ValidationReport {
  /** Overall validation status */
  status: "ok" | "warning" | "error";
  /** Issues that block publish */
  errors: Issue[];
  /** Issues that do not block publish */
  warnings: Issue[];
}

/**
 * External registry for reference-integrity checks.
 */
export interface Registry {
  /** Enabled MCP server IDs */
  mcpServers?: string[];
  /** serverId -> tool names */
  mcpTools?: Record<string, string[]>;
}

// ==============================================================================
// VALIDATOR
// ==============================================================================

/**
 * Validate a parsed workspace configuration.
 *
 * Three layers:
 * 1. Structural — walks ZodError.issues[] and emits one Issue per Zod issue.
 * 2. Reference integrity — agent IDs, tool names, memory names.
 * 3. Semantic warnings — missing_tools_array, dead_signal, orphan_agent,
 *    cron_parse_failed, http_path_collision.
 *
 * @param parsedConfig - The parsed workspace configuration object (typically from YAML)
 * @param registry - External registry for MCP server/tool existence checks
 * @returns ValidationReport with status, errors, and warnings
 */
export function validateWorkspace(
  parsedConfig: unknown,
  registry: Registry = {},
): ValidationReport {
  const parseResult = WorkspaceConfigSchema.safeParse(parsedConfig);

  if (!parseResult.success) {
    const errors: Issue[] = parseResult.error.issues.map((issue) => ({
      code: issue.code,
      path: flattenPath(
        issue.path.filter(
          (p): p is string | number => typeof p === "string" || typeof p === "number",
        ),
      ),
      message: issue.message,
    }));

    return { status: "error", errors, warnings: [] };
  }

  const config = parseResult.data;
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  // ── Reference integrity ────────────────────────────────────────────────────
  checkAgentReferences(config, errors);
  checkToolReferences(config, registry, errors);
  checkMemoryReferences(config, errors);

  // ── Semantic warnings ──────────────────────────────────────────────────────
  checkMissingToolsArray(config, warnings);
  checkDeadSignals(config, warnings);
  checkOrphanAgents(config, warnings);
  checkCronParseFailed(config, warnings);
  checkHttpPathCollision(config, warnings);

  if (errors.length > 0) {
    return { status: "error", errors, warnings };
  }
  if (warnings.length > 0) {
    return { status: "warning", errors: [], warnings };
  }
  return { status: "ok", errors: [], warnings: [] };
}

// ==============================================================================
// REFERENCE INTEGRITY
// ==============================================================================

function checkAgentReferences(config: WorkspaceConfig, issues: Issue[]): void {
  const definedAgents = new Set(Object.keys(config.agents ?? {}));
  const fsmAgents = extractFSMAgents(config);

  for (const response of Object.values(fsmAgents)) {
    if (response.type !== "agent") continue;
    const agentId = response.agentId;
    if (!agentId) continue;
    if (definedAgents.has(agentId)) continue;
    issues.push({
      code: "unknown_agent_id",
      path: `jobs.${response.jobId}.fsm.states.${response.stateId}.entry[${response.entryIndex}].agentId`,
      message:
        `Job '${response.jobId}' FSM state '${response.stateId}' references agent '${agentId}', ` +
        `but no such agent is defined under agents.*.`,
    });
  }
}

function checkToolReferences(config: WorkspaceConfig, registry: Registry, issues: Issue[]): void {
  const validTools = new Set(PLATFORM_TOOL_NAMES);
  const serverPrefixes = new Set<string>();
  // serverId -> Set<bareToolName> for precise prefixed-tool verification
  const serverTools = new Map<string, Set<string>>();

  if (registry.mcpTools) {
    const enabledServers = registry.mcpServers
      ? new Set(registry.mcpServers)
      : new Set(Object.keys(registry.mcpTools));

    for (const [serverId, tools] of Object.entries(registry.mcpTools)) {
      if (!enabledServers.has(serverId)) continue;
      serverPrefixes.add(serverId);
      const bareSet = new Set<string>();
      for (const tool of tools) {
        validTools.add(tool);
        bareSet.add(tool);
      }
      serverTools.set(serverId, bareSet);
    }
  }

  // Also accept tools from servers declared in workspace config (static resolution
  // when the server is configured but not yet running / enumerable).
  for (const serverId of Object.keys(config.tools?.mcp?.servers ?? {})) {
    serverPrefixes.add(serverId);
  }

  for (const [agentName, agent] of Object.entries(config.agents ?? {})) {
    if (agent.type !== "llm" && agent.type !== "system") continue;
    const tools = agent.config?.tools;
    if (!Array.isArray(tools)) continue;
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];
      if (typeof tool !== "string") continue;
      if (validTools.has(tool)) continue;

      const prefix = tool.split("/")[0];
      if (prefix) {
        const bareName = tool.slice(prefix.length + 1);
        if (serverTools.has(prefix)) {
          // Registry has resolved tools for this server — verify the bare name exists
          if (serverTools.get(prefix)?.has(bareName)) continue;
          // Registry has this server but not this tool — do NOT fall back to
          // static acceptance. The server was probed and this tool is unknown.
        } else if (serverPrefixes.has(prefix)) {
          // No registry data for this declared server — static fallback
          continue;
        }
      }

      issues.push({
        code: "unknown_tool",
        path: `agents.${agentName}.config.tools[${i}]`,
        message:
          `Agent '${agentName}' lists tool '${tool}', which is not a built-in platform tool ` +
          `and does not resolve to any enabled MCP server tool.`,
      });
    }
  }
}

function checkMemoryReferences(config: WorkspaceConfig, issues: Issue[]): void {
  const declaredMemory = new Set([
    ...(config.memory?.own ?? []).map((m) => m.name),
    ...(config.memory?.mounts ?? []).map((m) => m.name),
  ]);

  for (const [agentName, agent] of Object.entries(config.agents ?? {})) {
    const textFields: string[] = [];
    if (agent.description) textFields.push(agent.description);
    if (agent.type === "llm" && agent.config?.prompt) {
      textFields.push(agent.config.prompt);
    }
    if (agent.type === "system" && agent.config?.prompt) {
      textFields.push(agent.config.prompt);
    }
    if (agent.type === "user" && agent.prompt) {
      textFields.push(agent.prompt);
    }

    for (const text of textFields) {
      const refs = findMemoryReferences(text);
      for (const ref of refs) {
        if (declaredMemory.has(ref)) continue;
        issues.push({
          code: "unknown_memory_store",
          path: `agents.${agentName}`,
          message:
            `Agent '${agentName}' references memory '${ref}', ` +
            `but no such store exists under memory.own or memory.mounts.`,
        });
      }
    }
  }
}

// ==============================================================================
// SEMANTIC WARNINGS
// ==============================================================================

function checkMissingToolsArray(config: WorkspaceConfig, issues: Issue[]): void {
  const hasMcpServers = Object.keys(config.tools?.mcp?.servers ?? {}).length > 0;
  if (!hasMcpServers) return;

  for (const [agentName, agent] of Object.entries(config.agents ?? {})) {
    if (agent.type !== "llm") continue;
    const toolChoice = agent.config?.tool_choice;
    const tools = agent.config?.tools;
    if (toolChoice !== "auto") continue;
    if (Array.isArray(tools) && tools.length > 0) continue;
    issues.push({
      code: "missing_tools_array",
      path: `agents.${agentName}.config.tools`,
      message:
        `Agent '${agentName}' has tool_choice: auto but no tools array. ` +
        `When MCP servers are configured, explicitly list the tools this agent may call.`,
    });
  }
}

function checkDeadSignals(config: WorkspaceConfig, issues: Issue[]): void {
  const triggeredSignals = new Set<string>();
  for (const job of Object.values(config.jobs ?? {})) {
    for (const trigger of job.triggers ?? []) {
      if (trigger.signal) triggeredSignals.add(trigger.signal);
    }
  }

  for (const signalName of Object.keys(config.signals ?? {})) {
    if (triggeredSignals.has(signalName)) continue;
    issues.push({
      code: "dead_signal",
      path: `signals.${signalName}`,
      message:
        `Signal '${signalName}' is declared but no job triggers on it. ` +
        `Remove the signal or add a job trigger.`,
    });
  }
}

function checkOrphanAgents(config: WorkspaceConfig, issues: Issue[]): void {
  const referencedAgentIds = new Set<string>();

  // FSM references
  const fsmAgents = extractFSMAgents(config);
  for (const response of Object.values(fsmAgents)) {
    if (response.type === "agent" && response.agentId) {
      referencedAgentIds.add(response.agentId);
    }
  }

  // Execution-style job references
  for (const job of Object.values(config.jobs ?? {})) {
    for (const spec of job.execution?.agents ?? []) {
      const id = agentIdFromSpec(spec);
      if (id) referencedAgentIds.add(id);
    }
  }

  for (const agentId of Object.keys(config.agents ?? {})) {
    if (referencedAgentIds.has(agentId)) continue;
    issues.push({
      code: "orphan_agent",
      path: `agents.${agentId}`,
      message:
        `Agent '${agentId}' is declared but not referenced by any job. ` +
        `Wrap it in a job or remove it.`,
    });
  }
}

function checkCronParseFailed(config: WorkspaceConfig, issues: Issue[]): void {
  for (const [signalName, sig] of Object.entries(config.signals ?? {})) {
    if (sig.provider !== "schedule") continue;
    try {
      CronExpressionParser.parse(sig.config.schedule);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push({
        code: "cron_parse_failed",
        path: `signals.${signalName}.config.schedule`,
        message: `Signal '${signalName}' has invalid cron expression '${sig.config.schedule}': ${message}.`,
      });
    }
  }
}

function checkHttpPathCollision(config: WorkspaceConfig, issues: Issue[]): void {
  const pathToSignals = new Map<string, string[]>();

  for (const [signalName, signal] of Object.entries(config.signals ?? {})) {
    if (signal.provider !== "http") continue;
    const path = signal.config.path;
    if (!path) continue;
    const existing = pathToSignals.get(path) ?? [];
    existing.push(signalName);
    pathToSignals.set(path, existing);
  }

  for (const [path, signalNames] of pathToSignals.entries()) {
    if (signalNames.length < 2) continue;
    issues.push({
      code: "http_path_collision",
      path: `signals.${signalNames[0]}.config.path`,
      message:
        `HTTP path '${path}' is used by multiple signals: ${signalNames.join(", ")}. ` +
        `Each HTTP signal must have a unique path.`,
    });
  }
}

// ==============================================================================
// HELPERS
// ==============================================================================

/**
 * Flatten a Zod issue path array into dot-notation.
 *
 * Array indices are kept in bracket notation for readability.
 *
 * @example
 * ["signals", "review-inbox", "config", "path"] → "signals.review-inbox.config.path"
 * ["memory", "mounts", 0, "source"] → "memory.mounts[0].source"
 */
function flattenPath(path: (string | number)[]): string {
  let result = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      result += `[${segment}]`;
    } else {
      result += result.length > 0 ? `.${segment}` : segment;
    }
  }
  return result;
}

function findMemoryReferences(text: string): string[] {
  const refs = new Set<string>();

  // Quoted string followed by memory/corpus/store
  const quotedPattern = /["']([a-zA-Z0-9_-]+)["']\s+(memory|corpus|store)\b/g;

  let match = quotedPattern.exec(text);
  while (match !== null) {
    const name = match[1];
    if (name) refs.add(name);
    match = quotedPattern.exec(text);
  }

  return [...refs];
}

function agentIdFromSpec(spec: unknown): string | null {
  const result = AgentIdSpecSchema.safeParse(spec);
  if (!result.success) return null;
  if (typeof result.data === "string") return result.data;
  return result.data.id;
}

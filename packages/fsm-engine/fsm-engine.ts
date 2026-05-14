/**
 * FSMEngine - FSM execution engine.
 *
 * Executes FSMDefinition entry actions of type llm, agent, emit, or notification.
 */

import {
  type AgentResult as AgentSDKExecutionResult,
  type ArtifactRef,
  type FailInput,
  FailInputSchema,
  PLATFORM_TOOL_NAMES,
} from "@atlas/agent-sdk";
import { extractToolCallInput, unstringifyNestedJson } from "@atlas/agent-sdk/vercel-helpers";
import type { MCPServerConfig, ValidationDefaults, WorkspaceMCPServerConfig } from "@atlas/config";
import { normalizeActionValidate, resolveValidation } from "@atlas/config";
import { resolvePermissions } from "@atlas/config/permissions";
import {
  createErrorCause,
  hasUnusableCredentialCause,
  isAPIErrorCause,
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  LLM_AGENT_ALLOWED_PLATFORM_TOOLS,
  NoDefaultCredentialError,
  UserConfigurationError,
  wrapPlatformToolsWithScope,
} from "@atlas/core";
import {
  composeArtifactBlocks,
  composeMemoryBlocks,
  composeValidationBlock,
} from "@atlas/core/agent-context/compose-blocks";
import {
  createRecordValidationTool,
  RECORD_VALIDATION_TOOL_NAME,
} from "@atlas/core/agent-context/record-validation-tool";
import type { ArtifactStorageAdapter } from "@atlas/core/artifacts";
import { resolveImageParts } from "@atlas/core/artifacts/images";
import { liftToolResultsForPersist } from "@atlas/core/artifacts/scrubber";
import { createDelegateTool, DEFAULT_MAX_DEPTH } from "@atlas/core/delegate";
import type { LinkSummary } from "@atlas/core/mcp-registry/discovery";
import { ValidationFailedError, type ValidationVerdict } from "@atlas/hallucination/verdict";
import { buildTemporalFacts, type PlatformModels, wrapRetrieved } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { createMCPTools, type MCPToolsResult } from "@atlas/mcp";
import { getAtlasPlatformServerConfig } from "@atlas/oapi-client";
import type { SkillSummary } from "@atlas/skills";
import {
  createLoadSkillTool,
  formatAvailableSkills,
  resolveVisibleSkills,
  SkillStorage,
} from "@atlas/skills";
import { stringifyError } from "@atlas/utils";
import { type Span as OtelSpan, withOtelSpan } from "@atlas/utils/telemetry.server";
import {
  type ImagePart,
  type ModelMessage,
  type Tool,
  type ToolCallRepairFunction,
  tool,
  type UIMessageStreamWriter,
} from "ai";
import { z } from "zod";
import type { DocumentScope, DocumentStore } from "../document-store/mod.ts";
import { expandArtifactRefsInInput } from "./artifact-expansion.ts";
import { FSMDocumentDataSchema } from "./document-schemas.ts";
import { hasDefinedSchema } from "./schema-utils.ts";
import * as serializer from "./serializer.ts";
import { applySkillAllowlist, unmatchedAllowlistEntries } from "./skill-filter.ts";
import type {
  Action,
  AgentAction,
  AgentResult,
  Context,
  Document,
  EmittedEvent,
  FSMActionExecutionEvent,
  FSMBroadcastNotifier,
  FSMDefinition,
  FSMLLMOutput,
  JudgeAgentRunner,
  JudgeHandoff,
  JudgeToolCallEntry,
  LLMAction,
  LLMActionTrace,
  LLMProvider,
  Signal,
  SignalWithContext,
  TransitionDefinition,
  ValidateStrategy,
} from "./types.ts";
import {
  type ClassifierInput,
  classifyAction,
  type MCPValidationOverride,
  type ValidateDecision,
} from "./validate-classifier.ts";

/**
 * Resolve the final `ValidateDecision` + skill for an action, factoring
 * in workspace + job-level defaults.
 *
 * Precedence (strategy and skill independently):
 *   action.validate
 *     > job.validation.default
 *     > workspace.validation.default
 *     > "auto"  (the runtime classifier)
 *
 * `resolveValidation` (in @atlas/config) does the merge across the three
 * config tiers; if the merged strategy is `"auto"`, we hand off to
 * `classifyAction` for the final decision. Skill is propagated up so the
 * orchestrator-side prompt-assembly site (case "agent") and the inline
 * prompt builder (case "llm") can pass it to `composeValidationBlock`
 * without re-running the merge.
 *
 * The classifier's `external` decision remains unreachable from `auto`
 * — the classifier itself enforces this so picking the slower
 * separate-judge path stays an explicit opt-in.
 */
function resolveValidateDecision(
  explicit: ValidateStrategy | undefined,
  classifierInput: ClassifierInput,
  defaults: { job?: ValidationDefaults; workspace?: ValidationDefaults } = {},
): {
  decision: ValidateDecision;
  source: "explicit" | "auto" | "merged-default";
  reason: string;
  skill?: string;
} {
  const merged = resolveValidation({
    action: normalizeActionValidate(explicit),
    job: defaults.job,
    workspace: defaults.workspace,
  });

  // Carry the merged skill forward so callers don't have to re-derive
  // it. `composeValidationBlock` defaults to DEFAULT_VALIDATION_SKILL
  // when caller passes undefined; we only forward the resolved skill
  // when at least one tier set it (preserves "explicit when explicit"
  // semantics for the observability log).
  const explicitSkillSet =
    (typeof explicit === "object" && explicit.skill !== undefined) ||
    defaults.job?.skill !== undefined ||
    defaults.workspace?.skill !== undefined;
  const skill = explicitSkillSet ? merged.skill : undefined;

  if (merged.strategy === "auto") {
    const auto = classifyAction(classifierInput);
    return {
      decision: auto.decision,
      source: "auto",
      reason: auto.reason,
      ...(skill !== undefined ? { skill } : {}),
    };
  }

  // The merged strategy came from action / job / workspace — record
  // which level supplied it so the observability log stays useful.
  // Action wins → `explicit`; otherwise → `merged-default`.
  if (typeof explicit === "string" && explicit !== "auto") {
    return {
      decision: explicit,
      source: "explicit",
      reason: `explicit:${explicit}`,
      ...(skill !== undefined ? { skill } : {}),
    };
  }
  if (typeof explicit === "object") {
    return {
      decision: explicit.strategy,
      source: "explicit",
      reason: `explicit-object:${explicit.strategy}`,
      ...(skill !== undefined ? { skill } : {}),
    };
  }
  return {
    decision: merged.strategy,
    source: "merged-default",
    reason: `merged-default:${merged.strategy}`,
    ...(skill !== undefined ? { skill } : {}),
  };
}

/**
 * Platform tools exposed to FSM LLM steps.
 *
 * Mirrors the allowlist used by `runtime.executeCodeAgent` and
 * `routes/agents/run.ts` so all three LLM-agent execution paths see the
 * same surface (fs_*, bash, csv, plus the scope-injected
 * subset for memory/artifacts/state/webfetch). Pre-fix this aliased
 * SCOPE_INJECTED_PLATFORM_TOOLS instead, which silently stripped
 * fs_write_file etc. from FSM LLM steps and broke the canonical
 * "write-file-then-artifacts_create" pattern documented in the
 * writing-to-memory skill. The wrap step below still uses the narrower
 * SCOPE_INJECTED set — only that subset needs workspace-id injection.
 */
const PLATFORM_TOOL_ALLOWLIST = LLM_AGENT_ALLOWED_PLATFORM_TOOLS;

const FSMStateSchema = z.object({ state: z.string() });

const PrepareResultSchema = z
  .object({ task: z.string().optional(), config: z.record(z.string(), z.unknown()).optional() })
  .passthrough();

type PrepareResult = z.infer<typeof PrepareResultSchema>;

/**
 * Resolve `{{inputs.x}}`, `{{config.x}}`, and `{{signal.payload.x}}` refs in
 * an agent prompt against the prepare-result payload. LLM-authored workspaces
 * routinely write these placeholders (it's the convention in every other agent
 * framework) and the LLM refuses when they come through unrendered ("required
 * input values are missing"). Dotted paths are supported for nested values;
 * unresolved placeholders are kept verbatim so typos stay visible during
 * authoring rather than silently rendering as empty strings.
 *
 * A Liquid-style `| default: 'fallback'` filter is supported on the placeholder
 * itself (`{{inputs.style | default: 'classic'}}`); it kicks in when the path
 * resolves to undefined, null, or empty string, matching Liquid's default
 * semantics. UI forms commonly submit "" for unfilled optional fields, and
 * substituting an empty string instead of the fallback would make the filter
 * useless for its primary use case. Both single- and double-quoted fallback
 * literals are accepted. Numbers/booleans (including 0/false) are not treated
 * as missing — those are legitimate values, not absence.
 *
 * Uses only properties already exposed via `PrepareResult` (`task`, `config`,
 * `artifactRefs`); does not reach into ambient FSM state, so there's no way
 * an agent's prompt can smuggle context from outside its invocation payload.
 */
export function interpolatePromptPlaceholders(
  prompt: string,
  prepareResult: PrepareResult | undefined,
): string {
  const config = prepareResult?.config ?? {};
  // Expose the same bag under multiple well-known roots — different agent
  // frameworks use different names for this, and the cost of accepting all
  // three is one line per alias. `inputs.*` is the most common.
  const scopes: Record<string, unknown> = { inputs: config, config, signal: { payload: config } };
  // Pattern: `{{ path[ | default: 'literal' ] }}`
  // - path: dotted identifier; segments may contain hyphens. Hyphens are
  //   needed because `inputFrom: pick-result` exposes a hyphenated key in
  //   the config bag — without hyphen support, `{{config.pick-result.ticketId}}`
  //   would silently fall through as a literal string.
  // - optional `| default: '...'` (single or double quoted) supplies a fallback
  //   when the path is missing — matches Liquid/Jinja convention used by most
  //   prompt-templating frameworks.
  const placeholderRe =
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*(?:\|\s*default\s*:\s*(?:'([^']*)'|"([^"]*)"))?\s*\}\}/g;
  return prompt.replace(placeholderRe, (original, path, sq, dq) => {
    const fallback: string | undefined = sq ?? dq;
    const segments = String(path).split(".");
    let cursor: unknown = scopes;
    for (const segment of segments) {
      if (cursor === null || cursor === undefined || typeof cursor !== "object") {
        return fallback ?? original;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    if (cursor === undefined || cursor === null) return fallback ?? original;
    // Empty strings are treated as missing for the `default:` filter (Liquid
    // convention). Without this, an explicit `default: 'classic'` would do
    // nothing for the very case authors reach for it — a form field that
    // arrives as "" rather than absent.
    if (typeof cursor === "string") {
      return cursor === "" ? (fallback ?? cursor) : cursor;
    }
    if (typeof cursor === "number" || typeof cursor === "boolean") {
      return String(cursor);
    }
    return JSON.stringify(cursor);
  });
}

/**
 * Parse an action return value into a PrepareResult.
 * Returns undefined for null, non-conforming, or empty (neither task nor config) results.
 */
export function parsePrepareResult(raw: unknown): PrepareResult | undefined {
  if (raw == null) return undefined;

  const parsed = PrepareResultSchema.safeParse(raw);
  if (!parsed.success) {
    logger.debug("Code action return value did not match PrepareResultSchema", {
      error: parsed.error.message,
    });
    return undefined;
  }

  // Filter out empty results (neither task nor config present)
  if (parsed.data.task == null && parsed.data.config == null) {
    return undefined;
  }

  return parsed.data;
}

/**
 * Derive inputSnapshot for action execution events.
 *
 * Resolution order:
 * 1. `inputFrom: <docId>` (string) or `inputFrom: [<id1>, <id2>, ...]` (array)
 *    on the action — explicit author-declared chain from prior steps' outputs.
 *    Wins over carried-over prepareResult: cron/manual triggers auto-seed
 *    prepareResult from signal payloads, and an empty payload (`{}`) used to
 *    overshadow inputFrom and surface as `## Input: { config: {} }`.
 * 2. `prepareResult` from a prior action — falls through when no
 *    inputFrom is set on the action.
 * 3. Legacy `foo_result` ↔ `foo-request` document convention.
 *
 * Array-form `inputFrom` joins each doc's data as
 * `<id>: <data>\n\n<id2>: <data2>` — the LLM sees a concatenated
 * `## Input` block. Artifact refs are collected from the selected input
 * documents themselves and expanded before prompt construction, so single
 * and array inputFrom use the same explicit dependency surface.
 */
export function getInputSnapshot(
  prepareResult: PrepareResult | undefined,
  action: { type: string; outputTo?: string; inputFrom?: string | string[] },
  documents: Map<string, unknown>,
): { task?: string; config?: Record<string, unknown>; artifactRefs?: ArtifactRef[] } | undefined {
  // inputFrom: explicit chain from a prior step's output document.
  // Fails loud — running with empty context is the bug we're trying to
  // avoid; if the referenced doc isn't there, the FSM is misconfigured.
  const inputFrom = action.type === "agent" || action.type === "llm" ? action.inputFrom : undefined;
  if (inputFrom !== undefined) {
    const ids = Array.isArray(inputFrom) ? inputFrom : [inputFrom];

    const artifactRefs: ArtifactRef[] = [];
    const seenArtifactRefs = new Set<string>();

    const collectArtifactRefs = (data: unknown) => {
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      const obj = data as Record<string, unknown>;
      const candidates = [
        obj.artifactRef,
        ...(Array.isArray(obj.artifactRefs) ? obj.artifactRefs : []),
      ];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        const ref = candidate as Record<string, unknown>;
        if (
          typeof ref.id === "string" &&
          typeof ref.type === "string" &&
          typeof ref.summary === "string" &&
          !seenArtifactRefs.has(ref.id)
        ) {
          seenArtifactRefs.add(ref.id);
          artifactRefs.push({ id: ref.id, type: ref.type, summary: ref.summary });
        }
      }
    };

    const items = ids.map((id) => {
      const doc = documents.get(id);
      if (!doc) {
        const available = [...documents.keys()];
        throw new Error(
          `inputFrom: document '${id}' not found. ` +
            `Available documents: ${available.length ? available.join(", ") : "(none)"}`,
        );
      }
      const data = (doc as { data?: unknown }).data;
      if (data === undefined || data === null) {
        throw new Error(`inputFrom: document '${id}' has no data`);
      }
      collectArtifactRefs(data);
      return { id, data };
    });

    // Single source: keep historical shape — `task` is the doc data itself
    // (raw string or JSON.stringify of object). Multi-source: prefix each
    // item with its id so the consuming LLM can tell sources apart.
    const task = Array.isArray(inputFrom)
      ? items
          .map(({ id, data }) => `${id}: ${typeof data === "string" ? data : JSON.stringify(data)}`)
          .join("\n\n")
      : typeof items[0]!.data === "string"
        ? (items[0]!.data as string)
        : JSON.stringify(items[0]!.data);

    const config: Record<string, unknown> = Object.fromEntries(
      items.map(({ id, data }) => [id, data]),
    );
    return { task, config, ...(artifactRefs.length > 0 ? { artifactRefs } : {}) };
  }

  // Carried-over prepareResult — from a prior action or auto-seeded
  // from the triggering signal payload.
  if (prepareResult) {
    const { task, config } = prepareResult;
    if (task || config) return { task, config };
  }

  // Fallback: old-style request document lookup (backward compat)
  // Supports unrecompiled workspaces that still use createDoc in prepare fns.
  // Remove this fallback when all workspaces are recompiled.
  return findRequestDocumentLegacy(action, documents);
}

/**
 * Derive request document ID from action outputTo field.
 * Convention: foo_result -> foo-request (underscore to kebab-case)
 * @deprecated Remove once all workspaces are recompiled to use prepare return values.
 */
function getRequestDocIdFromOutputTo(outputTo: string): string | undefined {
  const match = outputTo.match(/^(.+)_result$/);
  if (!match?.[1]) return undefined;

  const kebab = match[1].replaceAll("_", "-");
  return `${kebab}-request`;
}

/**
 * Find request document for an action based on its outputTo field.
 * Returns task and config from the request document if found.
 * @deprecated Remove once all workspaces are recompiled to use prepare return values.
 */
function findRequestDocumentLegacy(
  action: { type: string; outputTo?: string },
  documents: Map<string, unknown>,
): { task?: string; requestDocId?: string; config?: Record<string, unknown> } | undefined {
  // Get outputTo from agent or llm actions only
  const outputTo = action.type === "agent" || action.type === "llm" ? action.outputTo : undefined;

  if (!outputTo) return undefined;

  const requestDocId = getRequestDocIdFromOutputTo(outputTo);
  if (!requestDocId) return undefined;

  const doc = documents.get(requestDocId);
  if (!doc) return undefined;

  const data = (doc as { data?: Record<string, unknown> }).data;
  if (!data) return undefined;

  const task = typeof data.task === "string" ? data.task : undefined;
  const config =
    typeof data.config === "object" && data.config !== null
      ? (data.config as Record<string, unknown>)
      : undefined;

  if (!task && !config) return undefined;

  return { task, requestDocId, config };
}

type LLMResult = AgentResult<string, FSMLLMOutput>;

/** Extract `complete` tool args from LLM result, or structured data if already extracted */
function findCompleteToolArgs(result: LLMResult): Record<string, unknown> | undefined {
  if (!result.ok) return undefined;

  const fromToolCalls = extractToolCallInput(result.toolCalls ?? [], "complete");
  if (fromToolCalls) return fromToolCalls;

  // Fallback: non-response data means structured output was pre-extracted
  if (result.data && !("response" in result.data)) {
    return result.data;
  }

  return undefined;
}

/** Extract `failStep` tool args from LLM result */
function findFailStepToolArgs(result: LLMResult): Record<string, unknown> | undefined {
  if (!result.ok) return undefined;
  return extractToolCallInput(result.toolCalls ?? [], "failStep");
}

/**
 * Extract `record_validation` tool args from an LLM result. Mirrors
 * `findCompleteToolArgs` — scans the result's toolCalls for one whose name
 * matches the platform tool, returning the input object verbatim. Caller is
 * responsible for parsing it through `StepValidationOutputSchema` before emit.
 *
 * Returns `undefined` when the LLM didn't call the tool — this is observable
 * (the runtime emits `validation: { strategy: "self" }` without a verdict)
 * rather than fatal, because the goal is visibility into self-check
 * outcomes, not enforcing that every action calls the tool.
 */
function findRecordValidationToolArgs(result: LLMResult): Record<string, unknown> | undefined {
  if (!result.ok) return undefined;
  return extractToolCallInput(result.toolCalls ?? [], RECORD_VALIDATION_TOOL_NAME);
}

/**
 * Build the structured validation block that rides on `step:complete.validation`.
 * Three resolved strategies → three emit shapes; see `StepValidationOutputSchema`
 * in `@atlas/core/session-events` for the on-the-wire contract.
 *
 * Caller is responsible for the failStep semantics on `verdict: "blocking"` —
 * this helper only assembles the shape; it doesn't throw.
 */
function buildValidationOutput(input: {
  decision: ValidateDecision;
  reason: string;
  /** Captured `record_validation` args (self path); undefined if LLM didn't call it. */
  recordedArgs?: Record<string, unknown>;
  /** Final verdict from the external judge; undefined when judge didn't run. */
  externalVerdict?: ValidationVerdict;
  /**
   * Structured + self path. The action declared an outputType with a defined
   * schema, so the runtime injected a `complete` tool and elided
   * `record_validation`. Successful structured emission is the
   * implicit verdict — surface as `pass` so step:complete.validation isn't
   * silently empty.
   */
  implicitPass?: boolean;
}): NonNullable<FSMActionExecutionEvent["data"]["llmResult"]>["validation"] {
  if (input.decision === "skip") {
    return { strategy: "skip", skipReason: input.reason };
  }
  if (input.decision === "self") {
    if (!input.recordedArgs) {
      return input.implicitPass ? { strategy: "self", verdict: "pass" } : { strategy: "self" };
    }
    const verdict = input.recordedArgs.verdict;
    const issues = Array.isArray(input.recordedArgs.issues)
      ? (input.recordedArgs.issues as Array<Record<string, unknown>>).map((i) => ({
          claim: typeof i.claim === "string" ? i.claim : "",
          ...(typeof i.category === "string" && { category: i.category }),
          ...(typeof i.reasoning === "string" && { reasoning: i.reasoning }),
          ...(typeof i.severity === "string" && {
            severity: i.severity as "low" | "medium" | "high" | "info" | "warn" | "error",
          }),
          ...(typeof i.citation === "string" || i.citation === null
            ? { citation: i.citation as string | null }
            : {}),
        }))
      : undefined;
    return {
      strategy: "self",
      ...(typeof verdict === "string" &&
      (verdict === "pass" || verdict === "advisory" || verdict === "blocking")
        ? { verdict }
        : {}),
      ...(issues && issues.length > 0 ? { issues } : {}),
    };
  }
  // external
  if (!input.externalVerdict) return { strategy: "external" };
  const issues = input.externalVerdict.issues ?? [];
  return {
    strategy: "external",
    verdict: input.externalVerdict.verdict,
    ...(issues.length > 0
      ? {
          issues: issues.map((iss) => ({
            claim: iss.claim,
            ...(iss.category !== undefined && { category: iss.category }),
            ...(iss.reasoning !== undefined && { reasoning: iss.reasoning }),
            ...(iss.severity !== undefined && { severity: iss.severity }),
            ...(iss.citation !== undefined && { citation: iss.citation }),
          })),
        }
      : {}),
  };
}

/**
 * Detect a scrubber-lifted (A2) tool result. Mirrors the refMarker
 * pattern from `@atlas/core/artifacts/scrubber.ts`:
 *
 *   `[attachment lifted to artifact <id> (<kb> KB, <mime>, from <server>/<tool>) — use display_artifact or artifacts_get to read]`
 *
 * Returns `{ artifactId, summary }` on match — the runtime hands this to
 * the judge so the judge can call `artifacts_get` only when it needs to
 * verify a specific claim. Cost scales with judgment work, not with input
 * size.
 */
const REF_MARKER_RE = /^\[attachment lifted to artifact ([\w-]+) \(([^)]+)\) — use [^\]]+\]$/;

function detectLiftedArtifact(
  output: unknown,
): { artifactId: string; summary: string } | undefined {
  const text = extractToolResultText(output);
  if (!text) return undefined;
  const trimmed = text.trim();
  const match = REF_MARKER_RE.exec(trimmed);
  if (!match || !match[1]) return undefined;
  return { artifactId: match[1], summary: match[2] ?? "" };
}

/** Max characters to inline per tool result in the judge handoff. */
const MAX_JUDGE_INLINE_CHARS = 8000;

/**
 * Extract a string preview of a tool result's `output`. Mirrors the
 * deleted hallucination/detector.ts shape — string passthrough, MCP text
 * content array, JSON.stringify fallback. Inlined here so the judge
 * handoff builder doesn't depend on the deleted package.
 */
function extractToolResultText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const obj = output as { content?: unknown };
    if (Array.isArray(obj.content)) {
      const texts: string[] = [];
      for (const item of obj.content) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as { text?: unknown }).text === "string"
        ) {
          texts.push((item as { text: string }).text);
        }
      }
      if (texts.length > 0) return texts.join("\n");
    }
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function truncateForJudge(text: string): string {
  if (text.length <= MAX_JUDGE_INLINE_CHARS) return text;
  return `${text.slice(0, MAX_JUDGE_INLINE_CHARS)}\n[...truncated ${
    text.length - MAX_JUDGE_INLINE_CHARS
  } chars]`;
}

/**
 * Build the judge handoff for an action's external-validation pass. Walks
 * the trace's tool calls and projects each one as either an artifact
 * reference (scrubber-lifted) or an inline preview. The judge agent
 * receives this as its `handoff` payload.
 */
export function buildJudgeHandoff(trace: LLMActionTrace): JudgeHandoff {
  const toolResults = trace.toolResults ?? [];
  const toolCalls = trace.toolCalls ?? [];
  const callsByCallId = new Map(toolCalls.map((tc) => [tc.toolCallId, tc.input]));

  const entries: JudgeToolCallEntry[] = toolResults.map((tr) => {
    const args = tr.toolCallId ? callsByCallId.get(tr.toolCallId) : undefined;
    const lifted = detectLiftedArtifact(tr.output);
    if (lifted) {
      return {
        toolName: tr.toolName,
        ...(args !== undefined && { args }),
        resultArtifactId: lifted.artifactId,
        resultSummary: lifted.summary,
      };
    }
    return {
      toolName: tr.toolName,
      ...(args !== undefined && { args }),
      resultInline: truncateForJudge(extractToolResultText(tr.output)),
    };
  });

  return { actionInput: trace.prompt, actionOutput: trace.content, toolCalls: entries };
}

/**
 * Build LLMActionTrace from an LLM result envelope for hallucination detection.
 * Passes through AI SDK tool types directly without transformation.
 */
export function buildLLMActionTrace(
  result: LLMResult,
  model: string,
  prompt: string,
): LLMActionTrace {
  // Extract content from result - use response field if present, otherwise stringify data
  const content = result.ok
    ? "response" in result.data
      ? String(result.data.response)
      : JSON.stringify(result.data)
    : result.error.reason;

  return {
    content,
    reasoning: result.ok ? result.reasoning : undefined,
    toolCalls: result.ok ? result.toolCalls : undefined,
    toolResults: result.ok ? result.toolResults : undefined,
    model,
    prompt,
  };
}

/**
 * Per-call options the FSM engine threads into `agentExecutor`. Today: the
 * resolved `outputSchema` (FSM documentTypes) and the resolved validation
 * decision. The orchestrator-side adapter (workspace runtime → agent server
 * → `convertLLMToAgent`) reads `validateDecision` / `validateSkill` and
 * passes them to `composeValidationBlock` at the LLM-prompt-assembly site so
 * `case "agent" → type: llm` ends up with the same validation skill body in
 * its system prompt that an inline `case "llm"` action would.
 */
export interface AgentExecutorOptions {
  /** JSON Schema resolved from FSM `documentTypes` or default outputTo contract. */
  outputSchema?: Record<string, unknown>;
  /**
   * Resolved validation decision for this action — already factored across
   * `action.validate` and the auto classifier. The orchestrator
   * forwards it to `composeValidationBlock`. `"skip"` means the helper
   * isn't called; `"self"` injects the skill body inline; `"external"` is
   * handled post-execution by the FSM engine, not the orchestrator.
   */
  validateDecision?: "skip" | "self" | "external";
  /**
   * Optional override skill name for the `self` path (the object form of
   * `validate:` lets authors point at a custom validating skill). When
   * absent, `composeValidationBlock` uses `DEFAULT_VALIDATION_SKILL`.
   */
  validateSkill?: string;
}

/**
 * Agent executor callback type
 * Integrates FSM agent actions with external agent orchestration systems
 *
 * @param action - The full AgentAction object (includes agentId, prompt, outputTo)
 * @param context - FSM context with documents, state, and utility functions
 * @param signal - Signal with context (sessionId, workspaceId, onEvent callback)
 * @param options - Optional execution options (e.g., resolved outputSchema from documentTypes,
 *   resolved validation decision threaded into the orchestrator's prompt assembly)
 */
export type AgentExecutor = (
  action: AgentAction,
  context: Context,
  signal: SignalWithContext,
  options?: AgentExecutorOptions,
) => Promise<AgentSDKExecutionResult>;

export interface FSMEngineOptions {
  llmProvider?: LLMProvider;
  documentStore: DocumentStore;
  scope: DocumentScope;
  agentExecutor?: AgentExecutor;
  /** MCP server configs from workspace — merged with atlas-platform at call time */
  /**
   * MCP server configs from workspace — merged with atlas-platform at call time.
   * Accepts the workspace-level superset `WorkspaceMCPServerConfig` so the
   * per-server `validation:` override
   * flows through to the validate-classifier. Plain `MCPServerConfig`
   * from non-workspace callers (tests, atlas) remains structurally
   * assignable since `validation` is optional.
   */
  mcpServerConfigs?: Record<string, MCPServerConfig | WorkspaceMCPServerConfig>;
  /**
   * Workspace `.env` overlay provider. A thunk — the workspace runtime reads
   * the file fresh per call so runtime edits (settings UI, env tools) aren't
   * masked by a stale copy. Layered under each server's `env:` wiring when
   * MCP env is resolved at spawn.
   */
  getEnvOverlay?: () => Record<string, string>;
  /**
   * External-validation runner. Workspace runtime wires this to invoke
   * `@friday/judge-agent` (or the per-action override from
   * `validate.agent`) through the agent orchestrator. When unset,
   * external-validation actions log + fall through to an advisory
   * verdict so the action still emits.
   */
  runJudge?: JudgeAgentRunner;
  /** Storage adapter for resolving image artifact binary data */
  artifactStorage?: ArtifactStorageAdapter;
  /**
   * Outbound chat broadcaster used by `notification` actions. Required only
   * when an FSM declares at least one such action — engines without it throw
   * a typed error on first encounter.
   */
  broadcastNotifier?: FSMBroadcastNotifier;
  /**
   * Required to expose `delegate` to `type: llm` actions. The delegate child
   * runs its own `streamText` against the registry's
   * `conversational` model, mirroring the chat-side behavior. Without this
   * field the engine silently omits delegate from the action's tool set
   * (callers without delegate-capable runtimes don't pay for the wiring).
   */
  platformModels?: PlatformModels;
  /**
   * Repair function forwarded to the delegate child's streamText. Mirrors
   * the chat-side wiring so children handle malformed tool args
   * identically to the parent. Falls back to the agent-sdk default when
   * unset.
   */
  repairToolCall?: ToolCallRepairFunction<Record<string, Tool>>;
  /**
   * Workspace link summary, used by the delegate when an LLM passes
   * `mcpServers` to discover candidate servers. Optional; absence
   * disables MCP-server discovery inside the delegate child but does not
   * disable delegate itself.
   */
  linkSummary?: LinkSummary;
  /**
   * Resolved delegation budget for this engine. Top-level caller (workspace
   * runtime) computes the per-job-merged-over-workspace
   * value before constructing the engine. Forwarded into `createDelegateTool`
   * so wall-clock, input-token, output-token, step, and depth budgets are
   * all enforced inside the child's streamText. Default depth cap = 1
   * (today's chat-side hard cap, preserved for back-compat when no
   * `delegation:` block exists).
   */
  delegationBudget?: import("@atlas/config").DelegationBudget;
  /**
   * Per-job permissions (raw, unresolved). Forwarded into the
   * `wrapPlatformToolsWithScope` call so
   * `request_tool_access` can resolve effective bypass at LLM-call time
   * (job > workspace > daemon-env precedence). Optional — undefined means
   * "no per-job override".
   */
  jobPermissions?: import("@atlas/config").PermissionsConfig;
  /**
   * Workspace-level permissions config. Same forwarding contract as
   * `jobPermissions` but at the workspace tier.
   */
  workspacePermissions?: import("@atlas/config").PermissionsConfig;
  /**
   * Effective parent-job timeout in milliseconds. When set, surfaces in
   * the wrapped scope as `jobTimeoutMs` so scope-injected elicitation
   * tools (e.g. `request_tool_access`) can derive `expiresAt = now +
   * jobTimeoutMs`. Workspace runtime sets this from the resolved per-job
   * timeout, or omits it when no timeout is configured.
   */
  jobTimeoutMs?: number;
  /**
   * Agent-type resolver for `case "agent"` actions. The validate classifier
   * short-circuits to `skip` when the resolved agent type is
   * `"user"` or `"atlas"` (Python is code; bundled SDK agents have fixed
   * prompts — neither path builds an LLM system prompt that
   * `composeValidationBlock` could augment). Without this callback the
   * classifier sees `resolvedAgentType: undefined` and falls through to
   * the existing tool/prose heuristics, which is fine for `case "llm"`
   * (where the type is implicitly `"llm"`) but loses the cheap
   * type-based skip on the agent path.
   *
   * Returns `undefined` when the agent isn't registered in the workspace
   * (the executor itself will then surface a clear error). Synchronous
   * — the caller (workspace runtime) already has the resolved
   * `agents.<id>` block in memory at engine-construction time.
   */
  resolveAgentType?: (agentId: string) => "llm" | "user" | "atlas" | undefined;
  /**
   * Workspace-level validation defaults. Merged at decision-resolution time
   * inside `case "llm"` and `case "agent"`:
   * `action.validate > job.validation.default > workspace.validation.default
   * > "auto"` (classifier). Skill name follows the same merge.
   * Optional — undefined means "no workspace-level default; fall through
   * to "auto" classifier when neither job nor action set it".
   */
  workspaceValidation?: ValidationDefaults;
  /**
   * Per-job validation override. Wins over `workspaceValidation` per field.
   * Action-level `validate:` still
   * wins over both. See `workspaceValidation` for full precedence.
   */
  jobValidation?: ValidationDefaults;
  /**
   * Per-action artifact persistence hook. Fired immediately after a
   * `case "llm"` or `case "agent"`
   * action writes its `outputTo` document, so the workspace runtime
   * can persist the artifact mid-session rather than waiting for the
   * post-drain pass. Without this,
   * `composeArtifactBlocks({ workspaceId, sessionId })` finds zero
   * artifacts for the in-flight session because nothing is persisted
   * until the engine drains.
   *
   * The callback receives the freshly-written document, the action
   * that produced it, and `fromTerminalState` (whether the emitting
   * state has `type: "final"` — drives the durable vs ephemeral
   * lifecycle decision identically to the post-drain pass).
   *
   * Implementations MUST tolerate repeat invocations for the same
   * `outputTo` (later actions can overwrite an existing doc) — the
   * runtime side issues an artifact `update` on the second hit.
   * Failures should log-and-continue inside the callback; the engine
   * never blocks on persistence. Optional — when unset, behavior
   * falls back to post-drain persistence only.
   */
  persistFsmActionArtifact?: (input: {
    doc: Document;
    action: LLMAction | AgentAction;
    workspaceId: string;
    sessionId: string;
    fromTerminalState: boolean;
  }) => Promise<void>;
}

export class FSMEngine {
  private _currentState: string;
  private _documents = new Map<string, Document>();
  /** Auxiliary, non-document context values such as seeded __meta and __lastPrepare. */
  private _results = new Map<string, Record<string, unknown>>();
  private _signalQueue: SignalWithContext[] = [];
  private _processing = false;
  private _initialized = false;
  private _recursionDepth = 0;
  private _compiledSchemas = new Map<string, z.ZodType>();
  private _emittedEvents: EmittedEvent[] = [];
  private static readonly MAX_RECURSION_DEPTH = 10;
  private static readonly MAX_PROCESSED_SIGNALS = 100;
  private _processedSignalsCount = 0;

  constructor(
    private _definition: FSMDefinition,
    private options: FSMEngineOptions,
  ) {
    this._currentState = _definition.initial;
  }

  async initialize(): Promise<void> {
    if (this._initialized) {
      throw new Error("FSMEngine already initialized");
    }

    // Load saved state with schema validation
    // Corrupted state (invalid shape) returns error; missing state returns null
    const stateResult = await this.options.documentStore.loadState(
      this.options.scope,
      this.definition.id,
      FSMStateSchema,
    );

    if (!stateResult.ok) {
      throw new Error(`Failed to load FSM state: ${stateResult.error}`);
    }

    const storedState = stateResult.data;
    let stateRestored = false;

    if (storedState) {
      if (this.definition.states[storedState.state]) {
        this._currentState = storedState.state;
        stateRestored = true;
        logger.debug(`Restored state: ${this._currentState}`);
      } else {
        logger.warn(
          `Stored state "${storedState.state}" not found in definition. Resetting to initial.`,
        );
      }
    }

    // Compile document type schemas
    if (this._definition.documentTypes) {
      for (const [typeName, jsonSchema] of Object.entries(this._definition.documentTypes)) {
        try {
          const raw: Record<string, unknown> = jsonSchema;
          const zodSchema = z.fromJSONSchema(raw);
          this._compiledSchemas.set(typeName, zodSchema);
          logger.debug(`Compiled schema for document type: ${typeName}`);
        } catch (error) {
          throw new Error(
            `Failed to compile schema for document type "${typeName}": ${stringifyError(error)}`,
          );
        }
      }
    }

    // Load documents: storage first (if exists), then definition fallback
    const stored = await this.options.documentStore.list(this.options.scope, this._definition.id);

    if (stored.length > 0) {
      // FSM has been run before - restore from persistent storage
      logger.debug(`Restoring ${stored.length} documents from storage`);
      for (const id of stored) {
        const readResult = await this.options.documentStore.read(
          this.options.scope,
          this._definition.id,
          id,
          FSMDocumentDataSchema,
        );
        if (!readResult.ok) {
          logger.warn(`Failed to read document ${id}: ${readResult.error}`);
          continue;
        }
        const doc = readResult.data;
        if (doc) {
          const docType = doc.data.type;
          const docData = doc.data.data;
          try {
            this.validateDocumentData(docType, docData, id);
          } catch (err) {
            // Stored documents were validated at write time — restore failures
            // are typically JSON round-trip issues (null vs undefined) or schema
            // changes between runs. Warn and restore anyway.
            logger.warn(`Restoring document "${id}" despite validation error`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          this._documents.set(id, { id, type: docType, data: docData });
        }
      }
    } else if (!stateRestored) {
      // First run - initialize from FSM definition
      logger.debug("No stored documents found, initializing from FSM definition");
      const initialState = this._definition.states[this._currentState];
      if (initialState?.documents) {
        for (const doc of initialState.documents) {
          this.validateDocumentData(doc.type, doc.data, doc.id);
          this._documents.set(doc.id, doc);
        }
      }

      // Execute entry actions for initial state
      if (initialState?.entry) {
        logger.debug("Executing entry actions for initial state", {
          state: this._currentState,
          actionCount: initialState.entry.length,
        });

        await this.executeActions(
          initialState.entry,
          { type: "__init__" },
          this._documents,
          this._emittedEvents,
          this._signalQueue,
          this._currentState,
        );

        logger.debug("Initial state entry actions completed");
      }

      // Persist initial state
      await this.persistExecutionState();
    } else {
      logger.debug("State restored but no documents found. Skipping initialization.");
    }

    // Always persist documents after initialization — clears stale documents
    // from storage regardless of which initialization path was taken
    await this.persistDocuments();

    // B1: emit one info log per (state × llm/agent action) summarizing the
    // statically-resolved validation decision. Authors can grep their
    // daemon logs to confirm "what's resolving where" without bisecting
    // the workspace > job > action precedence chain by hand. The
    // classifier runs with the static context (declared tools, no
    // calledToolNames, no emittedProse) which matches the pre-call
    // resolution at runtime — explicit/merged-default decisions are
    // identical; only `auto` may shift if the LLM emits unexpected prose.
    this.logResolvedValidationDecisions();

    this._initialized = true;
  }

  /** B1: see the inline call site in `initialize()` for rationale. */
  private logResolvedValidationDecisions(): void {
    const job = this.options.jobValidation;
    const workspace = this.options.workspaceValidation;
    for (const [stateId, stateNode] of Object.entries(this._definition.states ?? {})) {
      const collectActions = (): Array<{ trigger: string; action: Action }> => {
        const out: Array<{ trigger: string; action: Action }> = [];
        for (const a of stateNode.entry ?? []) {
          out.push({ trigger: "entry", action: a });
        }
        for (const [event, transition] of Object.entries(stateNode.on ?? {})) {
          const actions = Array.isArray(transition)
            ? []
            : ((transition as { actions?: Action[] }).actions ?? []);
          for (const a of actions) {
            out.push({ trigger: `on:${event}`, action: a });
          }
        }
        return out;
      };
      for (const { trigger, action } of collectActions()) {
        if (action.type !== "llm" && action.type !== "agent") continue;
        const declaredTools = "tools" in action && Array.isArray(action.tools) ? action.tools : [];
        const resolution = resolveValidateDecision(
          "validate" in action ? action.validate : undefined,
          {
            declaredTools,
            calledToolNames: [],
            hasOutputType:
              action.type === "llm" && !!(action as { outputType?: string }).outputType,
            hasInputFrom: "inputFrom" in action && !!action.inputFrom,
            resolvedAgentType: undefined,
            emittedProse: false,
            toolsAvailable: declaredTools.length > 0,
            ...(action.type === "llm" &&
            (action as { run_code?: { readOnly?: boolean } }).run_code?.readOnly
              ? { runCodeReadOnly: true }
              : {}),
          },
          { ...(job && { job }), ...(workspace && { workspace }) },
        );
        logger.info("FSM action validation resolved", {
          fsm: this._definition.id,
          state: stateId,
          trigger,
          actionType: action.type,
          ...(action.type === "llm" && action.outputTo ? { outputTo: action.outputTo } : {}),
          ...(action.type === "agent" && (action as { agentId?: string }).agentId
            ? { agentId: (action as { agentId: string }).agentId }
            : {}),
          decision: resolution.decision,
          source: resolution.source,
          reason: resolution.reason,
          ...(resolution.skill ? { skill: resolution.skill } : {}),
        });
      }
    }
  }

  async signal(
    sig: Signal,
    context?: {
      sessionId: string;
      workspaceId: string;
      onEvent?: (event: import("./types.ts").FSMEvent) => void;
      /** Separate channel for agent UIMessageChunks (text, reasoning, tool-call, etc.) */
      onStreamEvent?: (chunk: import("@atlas/agent-sdk").AtlasUIMessageChunk) => void;
      abortSignal?: AbortSignal;
      /** State IDs to skip — their entry actions won't execute, engine chains through */
      skipStates?: string[];
      /**
       * Phase 7 — current delegation depth. Top-level signals leave this
       * unset (treated as 0); a delegate child-frame would set this to its
       * parent's depth + 1. Used to gate `delegate` tool registration in
       * `type: llm` actions against `FSMEngineOptions.delegationBudget.
       * max_depth`.
       */
      delegationDepth?: number;
    },
  ): Promise<void> {
    const signalWithContext: SignalWithContext = context ? { ...sig, _context: context } : sig;
    this._signalQueue.push(signalWithContext);
    if (!this._processing) {
      await this.processQueue();
    }
  }

  /**
   * Collect per-MCP `validation:` overrides from `mcpServerConfigs` into a
   * flat `Record<serverId, override>` for the
   * validate-classifier. Returns `undefined` when no servers carry an
   * override so the classifier can short-circuit.
   */
  private buildMCPValidationOverrides(): Record<string, MCPValidationOverride> | undefined {
    const configs = this.options.mcpServerConfigs;
    if (!configs) return undefined;
    let result: Record<string, MCPValidationOverride> | undefined;
    for (const [id, config] of Object.entries(configs)) {
      const override = (config as WorkspaceMCPServerConfig).validation;
      if (override) {
        result ??= {};
        result[id] = override;
      }
    }
    return result;
  }

  /**
   * Bridge to the workspace runtime's mid-session artifact persister.
   * Invoked by `case "llm"` and
   * `case "agent"` immediately after `documents.set(action.outputTo, ...)`.
   *
   * No-op when the host hasn't wired `persistFsmActionArtifact`, when the
   * signal context lacks a workspaceId/sessionId pair, or when the
   * freshly-written document is missing. `fromTerminalState` is the
   * static "is the emitting state's `type === "final"`?" check.
   *
   * Errors are swallowed inside the persister callback (logged on the
   * runtime side); this method itself wraps in a try/catch so a
   * misbehaving callback can't crash the action loop.
   */
  private materializeResults(
    documents: Map<string, Document>,
    auxiliary: Map<string, Record<string, unknown>> = this._results,
  ): Record<string, Record<string, unknown>> {
    const projected = new Map<string, Record<string, unknown>>(auxiliary);
    for (const [id, doc] of documents) {
      projected.set(id, doc.data);
    }
    return Object.fromEntries(projected);
  }

  private async maybePersistActionArtifact(
    action: LLMAction | AgentAction,
    doc: Document | undefined,
    sig: SignalWithContext,
    currentState: string,
  ): Promise<void> {
    const persister = this.options.persistFsmActionArtifact;
    if (!persister) return;
    if (!doc) return;
    const workspaceId = sig._context?.workspaceId;
    const sessionId = sig._context?.sessionId;
    if (!workspaceId || !sessionId) return;
    const fromTerminalState = this._definition.states[currentState]?.type === "final";
    try {
      await persister({ doc, action, workspaceId, sessionId, fromTerminalState });
    } catch (err) {
      logger.warn("persistFsmActionArtifact threw — continuing", {
        outputTo: action.outputTo,
        error: stringifyError(err),
      });
    }
  }

  private async processQueue(): Promise<void> {
    this._processing = true;
    this._processedSignalsCount = 0;
    // Clear stale prepare config from previous signal batches so external
    // signals start fresh. Cascaded signals within this run will see
    // __lastPrepare set by earlier signals in the same batch.
    this._results.delete("__lastPrepare");
    try {
      while (this._signalQueue.length > 0) {
        if (this._processedSignalsCount++ > FSMEngine.MAX_PROCESSED_SIGNALS) {
          throw new Error(
            `Maximum signal cascade depth (${FSMEngine.MAX_PROCESSED_SIGNALS}) exceeded. ` +
              "Possible infinite loop in signal emissions.",
          );
        }
        const sig = this._signalQueue.shift();
        if (sig) {
          await this.processSingleSignal(sig);
        }
      }
    } finally {
      this._processing = false;
    }
  }

  private async processSingleSignal(sig: SignalWithContext): Promise<void> {
    await withOtelSpan(
      "fsm.signal",
      {
        "fsm.state": this._currentState,
        "fsm.signal.type": sig.type,
        "fsm.job.name": this._definition.id,
      },
      (otelSpan) => this.processSingleSignalInner(sig, otelSpan),
    );
  }

  private async processSingleSignalInner(
    sig: SignalWithContext,
    otelSpan: OtelSpan | null,
  ): Promise<void> {
    logger.debug("Processing signal", {
      signalType: sig.type,
      currentState: this._currentState,
      hasData: !!sig.data,
    });

    const state = this._definition.states[this._currentState];
    if (!state) throw new Error(`Invalid state: ${this._currentState}`);

    if (!state.on?.[sig.type]) {
      logger.debug("No transition defined for signal", {
        signalType: sig.type,
        currentState: this._currentState,
      });
      return; // No transition for this signal
    }

    // Get transitions for this signal type
    const transitionsOrSingle = state.on[sig.type];
    if (!transitionsOrSingle) {
      return; // No transition for this signal
    }
    const transitions = Array.isArray(transitionsOrSingle)
      ? transitionsOrSingle
      : [transitionsOrSingle];

    const selectedTransition: TransitionDefinition | null = transitions[0] ?? null;

    if (!selectedTransition) return; // No valid transition found

    // Skip chain-through: resolve the effective target by chaining through skipped states
    const skipStates = sig._context?.skipStates ?? [];

    // Warn about unknown state IDs (catches typos from direct API callers)
    for (const id of skipStates) {
      if (!this._definition.states[id]) {
        logger.warn("skipStates contains unknown state ID", {
          stateId: id,
          knownStates: Object.keys(this._definition.states),
        });
      }
    }

    let resolvedTarget = selectedTransition.target;
    const visited = new Set<string>();

    while (
      skipStates.includes(resolvedTarget) &&
      resolvedTarget !== this._definition.initial &&
      this._definition.states[resolvedTarget]?.type !== "final"
    ) {
      if (visited.has(resolvedTarget)) {
        throw new Error(`Circular skip chain detected: "${resolvedTarget}" already visited`);
      }
      visited.add(resolvedTarget);

      // Emit skip event before chaining through
      if (sig._context?.onEvent) {
        sig._context.onEvent({
          type: "data-fsm-state-skipped",
          data: {
            sessionId: sig._context.sessionId,
            workspaceId: sig._context.workspaceId,
            jobName: this._definition.id,
            stateId: resolvedTarget,
            timestamp: Date.now(),
          },
        });
      }

      const skippedStateDef = this._definition.states[resolvedTarget];
      const transitions = skippedStateDef?.on;
      if (!transitions) {
        throw new Error(`Cannot skip state "${resolvedTarget}": no outgoing transitions`);
      }

      const transitionKeys = Object.keys(transitions);
      if (transitionKeys.length !== 1) {
        throw new Error(
          `Cannot skip state with ${transitionKeys.length} outgoing transitions: ${resolvedTarget}`,
        );
      }

      const transitionKey = transitionKeys[0];
      if (!transitionKey) {
        throw new Error(`Cannot skip state "${resolvedTarget}": no outgoing transitions`);
      }
      const transitionValue = transitions[transitionKey];
      const singleTransition = Array.isArray(transitionValue)
        ? transitionValue.length === 1
          ? transitionValue[0]
          : null
        : transitionValue;

      if (!singleTransition) {
        throw new Error(`Cannot skip state with multiple guarded transitions: ${resolvedTarget}`);
      }

      resolvedTarget = singleTransition.target;
    }

    if (otelSpan) otelSpan.setAttribute("fsm.state.target", resolvedTarget);

    // Transactional execution:
    // Create pending state copies. Only commit if everything succeeds.
    const pendingDocuments = new Map<string, Document>();
    for (const [id, doc] of this._documents) {
      // Deep clone document to ensure complete isolation during transaction
      // This prevents any mutations from affecting original if transaction fails
      pendingDocuments.set(id, structuredClone(doc));
    }

    const pendingResults = new Map<string, Record<string, unknown>>(this._results);
    const pendingEvents: EmittedEvent[] = [];
    const pendingSignals: SignalWithContext[] = [];
    let pendingState = this._currentState;

    try {
      const previousState = pendingState;

      await withOtelSpan(
        "fsm.transition",
        {
          "fsm.state.from": pendingState,
          "fsm.state.to": resolvedTarget,
          "fsm.signal.type": sig.type,
          "fsm.job.name": this._definition.id,
        },
        async () => {
          // Execute transition actions
          if (selectedTransition.actions && selectedTransition.actions.length > 0) {
            await this.executeActions(
              selectedTransition.actions,
              sig,
              pendingDocuments,
              pendingEvents,
              pendingSignals,
              pendingState,
              pendingResults,
            );
          }

          // Transition to new state (using resolved target that accounts for skip chain)
          pendingState = resolvedTarget;

          logger.debug(`FSM transitioned: ${previousState} -> ${pendingState}`, {
            event: sig.type,
          });

          // Initialize documents for new state if they don't exist
          const newStateDefinition = this._definition.states[pendingState];
          if (newStateDefinition?.documents) {
            for (const doc of newStateDefinition.documents) {
              if (!pendingDocuments.has(doc.id)) {
                this.validateDocumentData(doc.type, doc.data, doc.id);
                pendingDocuments.set(doc.id, doc);
              }
            }
          }

          // Execute entry actions for new state
          if (newStateDefinition?.entry) {
            logger.debug("Executing entry actions for state", {
              state: pendingState,
              actionCount: newStateDefinition.entry.length,
            });

            await this.executeActions(
              newStateDefinition.entry,
              sig,
              pendingDocuments,
              pendingEvents,
              pendingSignals,
              pendingState,
              pendingResults,
            );

            logger.debug("Entry actions completed for state", { state: pendingState });
          }
        },
      );

      // COMMIT PHASE
      // 1. Commit documents
      this._documents = pendingDocuments;
      // 2. Commit results (clear when returning to initial state)
      if (pendingState === this._definition.initial) {
        this._results.clear();
      } else {
        this._results = pendingResults;
      }
      // 3. Commit state
      this._currentState = pendingState;
      // 4. Commit events
      this._emittedEvents = pendingEvents;
      // 5. Commit signals (enqueue them)
      for (const s of pendingSignals) {
        this._signalQueue.push(s);
      }

      // 5. Persist
      await this.persistDocuments();
      await this.persistExecutionState();

      // 6. Emit state transition event if callback provided and state changed
      if (sig._context?.onEvent && previousState !== pendingState) {
        sig._context.onEvent({
          type: "data-fsm-state-transition",
          data: {
            sessionId: sig._context.sessionId,
            workspaceId: sig._context.workspaceId,
            jobName: this._definition.id,
            fromState: previousState,
            toState: pendingState,
            triggeringSignal: sig.type,
            timestamp: Date.now(),
          },
        });
      }
    } catch (error) {
      // Classify the error to determine severity
      const errorCause = createErrorCause(error);

      // The catch fires before the COMMIT PHASE runs, so `this._currentState`
      // still points at the FROM state of the in-flight transition. Use
      // `pendingState` (the state whose entry/transition action actually ran)
      // for accurate attribution. When an entry action of the TO state
      // throws, this distinguishes "summarize failed entering via ADVANCE
      // from triage" from the misleading old "error in state triage".
      const failedState = pendingState;
      const fromState = this._currentState;
      const transitionDescriptor =
        failedState === fromState
          ? `state ${failedState}`
          : `state ${failedState} (entered via ${sig.type} from ${fromState})`;

      if (isAPIErrorCause(errorCause) && errorCause.code === "BUDGET_EXCEEDED") {
        logger.warn(`FSM error in ${transitionDescriptor}, signal ${sig.type}: budget exceeded`, {
          error,
          errorCode: errorCause.code,
          statusCode: errorCause.statusCode,
          state: failedState,
          fromState,
          signalType: sig.type,
        });
      } else {
        // `warn`, not `error`. FSM step failures are domain events
        // (LLM API rejection, tool error, validation fail) that get
        // re-thrown to the runtime and surfaced via the cascade
        // dispatcher's warn-level `Cascade session failed`. Logging at
        // error here turned every misconfigured workspace.yml model id
        // into an infra-level alert.
        logger.warn(`FSM error in ${transitionDescriptor}, signal ${sig.type}`, {
          error,
          state: failedState,
          fromState,
          signalType: sig.type,
        });
      }
      throw error;
    }
  }

  private async executeActions(
    actions: Action[],
    sig: SignalWithContext,
    documents: Map<string, Document>,
    events: EmittedEvent[],
    signals: SignalWithContext[],
    currentState: string,
    results?: Map<string, Record<string, unknown>>,
  ): Promise<void> {
    this._recursionDepth++;
    if (this._recursionDepth > FSMEngine.MAX_RECURSION_DEPTH) {
      throw new Error(
        `Maximum recursion depth (${FSMEngine.MAX_RECURSION_DEPTH}) exceeded. ` +
          "Possible infinite loop in signal emissions.",
      );
    }

    try {
      // Seed prepareResult from the previous state's stored value so agent
      // actions in a cascaded state inherit config (e.g. platformUrl, workDir)
      const storedPrepare = results?.get("__lastPrepare");
      let prepareResult: PrepareResult | undefined = storedPrepare
        ? parsePrepareResult(storedPrepare)
        : undefined;

      // If there's no prior prepare result and the triggering signal carries a
      // payload, auto-seed the config from it. Friday-authored FSMs routinely
      // expect agent prompts to reference signal-payload fields (via
      // `{{inputs.x}}` substitution or the Input section). Without this,
      // signal payloads simply vanished — the job fired, the FSM ran, and
      // the agent complained about missing inputs while the values sat in
      // `sig.data` unread.
      if (!prepareResult && sig.data && typeof sig.data === "object") {
        const candidate = sig.data as Record<string, unknown>;
        // `createJobTools` wraps tool args under `payload` when firing the
        // signal; unwrap if present so the agent sees the user-supplied
        // fields at the top level. Otherwise take the raw object.
        const payload =
          "payload" in candidate && typeof candidate.payload === "object" && candidate.payload
            ? (candidate.payload as Record<string, unknown>)
            : candidate;
        prepareResult = { config: payload };
      }
      for (const action of actions) {
        prepareResult = await this.executeAction(
          action,
          sig,
          documents,
          events,
          signals,
          currentState,
          results,
          prepareResult,
        );
      }

      // Persist prepareResult so subsequent states inherit config
      // (e.g. platformUrl, workDir) without re-deriving it.
      if (prepareResult && results) {
        results.set("__lastPrepare", { ...prepareResult });
      }
    } finally {
      this._recursionDepth--;
    }
  }

  private async executeAction(
    action: Action,
    sig: SignalWithContext,
    documents: Map<string, Document>,
    events: EmittedEvent[],
    signals: SignalWithContext[],
    currentState: string,
    results?: Map<string, Record<string, unknown>>,
    prepareResult?: PrepareResult,
  ): Promise<PrepareResult | undefined> {
    const actionStartTime = Date.now();

    // Compute inputSnapshot for agent/llm actions
    const inputSnapshot =
      action.type === "agent" || action.type === "llm"
        ? getInputSnapshot(prepareResult, action, documents)
        : undefined;

    // When the action declares `inputFrom`, the snapshot's chained data must
    // drive the agent's `task` and `## Input` (otherwise the agent renders
    // from the carried-over prepareResult — typically an auto-seeded signal
    // payload — and complains its inputs are missing). But the signal-payload
    // `config` must survive: downstream steps need `{{inputs.<signal_field>}}`
    // to keep working, and end-to-end values like a recipient email should not
    // get clobbered the moment a step uses inputFrom. So we merge: chained
    // doc keys layered on top of the carried-over config (collisions favor the
    // chained data, which matches the historical "inputFrom wins" intent for
    // any name that overlaps).
    const hasExplicitInputFrom =
      (action.type === "agent" || action.type === "llm") && action.inputFrom !== undefined;
    const effectivePrepareResult: PrepareResult | undefined =
      hasExplicitInputFrom && inputSnapshot
        ? { ...inputSnapshot, config: { ...prepareResult?.config, ...inputSnapshot.config } }
        : prepareResult;

    // Emit action started event
    if (sig._context?.onEvent) {
      sig._context.onEvent({
        type: "data-fsm-action-execution",
        data: {
          sessionId: sig._context.sessionId,
          workspaceId: sig._context.workspaceId,
          jobName: this._definition.id,
          actionType: action.type,
          actionId: this.getActionId(action),
          state: currentState,
          status: "started",
          timestamp: actionStartTime,
          inputSnapshot,
        },
      });
    }

    // Create a context bound to the pending documents/signals. Action outputs
    // are projected from documents; setResult remains only for auxiliary
    // caller-provided values such as __meta.
    const resultsMap = results ?? this._results;
    const context: Context = {
      documents: Array.from(documents.values()),
      state: currentState,
      results: this.materializeResults(documents, resultsMap),
      setResult: (key: string, data: Record<string, unknown>) => {
        if (documents.has(key)) {
          documents.set(key, { ...documents.get(key)!, data });
        } else {
          resultsMap.set(key, data);
        }
      },
      emit: (s: Signal) => {
        logger.debug("Signal emitted from action", {
          signalType: s.type,
          currentState,
          hasData: !!s.data,
        });
        // Cascaded signals inherit parent's context (including onEvent callback).
        // When the emitted signal has explicit data, it replaces the parent's
        // data entirely. When no data is provided (e.g. bare ADVANCE), the
        // parent's data (streamId, datetime) passes through.
        const cascadedSignal: SignalWithContext = sig._context
          ? { ...s, data: s.data ?? sig.data, _context: sig._context }
          : s;
        signals.push(cascadedSignal);
        return Promise.resolve();
      },
      updateDoc: this.makeUpdateDocFn(documents),
      createDoc: this.makeCreateDocFn(documents, currentState),
      deleteDoc: this.makeDeleteDocFn(documents, currentState),
    };

    let llmResultData: FSMActionExecutionEvent["data"]["llmResult"];

    // Build OTEL attributes based on action type
    const otelAttrs: Record<string, string | number | boolean> = {
      "fsm.action.type": action.type,
      "fsm.state": currentState,
      "fsm.job.name": this._definition.id,
    };
    const actionId = this.getActionId(action);
    if (actionId) otelAttrs["fsm.action.id"] = actionId;
    if (action.type === "llm") otelAttrs["fsm.action.model"] = action.model;

    const executeInSpan = async (span: OtelSpan | null) => {
      try {
        switch (action.type) {
          case "emit": {
            events.push({ event: action.event, data: action.data });
            logger.debug("Event emitted", { event: action.event, data: action.data });

            // If we have an emit function in context, call it to trigger transitions
            if (context.emit && action.event) {
              await context.emit({ type: action.event, data: action.data });
            }
            break;
          }

          case "llm": {
            if (!this.options.llmProvider) {
              throw new Error("LLM action requires llmProvider in FSMEngineOptions");
            }

            logger.debug("Executing LLM action", {
              model: action.model,
              state: currentState,
              hasTools: !!action.tools,
              toolCount: action.tools?.length ?? 0,
              outputTo: action.outputTo,
            });

            // Resolve workspace-scoped skills with optional job-level layer.
            // The FSM definition's id IS the job name in workspace.yml — the
            // FSMEngine is built per-job, so `this._definition.id` is the
            // authoritative source even if `sig._context.jobName` is missing
            // (e.g. older callers).
            //
            // LLM actions outside a workspace context get an empty list — we
            // don't fall back to the unfiltered catalog because that would leak
            // skills assigned to other workspaces into this LLM call.
            const workspaceId = sig._context?.workspaceId;
            const jobName = this._definition.id;
            const resolved: SkillSummary[] = workspaceId
              ? await resolveVisibleSkills(workspaceId, SkillStorage, { jobName })
              : [];
            if (!workspaceId) {
              logger.warn("LLM action without workspaceId — skill list empty", {
                state: currentState,
              });
            }
            // Per-action skill allowlist (LLMActionSchema.skills): narrows the
            // resolved set to those explicitly named on the action. See
            // `applySkillAllowlist` for the full inherit/empty/populated rules.
            const skills: SkillSummary[] = applySkillAllowlist(resolved, action.skills);
            if (action.skills) {
              logger.debug("Applied per-action skill filter", {
                workspaceId,
                jobName,
                state: currentState,
                requested: action.skills,
                matched: skills.map((s) => s.name),
                unmatched: unmatchedAllowlistEntries(resolved, action.skills),
                droppedCount: resolved.length - skills.length,
              });
            }
            logger.debug("Resolved workspace skills", {
              workspaceId,
              jobName,
              skillCount: skills.length,
              skillNames: skills.map((s) => s.name),
            });

            // Always run buildTools so atlas-platform's auto-injected tool set
            // (memory_save, memory_read, artifacts_create, artifacts_get,
            // parse_artifact, webfetch, etc.) is available regardless of
            // whether the action declares `tools:`. Authors don't need to
            // know which tools are platform vs workspace-defined; the
            // platform set is additive, mirroring chat-side behavior. When
            // the action declares tools, those *narrow* the workspace-server
            // side via buildTools' existing allowlist; platform tools remain
            // ambient (PLATFORM_TOOL_ALLOWLIST in buildTools is already
            // filtered there). Phase 5 of the fan-in plan.
            const buildResult = await this.buildTools(
              action.tools ?? [],
              context,
              sig._context,
              actionId,
            );
            const baseTools = buildResult.tools;

            let cleanupSkills: (() => Promise<void>) | undefined;
            if (skills.length > 0) {
              // Cast to Tool to avoid deep type instantiation issues with AI SDK generics
              const { tool: loadSkill, cleanup } = createLoadSkillTool({ workspaceId, jobName });
              baseTools.load_skill = loadSkill as Tool;
              cleanupSkills = cleanup;
            }

            try {
              // Inject failStep tool for explicit failure signaling
              const failStepTool = tool({
                description:
                  "Signal that you cannot complete this task. Use this when you lack required information, encounter an unrecoverable error, or the task is impossible to complete.",
                inputSchema: FailInputSchema,
                execute: (input: FailInput) => ({ failed: true, reason: input.reason }),
              });

              const tools: Record<string, Tool> = { ...baseTools, failStep: failStepTool };

              // Phase 7 — opt-in `delegate` tool for FSM type:llm actions.
              // Mirrors the chat-side wiring: the LLM declares `tools:
              // [..., "delegate"]` to spawn an in-process child agent with
              // isolated context. Skipped silently with a debug log when a
              // required dep (platformModels) is unwired or when the
              // workspace's `delegation.max_depth` is exhausted, so authors
              // can declare the tool unconditionally without runtime errors
              // in environments that don't support it.
              const wantsDelegate = (action.tools ?? []).includes("delegate");
              if (wantsDelegate) {
                const currentDepth = sig._context?.delegationDepth ?? 0;
                const maxDepth = this.options.delegationBudget?.max_depth ?? DEFAULT_MAX_DEPTH;
                if (!this.options.platformModels) {
                  logger.debug(
                    "delegate requested but FSMEngineOptions.platformModels missing — omitting from tool set",
                    { state: currentState, jobName: this._definition.id },
                  );
                } else if (currentDepth >= maxDepth) {
                  logger.debug("delegate requested but delegation depth cap reached — omitting", {
                    state: currentState,
                    currentDepth,
                    maxDepth,
                  });
                } else {
                  // Build a synthetic writer that forwards every chunk into
                  // the FSM signal's `onStreamEvent` callback. The delegate
                  // expects a `UIMessageStreamWriter`; FSM's adapter exposes
                  // a per-chunk callback. The bridge below preserves the
                  // delegate's envelope semantics (`data-delegate-chunk`,
                  // `data-delegate-ledger`, `delegate-end`) — the chat-side
                  // path uses an SSE-backed writer; we use a callback fan-out
                  // that delivers chunks to the same downstream consumer.
                  const onStreamEvent = sig._context?.onStreamEvent;
                  const bridgedWriter: UIMessageStreamWriter<
                    import("@atlas/agent-sdk").AtlasUIMessage
                  > = {
                    write(chunk) {
                      onStreamEvent?.(chunk);
                    },
                    async merge(stream) {
                      const reader = stream.getReader();
                      try {
                        while (true) {
                          const { done, value } = await reader.read();
                          if (done) return;
                          if (value !== undefined) onStreamEvent?.(value);
                        }
                      } finally {
                        reader.releaseLock();
                      }
                    },
                    onError: undefined,
                  };

                  const ws = sig._context?.workspaceId ?? this.options.scope.workspaceId;
                  const ss = sig._context?.sessionId ?? this.options.scope.sessionId ?? "fsm";
                  const delegateTool = createDelegateTool(
                    {
                      writer: bridgedWriter,
                      session: {
                        sessionId: ss,
                        workspaceId: ws,
                        // FSM signals don't carry a streamId today; reuse
                        // sessionId as the correlation key. Same fallback
                        // pattern as `buildTools`'s scrubber wiring.
                        streamId: ss,
                      },
                      platformModels: this.options.platformModels,
                      logger,
                      abortSignal: sig._context?.abortSignal,
                      // Default to the agent-sdk's repair fn when the engine
                      // wasn't constructed with one. Keeps unit-test wiring
                      // minimal while honoring chat-parity in production.
                      repairToolCall:
                        this.options.repairToolCall ??
                        (((args: unknown) => Promise.resolve(args)) as ToolCallRepairFunction<
                          Record<string, Tool>
                        >),
                      linkSummary: this.options.linkSummary,
                      // Pass the resolved budget and current depth. The
                      // delegate enforces
                      // wall-clock / input-tokens / output-tokens / steps
                      // internally; depth fail-fast happens at execute
                      // time when `depth >= max_depth` (covers the case
                      // of a stale tool-list snapshot).
                      budget: this.options.delegationBudget,
                      depth: currentDepth,
                    },
                    () => {
                      // The child inherits the parent's tool set minus
                      // `delegate` itself (the existing destructuring inside
                      // `createDelegateTool` performs the strip). We pass
                      // the assembled `tools` map by closure; the thunk lets
                      // the delegate read the final shape after `complete`
                      // tool injection finishes below.
                      return tools as import("@atlas/agent-sdk").AtlasTools;
                    },
                  );
                  tools.delegate = delegateTool as unknown as Tool;
                }
              }

              // Every output document needs a mechanical emission contract.
              // Explicit outputType schemas use the declared document schema;
              // untyped outputTo actions get a non-empty object contract
              // instead of relying on free-form prose.
              let capturedCompleteOutput: Record<string, unknown> | undefined;
              let completeToolInjected = false;

              if (action.outputTo) {
                // Determine document type name for schema lookup:
                // 1. action.outputType takes precedence (explicit mapping)
                // 2. Fall back to document.type if document exists
                const outputDoc = documents.get(action.outputTo);
                const docTypeName = action.outputType ?? outputDoc?.type;
                const jsonSchema = docTypeName
                  ? this._definition.documentTypes?.[docTypeName]
                  : undefined;
                const compiledSchema =
                  docTypeName && hasDefinedSchema(jsonSchema)
                    ? this._compiledSchemas.get(docTypeName)
                    : undefined;
                const outputSchema =
                  compiledSchema ??
                  z
                    .record(z.string(), z.unknown())
                    .refine((value) => Object.keys(value).length > 0, {
                      message: "complete output must not be empty",
                    });

                completeToolInjected = true;
                tools.complete = {
                  description:
                    "Call this to complete the task and store results. You MUST call this when finished.",
                  inputSchema: outputSchema,
                  execute: () => ({ success: true }),
                };

                logger.debug("Injected complete tool for output document", {
                  docType: docTypeName ?? "LLMResult",
                  outputTo: action.outputTo,
                  hasExplicitOutputType: Boolean(action.outputType),
                });
              }

              // Build the prompt as two parts: a static `system` (cacheable
              // prefix) and a volatile `preface` (turn-local content that
              // sits AFTER the cache breakpoint). buildContextPrompt
              // produces the action's instruction surface for `system` and
              // temporal facts + retrieved input for `preface`; memory and
              // artifact retrievals get prepended into `preface` below.
              let {
                system: systemPrompt,
                preface: prefaceText,
                images,
              } = await this.buildContextPrompt(action.prompt, effectivePrepareResult, skills);

              // Recent narrative-memory entries land in the volatile preface
              // (NOT the cacheable system) — the entries change as the user
              // writes, and mixing them into the system prompt would shift
              // its bytes turn-to-turn and defeat caching. The XML envelope
              // (`<memory workspace="..." store="...">`) is identical to
              // workspace-chat so the model applies one rule everywhere.
              // Skipped without a workspaceId (pre-1.0 callers / unit
              // tests) — without one we can't authoritatively scope memory.
              // Failures are swallowed and logged; never blocks the action.
              if (workspaceId) {
                try {
                  // Honor foregroundWorkspaceIds the same way chat does
                  // (composeMemoryBlocks reads memory across the primary +
                  // any foreground workspaces). Without this, FSM jobs
                  // triggered via foreground-workspace cascades silently
                  // see a smaller memory surface than chat.
                  const rawFgIds = sig.data?.foregroundWorkspaceIds;
                  const foregroundIds = Array.isArray(rawFgIds)
                    ? rawFgIds.filter((id): id is string => typeof id === "string")
                    : [];
                  const memoryBlocks = await composeMemoryBlocks(
                    workspaceId,
                    foregroundIds,
                    logger,
                  );
                  if (memoryBlocks.length > 0) {
                    prefaceText = `${memoryBlocks.join("\n\n")}\n\n${prefaceText}`;
                    logger.debug("Injected memory blocks into LLM action preface", {
                      workspaceId,
                      blockCount: memoryBlocks.length,
                    });
                  }
                } catch (err) {
                  logger.warn("composeMemoryBlocks failed — proceeding without memory blocks", {
                    workspaceId,
                    error: stringifyError(err),
                  });
                }
              }

              // Retrieval-gated artifact injection. Pull recent session-bound
              // ephemeral artifacts and prepend them as `<retrieved_content>`
              // envelopes alongside the memory blocks in the volatile
              // preface. The workspace runtime tags FSM-produced ephemeral
              // artifacts with `lifecycle.boundTo.sessionId`, and
              // `composeArtifactBlocks` filters on that. Capped at
              // ARTIFACT_INJECTION_LIMIT (10). Each block carries the
              // artifact's summary + id so the LLM can `parse_artifact` for
              // full content. Failures swallowed.
              const sessionIdForArtifacts = sig._context?.sessionId;
              if (workspaceId && sessionIdForArtifacts) {
                try {
                  const artifactBlocks = await composeArtifactBlocks(
                    { workspaceId, sessionId: sessionIdForArtifacts },
                    logger,
                  );
                  if (artifactBlocks.length > 0) {
                    prefaceText = `${artifactBlocks.join("\n\n")}\n\n${prefaceText}`;
                    logger.debug("Injected artifact blocks into LLM action preface", {
                      workspaceId,
                      sessionId: sessionIdForArtifacts,
                      blockCount: artifactBlocks.length,
                    });
                  }
                } catch (err) {
                  logger.warn("composeArtifactBlocks failed — proceeding without artifact blocks", {
                    workspaceId,
                    sessionId: sessionIdForArtifacts,
                    error: stringifyError(err),
                  });
                }
              }

              // When the action's resolved validate decision is `self`, compose the
              // validating-llm-outputs system skill into the prompt so the
              // LLM self-checks its draft before emitting. This mirrors the
              // agent-orchestrator prompt assembly path.
              //
              // We resolve the decision PRE-call here using only static
              // signals — `calledToolNames` and `emittedProse` are unknowable
              // at prompt-build time, so the static path treats them as
              // empty/false. The post-call gating site below re-resolves
              // with observed signals; in the rare edge case where they
              // disagree (e.g. mutating-tool declared but never called),
              // the prompt-time path may inject the skill while the
              // post-call path picks `skip` — we eat that asymmetry rather
              // than build a two-phase classifier knob. Inline self-check
              // only adds prompt tokens; nothing downstream depends on the
              // pre-call decision.
              const declaredToolsStatic = action.tools ?? [];
              // Thread per-MCP `validation:` overrides and the action's
              // `run_code: { readOnly: true }` opt-in into the classifier
              // so author overrides win over the default regex / allowlist.
              const mcpServerOverrides = this.buildMCPValidationOverrides();
              const preCallResolution = resolveValidateDecision(
                action.validate,
                {
                  declaredTools: declaredToolsStatic,
                  calledToolNames: [],
                  hasOutputType: completeToolInjected,
                  hasInputFrom: !!action.inputFrom,
                  resolvedAgentType: undefined,
                  emittedProse: false,
                  toolsAvailable: declaredToolsStatic.length > 0,
                  ...(mcpServerOverrides ? { mcpServerOverrides } : {}),
                  ...(action.run_code?.readOnly ? { runCodeReadOnly: true } : {}),
                },
                { job: this.options.jobValidation, workspace: this.options.workspaceValidation },
              );
              const preCallDecision = preCallResolution.decision;
              // On the structured + self path, skip the validation skill body
              // too — not just the `record_validation` tool injection below.
              // The skill body instructs the LLM to call `record_validation`
              // exactly once, but the tool
              // isn't in the catalog. The contradictory instructions made
              // the LLM bail into prose ("the artifact chain keeps
              // wrapping...") instead of calling `complete`. Use the same
              // `completeToolInjected` predicate as the tool-skip site
              // below so both gates share one source of truth.
              const skipValidationSkillBody = preCallDecision === "self" && completeToolInjected;
              const validationBlock = skipValidationSkillBody
                ? ""
                : await composeValidationBlock({
                    decision: preCallDecision,
                    // Prefer merged skill (factors action object form +
                    // job + workspace overrides) over the older direct read
                    // of action.validate.skill.
                    skillName: preCallResolution.skill,
                    logger,
                  });
              const validationSkillLoaded = validationBlock.length > 0;
              if (validationBlock) {
                // Validation guidance lives in the cacheable system surface —
                // the skill body is byte-stable for a given (decision, skill)
                // pair, so co-locating it with the action prompt extends the
                // cached prefix.
                systemPrompt = `${systemPrompt}\n\n${validationBlock}`;
                logger.debug("Injected validation skill block into LLM action system", {
                  decision: preCallDecision,
                  blockChars: validationBlock.length,
                });
              }

              // When the pre-call decision is `self`, inject the
              // `record_validation` platform tool alongside
              // the skill body. The skill instructs the LLM to call this tool
              // before emitting; the post-call gating site below reads the
              // captured args off `result.toolCalls` (mirroring the `complete`
              // tool's capture path) and surfaces them on `step:complete.validation`.
              //
              // Mirrors `completeToolInjected`: a flag carries the injection
              // state forward to the capture site so we don't re-derive the
              // decision there. Pre-call asymmetry note: in the rare edge case
              // where pre-call resolves `self` but the post-call classifier
              // resolves `skip`, the injected tool is harmless — the LLM may
              // call it (we capture and emit) or ignore it (we emit a skip
              // verdict from the post-call path, ignoring whatever the LLM
              // recorded). The same asymmetry-tolerance applies to the skill
              // body — see the longer comment above `preCallResolution`.
              //
              // Structured-output actions (those with `outputType:` resolving
              // to a defined schema, i.e. `completeToolInjected`) skip
              // `record_validation` injection.
              // The structured schema IS the validation contract — pinning
              // toolChoice to `complete` is what makes structured output
              // reliable, and `record_validation` injection forces toolChoice
              // back to `auto` (see `llmToolChoice` below), letting the LLM
              // emit free-form prose instead of calling `complete`. Authors
              // who want explicit self-verdict on structured output should
              // split into two FSM steps (free-form analyze → structured
              // emit). The skill body is also skipped on this path — see the
              // `skipValidationSkillBody` block above for why. Verdict on the
              // structured + self path is implicit
              // pass on successful complete-tool emission.
              const recordValidationInjected = preCallDecision === "self" && !completeToolInjected;
              if (recordValidationInjected) {
                tools[RECORD_VALIDATION_TOOL_NAME] = createRecordValidationTool();
                logger.debug("Injected record_validation tool", {
                  decision: preCallDecision,
                  state: currentState,
                });
              }

              if (completeToolInjected) {
                systemPrompt +=
                  "\n\nIMPORTANT: When you have gathered all necessary information, you MUST call the `complete` tool to store your results. " +
                  "If you cannot complete this task, call the failStep tool with a reason.";
              } else {
                systemPrompt +=
                  "\n\nIMPORTANT: If you cannot complete this task, call the failStep tool with a reason.";
              }

              // Build agentId for the LLM action
              const llmAgentId = `fsm:${this._definition.id}:${action.outputTo ?? "llm"}`;

              // The volatile preface (temporal facts + memory + artifacts +
              // retrieved input + image text fallbacks) rides as the user
              // message body. Images attach as additional content parts on
              // that same message. The static `systemPrompt` flows as a
              // separate `system` parameter so the adapter can mark it
              // cacheable for Anthropic. When the preface is empty AND no
              // images are present, the LLM still needs a user-role turn to
              // respond to — fall back to a single-space user message so
              // the request is well-formed without inflating the cached
              // prefix.
              const userText = prefaceText.length > 0 ? prefaceText : " ";
              const messages: ModelMessage[] = [
                {
                  role: "user",
                  content:
                    images.length > 0 ? [{ type: "text", text: userText }, ...images] : userText,
                },
              ];

              // When both `complete` (structured-output capture) and
              // `record_validation` (self-check capture) are injected, we
              // can't pin toolChoice to `complete` — that would forbid the
              // LLM from calling record_validation. Switch to `auto` so the
              // LLM can sequence record_validation → complete the way the
              // skill body instructs. Stop semantics still halt on complete
              // OR failStep, so the second-tool-call assumption stays
              // sound. When only complete is injected, today's pinned
              // toolChoice path is preserved.
              //
              // With the `recordValidationInjected` guard above
              // (structured + self skips `record_validation` injection),
              // structured-output actions always pin toolChoice to
              // `complete`.
              const hasActionTools = (action.tools?.length ?? 0) > 0;
              const llmToolChoice =
                completeToolInjected && !recordValidationInjected
                  ? hasActionTools
                    ? ("required" as const)
                    : ({ type: "tool", toolName: "complete" } as const)
                  : ("auto" as const);

              const result = await this.options.llmProvider.call({
                agentId: llmAgentId,
                provider: action.provider,
                model: action.model,
                system: systemPrompt,
                prompt: userText,
                messages,
                tools,
                toolChoice: llmToolChoice,
                stopOnToolCall: completeToolInjected ? ["complete", "failStep"] : ["failStep"],
                onStreamEvent: sig._context?.onStreamEvent,
                abortSignal: sig._context?.abortSignal,
              });

              // Check for adapter-level errors (network, API, etc.)
              if (!result.ok) {
                throw new Error(`LLM call failed: ${result.error.reason}`);
              }

              // Emit tool events for UI visibility (skip when streaming — events already emitted in real-time)
              if (!sig._context?.onStreamEvent) {
                this.emitToolEvents(result, action, sig, currentState);
              }

              // Pre-populate the side-channel toolCalls before the
              // validation-failure throws below (`failStep`, missing
              // `complete`, empty output, empty response). Without this
              // the catch handler at the bottom of executeInSpan sees
              // `llmResultData === undefined` and
              // `mapActionToStepComplete` writes `toolCalls: []` into
              // the persisted `step:complete` event — even though
              // `emitToolEvents` already streamed the calls to the UI
              // in real time. Brings case-`llm` to parity with the
              // case-`agent` path further down, which already captures
              // tool calls before throwing on `!result.ok`.
              const earlyResultsByCallId = new Map(
                result.toolResults?.map((tr) => [tr.toolCallId, tr.output]) ?? [],
              );
              const rawObservedToolCalls = (result.toolCalls ?? []).map((tc) => ({
                toolName: tc.toolName,
                args: tc.input,
                ...(earlyResultsByCallId.has(tc.toolCallId) && {
                  result: earlyResultsByCallId.get(tc.toolCallId),
                }),
              }));
              const earlyLiftWorkspaceId = sig._context?.workspaceId;
              const earlyLiftSessionId = sig._context?.sessionId;
              llmResultData = {
                toolCalls:
                  earlyLiftWorkspaceId && earlyLiftSessionId
                    ? await liftToolResultsForPersist(rawObservedToolCalls, {
                        workspaceId: earlyLiftWorkspaceId,
                        chatId: earlyLiftSessionId,
                        logger,
                      })
                    : rawObservedToolCalls,
              };

              // Check if LLM called failStep (search toolCalls for multi-tool scenarios)
              const failArgs = findFailStepToolArgs(result);
              if (failArgs) {
                throw new Error(`LLM step failed: ${JSON.stringify(failArgs)}`);
              }

              // Check if LLM called complete tool - capture the contracted output.
              if (completeToolInjected) {
                capturedCompleteOutput = findCompleteToolArgs(result);
                if (!capturedCompleteOutput) {
                  throw new Error(
                    `LLM action with outputTo '${action.outputTo}' did not call complete`,
                  );
                }
                if (Object.keys(capturedCompleteOutput).length === 0) {
                  throw new Error(
                    `LLM action with outputTo '${action.outputTo}' emitted empty output`,
                  );
                }
                const response = capturedCompleteOutput.response;
                if (typeof response === "string" && response.trim().length === 0) {
                  throw new Error(
                    `LLM action with outputTo '${action.outputTo}' emitted an empty response`,
                  );
                }
              }

              // Resolve the per-action validation strategy and gate the
              // external-judge call by it.
              // `external` runs the runJudge callback; `self` injects the
              // inline self-check skill body; `skip` bypasses validation
              // entirely. The classifier (used when the author hasn't set
              // `validate:`) never returns `external`.
              // Trace records the full prompt the model saw — system
              // (cacheable) + user (volatile preface). Concatenated for
              // the trace surface; the wire-format split into separate
              // messages is captured upstream by the adapter.
              const tracePrompt = `${systemPrompt}\n\n${userText}`;
              const observedTrace = buildLLMActionTrace(result, action.model, tracePrompt);
              const declaredTools = action.tools ?? [];
              const classifierInput: ClassifierInput = {
                declaredTools,
                calledToolNames: observedTrace.toolCalls?.map((tc) => tc.toolName) ?? [],
                hasOutputType: completeToolInjected,
                hasInputFrom: !!action.inputFrom,
                // case "llm" — type is always "llm". The case "agent" path
                // fills in resolvedAgentType before classification.
                resolvedAgentType: undefined,
                emittedProse:
                  typeof observedTrace.content === "string" &&
                  observedTrace.content.trim().length > 0,
                toolsAvailable: declaredTools.length > 0,
                // Re-thread overrides for the post-call resolution.
                ...(mcpServerOverrides ? { mcpServerOverrides } : {}),
                ...(action.run_code?.readOnly ? { runCodeReadOnly: true } : {}),
              };
              const {
                decision: validateDecision,
                source: validateSource,
                reason: validateReason,
              } = resolveValidateDecision(action.validate, classifierInput, {
                job: this.options.jobValidation,
                workspace: this.options.workspaceValidation,
              });
              logger.info("validate-decision resolved", {
                state: currentState,
                action: action.outputTo ?? "anonymous",
                decision: validateDecision,
                source: validateSource,
                reason: validateReason,
                ranExternalJudge: validateDecision === "external" && !!this.options.runJudge,
                // Whether the inline self-check skill was injected at
                // prompt-build time. Useful to verify in `global.log` that
                // self-decisions actually got the skill body — and to spot
                // pre/post-call decision asymmetry (preCall=self injected
                // skill, postCall=skip).
                validationSkillLoaded,
              });

              // Track the verdict that ultimately survives the external-judge
              // lifecycle so it can ride on
              // `step:complete.validation`. Set at every point a verdict is
              // accepted (first-call pass, first-call uncertain, retry pass,
              // retry uncertain). On terminal-fail the throw upstream
              // unwinds before we read this back.
              let externalSurvivingVerdict: ValidationVerdict | undefined;

              // External validation invokes a system-level judge agent. The
              // runtime hands the judge an action-output + tool-call manifest
              // (refs-not-bytes for scrubber-lifted results); the judge returns
              // a structured verdict. Judge failures synthesize an advisory
              // verdict so the action still emits.
              if (validateDecision === "external" && this.options.runJudge) {
                const trace = buildLLMActionTrace(result, action.model, tracePrompt);
                const validationActionId = this.getActionId(action);
                const judgeAgentId =
                  typeof action.validate === "object" &&
                  action.validate !== null &&
                  typeof action.validate.agent === "string"
                    ? action.validate.agent
                    : "judge-agent";

                this.emitValidationAttempt(sig, currentState, validationActionId, {
                  attempt: 1,
                  status: "running",
                });

                const judgeResult = await this.options.runJudge({
                  agentId: judgeAgentId,
                  handoff: buildJudgeHandoff(trace),
                  ...(sig._context?.workspaceId ? { workspaceId: sig._context.workspaceId } : {}),
                  ...(sig._context?.sessionId ? { sessionId: sig._context.sessionId } : {}),
                  abortSignal: sig._context?.abortSignal,
                });

                if (judgeResult.ok) {
                  externalSurvivingVerdict = judgeResult.verdict;
                  this.emitValidationAttempt(sig, currentState, validationActionId, {
                    attempt: 1,
                    status: judgeResult.verdict.verdict === "blocking" ? "failed" : "passed",
                    terminal: true,
                    verdict: judgeResult.verdict,
                  });
                  if (judgeResult.verdict.verdict === "blocking") {
                    logger.error("LLM action external validation: blocking", {
                      state: currentState,
                      model: action.model,
                      issues: judgeResult.verdict.issues,
                    });
                    throw new ValidationFailedError(judgeResult.verdict, llmAgentId);
                  }
                } else {
                  // Judge failure → advisory verdict with judge-error category.
                  // Action still emits; the failure is observable
                  // on `step:complete.validation`.
                  logger.warn("Judge failed, synthesizing advisory verdict", {
                    state: currentState,
                    model: action.model,
                    error: judgeResult.error,
                  });
                  externalSurvivingVerdict = {
                    verdict: "advisory",
                    issues: [
                      {
                        category: "judge-error",
                        severity: "info",
                        claim: "validation",
                        reasoning: `judge failed: ${judgeResult.error}`,
                      },
                    ],
                  };
                  this.emitValidationAttempt(sig, currentState, validationActionId, {
                    attempt: 1,
                    status: "passed",
                    terminal: true,
                    verdict: externalSurvivingVerdict,
                  });
                }
              } else if (validateDecision === "self") {
                // The validating-llm-outputs skill was already composed into
                // `contextPrompt` pre-call (see `composeValidationBlock`
                // above), so the LLM self-checked its draft inside the same
                // call. No separate post-call step needed at this gate.
                // The `record_validation` tool was injected pre-call when
                // preCallDecision === "self"; the captured args are read off
                // result.toolCalls below for `step:complete.validation`.
              } else if (validateDecision === "skip") {
                // No validation. The decision was logged above; nothing else
                // to do here.
              }

              // Build the structured validation block for emit. Three resolved
              // strategies → three shapes:
              //   skip     → { strategy, skipReason }
              //   self     → { strategy, verdict?, issues? }   (record_validation)
              //   external → { strategy, verdict, issues? }    (judge-derived)
              // The captured `validateDecision` (post-call) wins over the
              // pre-call decision used to inject the tool — see preCallResolution
              // for the asymmetry-tolerance comment. For external, the surviving
              // verdict (after retry, when applicable) is the one we surface.
              const recordedValidationArgs =
                validateDecision === "self" ? findRecordValidationToolArgs(result) : undefined;
              const validationOutput = buildValidationOutput({
                decision: validateDecision,
                reason: validateReason,
                recordedArgs: recordedValidationArgs,
                // Structured + self path emits an implicit pass verdict.
                ...(validateDecision === "self" && completeToolInjected
                  ? { implicitPass: true }
                  : {}),
                ...(validateDecision === "external" && externalSurvivingVerdict
                  ? { externalVerdict: externalSurvivingVerdict }
                  : {}),
              });

              // Sentinel-text guard. When `validate: self` resolves and the
              // LLM had no `complete` tool to pin a structured output,
              // the outputDoc falls back to `result.data.response` — i.e.
              // the model's most recent text turn before its closing tool
              // call. If that text reads like a transition phrase ("Now let
              // me record validation and return the final output:") rather
              // than the actual content the action was asked to produce,
              // the persisted doc will be a stub. Log a warn so the
              // operator can correlate and either tighten the action's
              // prompt or add an outputType schema. Heuristic — this
              // doesn't fail the action, just surfaces it. Repro:
              // Known trigger: a transition phrase just before `record_validation`.
              if (
                validateDecision === "self" &&
                !completeToolInjected &&
                recordedValidationArgs !== undefined
              ) {
                const responseText =
                  typeof (result.data as { response?: unknown })?.response === "string"
                    ? ((result.data as { response: string }).response as string)
                    : "";
                const trimmed = responseText.trim();
                const looksTransitional =
                  trimmed.length > 0 &&
                  trimmed.length < 500 &&
                  (trimmed.endsWith(":") || /^(now\s+(let|i)|let\s+me|i'?ll\s+now)/i.test(trimmed));
                if (looksTransitional) {
                  logger.warn(
                    "LLM action validate:self may have terminated on record_validation without emitting final output",
                    {
                      state: currentState,
                      outputTo: action.outputTo,
                      responseChars: trimmed.length,
                      responseHead: trimmed.slice(0, 120),
                      hint: "Update the action's prompt (or the validating-llm-outputs skill) so the LLM emits its final output before calling record_validation.",
                    },
                  );
                }
              }

              // failStep semantics on a self-recorded `blocking` verdict.
              // The LLM has explicitly told us its output is unsourced and
              // should not emit; treat that signal the same way as a failStep
              // tool call. Mirrors the `findFailStepToolArgs` → throw path
              // immediately above. Skipped on `external` because the judge's
              // retry-and-throw lifecycle already runs upstream; if the
              // external surviving verdict is `blocking`, we got there via
              // the already-thrown ValidationFailedError path — not via this
              // branch.
              if (
                validationOutput?.strategy === "self" &&
                validationOutput.verdict === "blocking"
              ) {
                const issuesSummary =
                  validationOutput.issues
                    ?.map((i) => `${i.category ?? "issue"}: ${i.claim}`)
                    .join("; ") || "no issues recorded";
                throw new Error(`LLM action self-validation: blocking. ${issuesSummary}`);
              }

              if (action.outputTo) {
                const outputDoc = documents.get(action.outputTo);
                const newDocType = action.outputType ?? "LLMResult";
                // Use captured complete output if available, otherwise fall back to result.data
                // result.data is { response: string } for text output, or structured for complete tool
                const dataToStore = capturedCompleteOutput ?? result.data;

                if (capturedCompleteOutput) {
                  logger.debug("Storing structured output from complete tool", {
                    outputTo: action.outputTo,
                    hasData: Object.keys(capturedCompleteOutput).length > 0,
                  });
                }

                // Documents are the canonical action-output surface. LLMs
                // sometimes stringify nested JSON fields (e.g. arrays as JSON
                // strings); normalize before storing so downstream inputFrom
                // consumers receive the usable shape.
                const sanitized = unstringifyNestedJson(dataToStore);
                const parsed = z.record(z.string(), z.unknown()).safeParse(sanitized);
                const docData = parsed.success ? parsed.data : dataToStore;
                if (outputDoc) {
                  outputDoc.data = { ...outputDoc.data, ...docData };
                } else {
                  documents.set(action.outputTo, {
                    id: action.outputTo,
                    type: newDocType,
                    data: docData,
                  });
                }

                // Persist mid-session so a later action's
                // `composeArtifactBlocks({ workspaceId,
                // sessionId })` can see this document via
                // `ArtifactStorage.listBySession`. Without this hook the
                // post-drain pass is the only writer, so intra-session
                // retrieval injection is empty. No-op when the host hasn't
                // wired the callback.
                await this.maybePersistActionArtifact(
                  action,
                  documents.get(action.outputTo),
                  sig,
                  currentState,
                );
              }

              // Layer reasoning/output/usage/validation onto the
              // tool-call manifest captured earlier (post-LLM, pre-throw).
              // The early-capture block above runs unconditionally once
              // `result.ok` is confirmed at the adapter-error guard, so
              // `llmResultData` is guaranteed to be set here. Asserting
              // rather than defaulting means a future refactor that
              // moves the early-capture path fails loudly instead of
              // silently dropping tool calls into an empty array.
              if (!llmResultData) {
                throw new Error(
                  "FSM invariant: llmResultData must be set by the early-capture block " +
                    "before the success-path envelope is built. This indicates a refactor " +
                    "moved or removed the unconditional tool-call capture after the LLM call.",
                );
              }
              const toolCalls = llmResultData.toolCalls;
              // Structured output = args from the "complete" tool call (the actual
              // result the agent declared). Falls back to result.data (LLM text)
              // when no complete tool call exists. Mirrors workspace-runtime logic.
              const completeCall = toolCalls.find((tc) => tc.toolName === "complete");
              llmResultData = {
                toolCalls,
                reasoning: result.reasoning,
                output: completeCall?.args ?? result.data,
                // Pass-through optional `usage` from the LLM provider so the
                // session event mapper can persist it on `step:complete`.
                // Provider adapters that don't set usage (e.g. tests with
                // stub providers) leave this undefined — handled downstream.
                ...(result.usage && { usage: result.usage }),
                // Ride the structured validation block on the same
                // side-channel `step:complete` mapping reads. Always set
                // for `type: llm` actions — the three resolved strategies
                // each have a non-empty shape; only pure-agent actions
                // (case "agent" → type: user/atlas) leave this absent.
                ...(validationOutput && { validation: validationOutput }),
              };

              // Add tool call names to OTEL span for trace visibility
              if (span && llmResultData?.toolCalls?.length) {
                const toolNames = llmResultData.toolCalls
                  .map((tc) => tc.toolName)
                  .filter((n) => n !== "complete" && n !== "failStep");
                if (toolNames.length) {
                  span.setAttribute("fsm.tools.called", toolNames.join(", "));
                }
              }

              logger.debug("LLM action completed", {
                model: action.model,
                outputTo: action.outputTo,
              });
            } finally {
              await buildResult.dispose();
              cleanupSkills?.();
            }
            break;
          }

          case "agent": {
            if (!this.options.agentExecutor) {
              throw new Error(
                `Agent action requires agentExecutor in FSMEngineOptions. ` +
                  `Pass agentExecutor callback that integrates with your agent system. ` +
                  `Agent: ${action.agentId}`,
              );
            }

            logger.debug("Executing agent action", {
              agentId: action.agentId,
              state: currentState,
              outputTo: action.outputTo,
              hasSignalContext: !!sig._context,
              hasOnStreamEvent: !!sig._context?.onStreamEvent,
              hasPrepareInput: !!prepareResult,
              resultKeys: Object.keys(this.materializeResults(documents, resultsMap)),
            });

            // Build context for agent execution
            const agentContext: Context = {
              documents: Array.from(documents.values()),
              state: currentState,
              results: this.materializeResults(documents, resultsMap),
              ...(effectivePrepareResult ? { input: effectivePrepareResult } : {}),
              emit: context.emit,
              updateDoc: this.makeUpdateDocFn(documents),
              createDoc: this.makeCreateDocFn(documents, currentState),
              deleteDoc: this.makeDeleteDocFn(documents, currentState),
            };

            // Resolve output schema from documentTypes — same fallback logic as LLM actions:
            // 1. action.outputType takes precedence (explicit mapping)
            // 2. Fall back to existing document's type if document exists
            const outputDoc = action.outputTo ? documents.get(action.outputTo) : undefined;
            const agentDocTypeName = action.outputType ?? outputDoc?.type;
            const agentOutputSchema = agentDocTypeName
              ? z
                  .record(z.string(), z.unknown())
                  .optional()
                  .parse(this._definition.documentTypes?.[agentDocTypeName])
              : undefined;
            const resolvedAgentType = this.options.resolveAgentType?.(action.agentId);
            const defaultAgentOutputSchema =
              action.outputTo && !agentOutputSchema && resolvedAgentType === "llm"
                ? { type: "object", minProperties: 1, additionalProperties: true }
                : undefined;
            const executorOutputSchema = agentOutputSchema ?? defaultAgentOutputSchema;

            // Resolve the per-action validation decision PRE-call so it can
            // ride through
            // `AgentExecutorOptions` to the orchestrator's prompt-assembly
            // site (`convertLLMToAgent`'s system-prompt builder). The same
            // shape `case "llm"` uses inline — empty `calledToolNames` and
            // `emittedProse: false` because we don't have observed signals
            // yet — plus `resolvedAgentType` from the optional resolver so
            // the classifier can short-circuit `user`/`atlas` paths to
            // `skip` (rule 1 in `validate-classifier.ts`).
            // Agent actions don't carry a `tools:` allowlist — the agent
            // itself owns its tool surface (workspace.yml `agents.<id>`).
            // From the FSM engine's vantage we only know structural fields:
            // `outputType`, `inputFrom`, and the resolved agent kind. The
            // classifier short-circuits on type "user" / "atlas" before
            // reaching any tool-based rule, and for type "llm" without
            // declared tools it falls through to "default-self" — same
            // safe-by-default behavior as `case "llm"` with no tools.
            const agentClassifierInput: ClassifierInput = {
              declaredTools: [],
              calledToolNames: [],
              hasOutputType: !!executorOutputSchema,
              hasInputFrom: !!action.inputFrom,
              resolvedAgentType,
              emittedProse: false,
              toolsAvailable: false,
            };
            const {
              decision: agentValidateDecision,
              source: agentValidateSource,
              reason: agentValidateReason,
              skill: agentValidateSkill,
            } = resolveValidateDecision(action.validate, agentClassifierInput, {
              job: this.options.jobValidation,
              workspace: this.options.workspaceValidation,
            });

            // Execute agent via callback, passing full action object for prompt access
            // Agent returns AgentResult envelope directly
            const executorOptions: AgentExecutorOptions = {
              ...(executorOutputSchema ? { outputSchema: executorOutputSchema } : {}),
              validateDecision: agentValidateDecision,
              ...(agentValidateSkill ? { validateSkill: agentValidateSkill } : {}),
            };
            const result = await this.options.agentExecutor(
              action,
              agentContext,
              sig,
              executorOptions,
            );

            // Mirror `case "llm"`'s `validate-decision resolved` info log so
            // both paths surface uniformly in `global.log`. `validationSkillLoaded`
            // is unknown from this side (the orchestrator owns the load) — we
            // report whether the decision was "self" so a reader can correlate
            // with orchestrator-side composeValidationBlock logs.
            logger.info("validate-decision resolved", {
              state: currentState,
              action: action.agentId,
              decision: agentValidateDecision,
              source: agentValidateSource,
              reason: agentValidateReason,
              ranExternalJudge: agentValidateDecision === "external" && !!this.options.runJudge,
              validationSkillLoaded: agentValidateDecision === "self",
              resolvedAgentType: resolvedAgentType ?? "unknown",
            });

            // Check envelope's ok discriminant for error. Preserve tool-call
            // observability for failed user agents before throwing so the
            // session history can explain what capability call failed.
            if (!result.ok) {
              const agentResultsByCallId = new Map(
                result.toolResults?.map((tr) => [tr.toolCallId, tr.output]) ?? [],
              );
              const rawAgentToolCalls = (result.toolCalls ?? []).map((tc) => ({
                toolName: tc.toolName,
                args: tc.input,
                ...(agentResultsByCallId.has(tc.toolCallId) && {
                  result: agentResultsByCallId.get(tc.toolCallId),
                }),
              }));
              const liftWorkspaceId = sig._context?.workspaceId;
              const liftSessionId = sig._context?.sessionId;
              const agentToolCalls =
                liftWorkspaceId && liftSessionId
                  ? await liftToolResultsForPersist(rawAgentToolCalls, {
                      workspaceId: liftWorkspaceId,
                      chatId: liftSessionId,
                      logger,
                    })
                  : rawAgentToolCalls;
              llmResultData = { toolCalls: agentToolCalls, output: { error: result.error.reason } };
              throw new Error(result.error.reason);
            }

            // Track the external surviving verdict for case "agent" so it
            // can ride on `step:complete.validation`. Mirrors the case
            // "llm" path's tracking. Set only when the judge accepted the
            // verdict (no throw); a thrown ValidationFailedError unwinds
            // before this is read.
            let agentExternalSurvivingVerdict: ValidationVerdict | undefined;

            // External validation invokes a system-level judge agent — same
            // shape as the case "llm" path. The judge sees the agent's output
            // + tool-call manifest (refs-not-bytes for scrubber-lifted results)
            // and returns a structured verdict. Judge failure synthesizes an
            // advisory verdict so the action still emits.
            if (agentValidateDecision === "external" && this.options.runJudge) {
              const validationActionId = this.getActionId(action);
              const judgeAgentId =
                typeof action.validate === "object" &&
                action.validate !== null &&
                typeof action.validate.agent === "string"
                  ? action.validate.agent
                  : "judge-agent";

              this.emitValidationAttempt(sig, currentState, validationActionId, {
                attempt: 1,
                status: "running",
              });
              const trace: LLMActionTrace = {
                content:
                  result.ok && typeof result.data === "string"
                    ? result.data
                    : result.ok
                      ? JSON.stringify(result.data)
                      : "",
                reasoning: result.ok ? result.reasoning : undefined,
                toolCalls: result.ok ? result.toolCalls : undefined,
                toolResults: result.ok ? result.toolResults : undefined,
                model: `agent:${action.agentId}`,
                prompt: action.prompt ?? "",
              };
              const judgeResult = await this.options.runJudge({
                agentId: judgeAgentId,
                handoff: buildJudgeHandoff(trace),
                ...(sig._context?.workspaceId ? { workspaceId: sig._context.workspaceId } : {}),
                ...(sig._context?.sessionId ? { sessionId: sig._context.sessionId } : {}),
                abortSignal: sig._context?.abortSignal,
              });

              if (judgeResult.ok) {
                agentExternalSurvivingVerdict = judgeResult.verdict;
                this.emitValidationAttempt(sig, currentState, validationActionId, {
                  attempt: 1,
                  status: judgeResult.verdict.verdict === "blocking" ? "failed" : "passed",
                  terminal: true,
                  verdict: judgeResult.verdict,
                });
                if (judgeResult.verdict.verdict === "blocking") {
                  throw new ValidationFailedError(judgeResult.verdict, action.agentId);
                }
              } else {
                logger.warn("Judge failed for agent action, synthesizing advisory", {
                  state: currentState,
                  agentId: action.agentId,
                  error: judgeResult.error,
                });
                agentExternalSurvivingVerdict = {
                  verdict: "advisory",
                  issues: [
                    {
                      category: "judge-error",
                      severity: "info",
                      claim: "validation",
                      reasoning: `judge failed: ${judgeResult.error}`,
                    },
                  ],
                };
                this.emitValidationAttempt(sig, currentState, validationActionId, {
                  attempt: 1,
                  status: "passed",
                  terminal: true,
                  verdict: agentExternalSurvivingVerdict,
                });
              }
            }

            // Build the structured validation block for `case "agent" → type:
            // llm`, mirroring the inline
            // `case "llm"` path. The `record_validation` tool was injected at
            // the orchestrator's prompt-assembly site (`from-llm.ts`) when
            // decision === "self"; capture its args off the agent result's
            // toolCalls — same mechanism `findCompleteToolArgs` uses, just
            // applied to the agent envelope.
            const agentRecordedValidationArgs =
              agentValidateDecision === "self" && result.ok
                ? extractToolCallInput(result.toolCalls ?? [], RECORD_VALIDATION_TOOL_NAME)
                : undefined;
            const agentValidationOutput = buildValidationOutput({
              decision: agentValidateDecision,
              reason: agentValidateReason,
              recordedArgs: agentRecordedValidationArgs,
              ...(agentValidateDecision === "external" && agentExternalSurvivingVerdict
                ? { externalVerdict: agentExternalSurvivingVerdict }
                : {}),
              ...(agentValidateDecision === "self" && executorOutputSchema
                ? { implicitPass: true }
                : {}),
            });

            const agentResultsByCallId = new Map(
              result.toolResults?.map((tr) => [tr.toolCallId, tr.output]) ?? [],
            );
            const rawAgentToolCalls = (result.toolCalls ?? []).map((tc) => ({
              toolName: tc.toolName,
              args: tc.input,
              ...(agentResultsByCallId.has(tc.toolCallId) && {
                result: agentResultsByCallId.get(tc.toolCallId),
              }),
            }));
            const liftWorkspaceId = sig._context?.workspaceId;
            const liftSessionId = sig._context?.sessionId;
            const agentToolCalls =
              liftWorkspaceId && liftSessionId
                ? await liftToolResultsForPersist(rawAgentToolCalls, {
                    workspaceId: liftWorkspaceId,
                    chatId: liftSessionId,
                    logger,
                  })
                : rawAgentToolCalls;
            const agentCompleteCall = agentToolCalls.find((tc) => tc.toolName === "complete");
            llmResultData = {
              toolCalls: agentToolCalls,
              reasoning: result.reasoning,
              output: agentCompleteCall?.args ?? result.data,
              ...(result.artifactRefs ? { artifactRefs: result.artifactRefs } : {}),
              ...(result.usage ? { usage: result.usage } : {}),
              ...(agentValidationOutput ? { validation: agentValidationOutput } : {}),
            };

            // failStep semantics on a self-recorded `blocking` verdict. Mirrors
            // the case "llm" path. The agent result projection above
            // lives directly on the action event; workspace runtime no longer
            // needs an out-of-band side-channel to build step:complete.
            if (
              agentValidationOutput?.strategy === "self" &&
              agentValidationOutput.verdict === "blocking"
            ) {
              const issuesSummary =
                agentValidationOutput.issues
                  ?.map((i) => `${i.category ?? "issue"}: ${i.claim}`)
                  .join("; ") || "no issues recorded";
              throw new Error(`Agent action self-validation: blocking. ${issuesSummary}`);
            }

            // Store result if outputTo specified
            // result.data is the structured output from the agent
            if (action.outputTo && result.data) {
              const parsed = z.record(z.string(), z.unknown()).safeParse(result.data);
              const baseData = parsed.success ? parsed.data : { value: result.data };

              // Validate against schema when outputType is declared
              if (action.outputType) {
                const schema = this._compiledSchemas.get(action.outputType);
                if (schema) {
                  const validation = schema.safeParse(baseData);
                  if (!validation.success) {
                    const issues = validation.error.issues
                      .map((i) => `${i.path.join(".")}: ${i.message}`)
                      .join(", ");
                    throw new Error(
                      `Agent '${action.agentId}' output does not match ${action.outputType} schema: ${issues}`,
                    );
                  }
                }
              }

              // Include artifactRefs after validation (execution metadata, not contract fields)
              const data =
                result.artifactRefs && result.artifactRefs.length > 0
                  ? { ...baseData, artifactRefs: result.artifactRefs }
                  : baseData;

              const existingDoc = documents.get(action.outputTo);
              if (existingDoc) {
                existingDoc.data = { ...existingDoc.data, ...data };
              } else {
                documents.set(action.outputTo, { id: action.outputTo, type: "AgentResult", data });
              }

              // See the matching call in `case "llm"` above for rationale.
              // Persist mid-session so
              // `composeArtifactBlocks` sees agent-action artifacts during
              // the same session that emitted them.
              await this.maybePersistActionArtifact(
                action,
                documents.get(action.outputTo),
                sig,
                currentState,
              );
            }

            logger.debug("Agent action completed", {
              agentId: action.agentId,
              outputTo: action.outputTo,
              durationMs: result.durationMs,
            });
            break;
          }

          case "notification": {
            if (!this.options.broadcastNotifier) {
              throw new Error(
                `FSMEngineOptions.broadcastNotifier is required to execute notification actions. ` +
                  `Engine host must wire one — atlasd does this automatically; third-party ` +
                  `consumers must construct their own.`,
              );
            }
            logger.debug("Executing notification action", {
              state: currentState,
              communicators: action.communicators,
              messageLength: action.message.length,
            });
            await this.options.broadcastNotifier.broadcast({
              message: action.message,
              communicators: action.communicators,
            });
            break;
          }

          default: {
            logger.error("Unknown action type", { action });
            throw new Error(`Unknown action type`);
          }
        }

        // Emit action completed event
        if (sig._context?.onEvent) {
          sig._context.onEvent({
            type: "data-fsm-action-execution",
            data: {
              sessionId: sig._context.sessionId,
              workspaceId: sig._context.workspaceId,
              jobName: this._definition.id,
              actionType: action.type,
              actionId: this.getActionId(action),
              state: currentState,
              status: "completed",
              durationMs: Date.now() - actionStartTime,
              timestamp: Date.now(),
              inputSnapshot,
              llmResult: llmResultData,
            },
          });
        }
      } catch (error) {
        // Emit action failed event before rethrowing
        if (sig._context?.onEvent) {
          sig._context.onEvent({
            type: "data-fsm-action-execution",
            data: {
              sessionId: sig._context.sessionId,
              workspaceId: sig._context.workspaceId,
              jobName: this._definition.id,
              actionType: action.type,
              actionId: this.getActionId(action),
              state: currentState,
              status: "failed",
              durationMs: Date.now() - actionStartTime,
              error: stringifyError(error),
              timestamp: Date.now(),
              inputSnapshot,
              llmResult: llmResultData,
            },
          });
        }
        throw error;
      }

      return prepareResult;
    }; // end executeInSpan

    return await withOtelSpan("fsm.action", otelAttrs, executeInSpan);
  }

  /**
   * Get a meaningful identifier for an action based on its type
   */
  private getActionId(action: Action): string | undefined {
    switch (action.type) {
      case "agent":
        return action.agentId;
      case "emit":
        return action.event;
      case "llm":
        return action.outputTo;
      case "notification":
        return action.message.slice(0, 40);
      default:
        return undefined;
    }
  }

  /**
   * Emit tool call and tool result events from an LLM result envelope.
   * Called after LLM calls to stream tool activity for UI visibility.
   * @param result - The LLM result envelope containing toolCalls/toolResults
   * @param action - The LLM action being executed (used for actionId correlation)
   * @param sig - Signal with context containing onEvent callback
   * @param currentState - Current FSM state for event correlation
   */
  private emitToolEvents(
    result: LLMResult,
    action: Action,
    sig: SignalWithContext,
    currentState: string,
  ): void {
    if (!sig._context?.onEvent || !result.ok) return;

    const actionId = this.getActionId(action);
    const timestamp = Date.now();
    const baseData = {
      sessionId: sig._context.sessionId,
      workspaceId: sig._context.workspaceId,
      jobName: this._definition.id,
      actionId,
      state: currentState,
      timestamp,
    };

    // Emit tool call events
    if (result.toolCalls) {
      for (const toolCall of result.toolCalls) {
        sig._context.onEvent({ type: "data-fsm-tool-call", data: { ...baseData, toolCall } });
      }
    }

    // Emit tool result events
    if (result.toolResults) {
      for (const toolResult of result.toolResults) {
        sig._context.onEvent({ type: "data-fsm-tool-result", data: { ...baseData, toolResult } });
      }
    }
  }

  /**
   * Emit a single validation-attempt lifecycle event.
   * `running` events have no `verdict`; `passed`/`failed` carry the verdict.
   * `terminal` is meaningful only on `failed` — `false` on a will-retry failure,
   * `true` on the second attempt's failure that throws.
   */
  private emitValidationAttempt(
    sig: SignalWithContext,
    currentState: string,
    actionId: string | undefined,
    payload: {
      attempt: number;
      status: "running" | "passed" | "failed";
      terminal?: boolean;
      verdict?: ValidationVerdict;
    },
  ): void {
    if (!sig._context?.onEvent) return;
    sig._context.onEvent({
      type: "data-fsm-validation-attempt",
      data: {
        sessionId: sig._context.sessionId,
        workspaceId: sig._context.workspaceId,
        jobName: this._definition.id,
        actionId,
        state: currentState,
        attempt: payload.attempt,
        status: payload.status,
        ...(payload.terminal !== undefined ? { terminal: payload.terminal } : {}),
        ...(payload.verdict !== undefined ? { verdict: payload.verdict } : {}),
        timestamp: Date.now(),
      },
    });
  }

  private async buildContextPrompt(
    basePrompt: string,
    prepareResult?: PrepareResult,
    skills: SkillSummary[] = [],
  ): Promise<{
    /** Static instruction surface — byte-stable for an action+skill set when
     *  the prompt has no Mustache placeholders. Lands at the cacheable prefix
     *  position so a repeated invocation hits the prompt cache. */
    system: string;
    /** Volatile turn-local content — temporal grounding + the prepare result
     *  Input + image text fallbacks. Sits AFTER the cache breakpoint so it
     *  doesn't poison the cached prefix. */
    preface: string;
    images: ImagePart[];
  }> {
    // Resolve `{{inputs.x}}` / `{{config.x}}` references against the prepare
    // result BEFORE composing the prompt. LLM-authored workspaces consistently
    // emit Mustache-style placeholders in agent prompts (it's how CrewAI,
    // LangChain, and every other agent framework do it); Atlas originally
    // didn't substitute them, so the LLM saw literal `{{inputs.content}}`
    // and refused with "required input values are missing" while the actual
    // payload sat in the Input section below. Interpolating here makes the
    // convention work without teaching every author a bespoke pattern. Keys
    // that don't resolve are left intact so broken templates are visible
    // rather than silently blanked to empty strings.
    //
    // Mustache-resolved prompts that vary by call (different inputs each
    // time) intentionally break cache — every byte of the system message
    // shifts and the provider correctly serves a fresh response.
    const resolvedBase = interpolatePromptPlaceholders(basePrompt, prepareResult);

    let system = resolvedBase;
    let preface = buildTemporalFacts();
    const images: ImagePart[] = [];

    if (prepareResult) {
      const expanded = await expandArtifactRefsInInput(prepareResult);

      // Resolve image artifacts from prepare result if storage adapter is available
      if (this.options.artifactStorage) {
        const input: Record<string, unknown> = prepareResult;
        const refsResult = z.array(z.object({ id: z.string() })).safeParse(input.artifactRefs);

        if (refsResult.success && refsResult.data.length > 0) {
          const result = await this.options.artifactStorage.getManyLatest({
            ids: refsResult.data.map((r) => r.id),
          });

          if (result.ok) {
            const parts = await resolveImageParts(result.data, this.options.artifactStorage);
            for (const part of parts) {
              if (part.type === "image") {
                images.push(part);
              } else {
                // TextPart fallback (binary read failed) — ride alongside
                // images in the volatile preface, not in the cacheable system.
                preface = `${preface}\n${part.text}`;
              }
            }
          }
        }
      }

      // Prepare-result Input is per-call data (the signal payload made it
      // here through `prepare`). Wrap in `<retrieved_content>` so the
      // model's hygiene rule treats nested JSON values as data — covers
      // cases where prepare functions copy signal-payload bytes into the
      // Input without sanitization. Lands in the volatile preface so a
      // repeated action with different inputs doesn't pretend to be a
      // cache hit on bytes that genuinely differ.
      preface = `${preface}\n\n${wrapRetrieved({
        source: "user-authored",
        origin: `fsm:${this._definition.id}:input`,
        body: `Input:\n${JSON.stringify(expanded, null, 2)}`,
      })}`;
    }

    if (skills.length > 0) {
      const namedSkills = skills.map((s) => ({
        name: `@${s.namespace}/${s.name}`,
        description: s.description,
      }));
      system = `${system}\n\n${formatAvailableSkills(namedSkills)}`;
    }

    return { system, preface, images };
  }

  /**
   * Build AI SDK Tool objects for LLM action.
   * MCP tools: ephemeral createMCPTools() call — dispose in finally block.
   *
   * `signalContext` carries the per-call session/workspace identity used by
   * scope-injected platform tools and by post-call artifact lifting when
   * oversized tool outputs are persisted.
   */
  private async buildTools(
    toolNames: string[],
    _context: Context,
    signalContext?: SignalWithContext["_context"],
    /**
     * Action id forwarded into the scope-injection wrapper so
     * `request_tool_access` can stamp the originating action onto its
     * elicitation envelope. Optional because non-LLM-action callers don't
     * own an action id (and don't expose `request_tool_access` anyway).
     */
    actionId?: string,
  ): Promise<{ tools: Record<string, Tool>; dispose: () => Promise<void> }> {
    const tools: Record<string, Tool> = {};
    let dispose: () => Promise<void> = async () => {};

    // `action.tools` accepts three entry shapes:
    //   "serverId/toolName" — qualified, strict per-tool allowlist for that server
    //   "serverId"          — bare server ID, all tools from that server
    //   "toolName"          — bare tool name (legacy); resolved against any
    //                         configured server that exposes it
    //
    // Per-server allowlist tracks which names are permitted from each server.
    // A server mapped to "all" exposes every tool it provides; a server mapped
    // to a Set is restricted to those names. Bare tool names get added to a
    // global pool that's matched by name regardless of source server.
    const knownServer = (id: string) => Boolean(this.options.mcpServerConfigs?.[id]);
    const serverAllow = new Map<string, "all" | Set<string>>();
    const bareToolNames = new Set<string>();
    for (const entry of toolNames) {
      const slash = entry.indexOf("/");
      if (slash > 0) {
        const sid = entry.slice(0, slash);
        const tn = entry.slice(slash + 1);
        const cur = serverAllow.get(sid);
        if (cur === "all") continue;
        if (cur instanceof Set) {
          cur.add(tn);
        } else {
          serverAllow.set(sid, new Set([tn]));
        }
      } else if (knownServer(entry)) {
        serverAllow.set(entry, "all");
      } else {
        bareToolNames.add(entry);
      }
    }
    const hasBareToolName = bareToolNames.size > 0;
    const hasNameAllowlist = hasBareToolName || [...serverAllow.values()].some((v) => v !== "all");

    // MCP tools: always include atlas-platform for ambient capabilities (webfetch,
    // artifacts) even when the action only uses FSM-defined tools. The connection
    // cost is one HTTP roundtrip + dispose per LLM action — acceptable tradeoff
    // for consistent platform tool availability.
    const effectiveConfigs: Record<string, MCPServerConfig> = {
      "atlas-platform": getAtlasPlatformServerConfig(),
    };
    // Server selection. Bare tool names can come from any server, so we have
    // to load all of them and rely on the post-filter to scope down. Without
    // any bare names we connect only to servers explicitly referenced — both
    // qualified (`serverId/toolName`) and bare server IDs.
    if (hasBareToolName && this.options.mcpServerConfigs) {
      for (const [id, config] of Object.entries(this.options.mcpServerConfigs)) {
        if (id !== "atlas-platform") effectiveConfigs[id] = config;
      }
    } else {
      for (const id of serverAllow.keys()) {
        const config = this.options.mcpServerConfigs?.[id];
        if (config && id !== "atlas-platform") {
          effectiveConfigs[id] = config;
        }
      }
    }

    // Do not lift MCP results before the producer LLM sees them. Oversized
    // result lifting happens when side-channel tool results are persisted,
    // via `liftToolResultsForPersist`; the pre-persist scrubber retains its
    // defense-in-depth role.
    let mcpResult: MCPToolsResult;
    try {
      mcpResult = await createMCPTools(effectiveConfigs, logger, {
        signal: signalContext?.abortSignal,
        envOverlay: this.options.getEnvOverlay?.(),
      });
    } catch (error) {
      if (hasUnusableCredentialCause(error)) {
        let provider = "unknown";
        if (
          error instanceof LinkCredentialNotFoundError ||
          error instanceof LinkCredentialExpiredError
        ) {
          provider = error.serverName ?? "unknown";
        } else if (error instanceof NoDefaultCredentialError) {
          provider = error.provider;
        }
        throw UserConfigurationError.credentialRefreshFailed(this._definition.id, provider, error);
      }
      throw error;
    }
    dispose = mcpResult.dispose;

    // Filter: platform tools must be in allowlist, non-platform tools pass through.
    // Allowlisted platform tools get workspaceId auto-injected from engine scope
    // so workspace.yml never needs to reference workspace identity.
    const filtered: Record<string, Tool> = {};
    for (const [name, mcpTool] of Object.entries(mcpResult.tools)) {
      if (!PLATFORM_TOOL_NAMES.has(name) || PLATFORM_TOOL_ALLOWLIST.has(name)) {
        filtered[name] = mcpTool;
      }
    }

    // Per-agent tools whitelist, applied per-server using the attribution
    // index from createMCPTools. A server mapped to "all" passes every tool
    // through; a server mapped to a Set keeps only those names; bare tool
    // names are matched globally regardless of source server. Without this,
    // an agent declaring `tools: [google-calendar/list_calendars]` would
    // still see every other server's tools (e.g. `send_gmail_message`) —
    // the source of the daily-memo "fetcher agents send their own emails"
    // bug.
    //
    // Bypass — when the resolved permissions for this action declare
    // `dangerouslySkipAllowlist`, skip the per-agent narrowing
    // and pass every platform-allowlisted tool through to the LLM.
    // Mirrors Claude Code's `--dangerously-skip-permissions`. Resolution
    // precedence: job > workspace > FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS
    // env var. resolvePermissions is the canonical merge helper.
    // Falls through to wrapPlatformToolsWithScope below so request_tool_access
    // and other scope-injected tools still receive sessionId/actionId/perms.
    const effectivePermissions = resolvePermissions({
      job: this.options.jobPermissions,
      workspace: this.options.workspacePermissions,
      daemonDangerouslySkipAllowlist:
        typeof Deno !== "undefined"
          ? Deno.env.get("FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS") === "1"
          : undefined,
    });
    const bypassActive = effectivePermissions.dangerouslySkipAllowlist === true;
    if (bypassActive) {
      logger.info("Bypassing per-agent tool allowlist (dangerouslySkipAllowlist)", {
        jobName: this._definition.id,
        toolCount: Object.keys(filtered).length,
      });
    }

    let scoped: Record<string, Tool> = filtered;
    if (hasNameAllowlist && !bypassActive) {
      scoped = {};
      for (const [serverId, names] of Object.entries(mcpResult.toolsByServer)) {
        if (serverId === "atlas-platform") {
          // Platform tools were already filtered above by PLATFORM_TOOL_ALLOWLIST.
          // Don't re-filter here — they're ambient, not subject to the agent's
          // workspace MCP whitelist.
          for (const name of names) {
            if (filtered[name]) scoped[name] = filtered[name];
          }
          continue;
        }
        const allow = serverAllow.get(serverId);
        for (const name of names) {
          if (!filtered[name]) continue; // dropped by platform-allowlist filter
          if (allow === "all") {
            scoped[name] = filtered[name];
          } else if (allow instanceof Set && allow.has(name)) {
            scoped[name] = filtered[name];
          } else if (bareToolNames.has(name)) {
            scoped[name] = filtered[name];
          }
        }
      }
    }

    const wrapped = wrapPlatformToolsWithScope(scoped, {
      workspaceId: this.options.scope.workspaceId,
      workspaceName: this.options.scope.workspaceName,
      // sessionId + actionId + permissions flow into `request_tool_access`
      // (and any future scope-injected tool that
      // needs them). Other wrapped tools strip extras via Zod input
      // validation, so this is harmless surface widening.
      //
      // Pass `resolvedPermissions` (computed once above for the bypass check)
      // so the tool consumes the same merge result
      // instead of re-resolving at call time. Raw fields kept for
      // back-compat with callers that don't have a resolution context.
      ...(this.options.scope.sessionId && { sessionId: this.options.scope.sessionId }),
      ...(actionId && { actionId }),
      resolvedPermissions: effectivePermissions,
      ...(this.options.jobPermissions && { jobPermissions: this.options.jobPermissions }),
      ...(this.options.workspacePermissions && {
        workspacePermissions: this.options.workspacePermissions,
      }),
      // Surface job timeout when known so request_tool_access can derive
      // expiresAt = now + jobTimeoutMs. Optional — falls back to tool-local
      // default when absent.
      ...(this.options.jobTimeoutMs !== undefined && { jobTimeoutMs: this.options.jobTimeoutMs }),
      availableToolNames: Object.keys(filtered),
    });
    Object.assign(tools, wrapped);

    return { tools, dispose };
  }

  private validateDocumentData(type: string, data: Record<string, unknown>, id: string): void {
    // Skip validation for system-managed document types
    const systemDocumentTypes = ["AgentResult", "LLMResult"];
    if (systemDocumentTypes.includes(type)) {
      logger.debug("Skipping validation for system document type", { type, id });
      return;
    }

    const schema = this._compiledSchemas.get(type);

    if (!schema) {
      // No schema defined - check if document types are defined at all
      if (this._definition.documentTypes) {
        const availableTypes = Object.keys(this._definition.documentTypes).join(", ");
        throw new Error(
          `Document "${id}" has type "${type}" which is not defined in documentTypes. ` +
            `Available types: ${availableTypes || "none"}`,
        );
      }
      // No document types defined at all - allow any data (backwards compatibility)
      return;
    }

    // Validate against schema
    try {
      schema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const formattedErrors = error.issues
          .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
          .join("\n");
        throw new Error(
          `Document "${id}" of type "${type}" failed validation:\n${formattedErrors}`,
        );
      }
      throw error;
    }
  }

  /**
   * Create createDoc function for context
   * Allows FSM actions to dynamically create documents
   */
  private makeCreateDocFn(
    documents: Map<string, Document> = this._documents,
    currentState: string = this._currentState,
  ): (doc: Document) => void {
    return (doc: Document) => {
      if (documents.has(doc.id)) {
        throw new Error(
          `Cannot create document "${doc.id}" - document already exists. ` +
            `Use updateDoc() to modify existing documents.`,
        );
      }

      // Validate against schema
      this.validateDocumentData(doc.type, doc.data, doc.id);

      // Add to documents Map
      documents.set(doc.id, doc);

      logger.debug("Document created dynamically", {
        documentId: doc.id,
        documentType: doc.type,
        state: currentState,
      });
    };
  }

  /**
   * Create updateDoc function for context
   */
  private makeUpdateDocFn(
    documents: Map<string, Document> = this._documents,
  ): (id: string, data: Record<string, unknown>) => void {
    return (id: string, data: Record<string, unknown>) => {
      const existing = documents.get(id);
      if (existing) {
        // Merge and validate updated data
        const merged = { ...existing.data, ...data };
        this.validateDocumentData(existing.type, merged, id);
        existing.data = merged;
      } else {
        throw new Error(
          `Cannot update document "${id}" - document does not exist. ` +
            `Create the document in the state's documents array first, or use createDoc().`,
        );
      }
    };
  }

  /**
   * Create deleteDoc function for context
   * Allows FSM actions to selectively remove documents
   * Idempotent - no-op if document doesn't exist
   */
  private makeDeleteDocFn(
    documents: Map<string, Document> = this._documents,
    currentState: string = this._currentState,
  ): (id: string) => void {
    return (id: string) => {
      const existed = documents.has(id);
      if (existed) {
        documents.delete(id);
        logger.debug("Document deleted", { documentId: id, state: currentState });
      }
    };
  }

  private async persistExecutionState(): Promise<void> {
    const result = await this.options.documentStore.saveState(
      this.options.scope,
      this.definition.id,
      { state: this._currentState },
      FSMStateSchema,
    );
    if (!result.ok) {
      throw new Error(`Failed to persist FSM state: ${result.error}`);
    }
  }

  private async persistDocuments(): Promise<void> {
    for (const doc of this._documents.values()) {
      const result = await this.options.documentStore.write(
        this.options.scope,
        this._definition.id,
        doc.id,
        { type: doc.type, data: doc.data },
        FSMDocumentDataSchema,
      );
      if (!result.ok) {
        throw new Error(`Failed to persist document ${doc.id}: ${result.error}`);
      }
    }

    // Delete stale documents that are no longer in memory
    const storedIds = await this.options.documentStore.list(
      this.options.scope,
      this._definition.id,
    );
    for (const id of storedIds) {
      if (!this._documents.has(id)) {
        const deleted = await this.options.documentStore.delete(
          this.options.scope,
          this._definition.id,
          id,
        );
        if (!deleted) {
          logger.warn(`Failed to delete stale document ${id} from storage`);
        }
      }
    }
  }

  /** The immutable FSM graph definition this engine was constructed with. */
  get definition(): FSMDefinition {
    return this._definition;
  }

  get state(): string {
    return this._currentState;
  }

  get documents(): Document[] {
    return Array.from(this._documents.values());
  }

  get results(): Record<string, Record<string, unknown>> {
    return this.materializeResults(this._documents);
  }

  getDocument(id: string): Document | undefined {
    return this._documents.get(id);
  }

  get context(): Context {
    return {
      documents: this.documents,
      state: this._currentState,
      results: this.materializeResults(this._documents),
      setResult: (key: string, data: Record<string, unknown>) => {
        if (this._documents.has(key)) {
          this._documents.set(key, { ...this._documents.get(key)!, data });
        } else {
          this._results.set(key, data);
        }
      },
      emit: (s: Signal) => this.signal(s),
      updateDoc: this.makeUpdateDocFn(),
      createDoc: this.makeCreateDocFn(),
      deleteDoc: this.makeDeleteDocFn(),
    };
  }

  get emittedEvents(): EmittedEvent[] {
    return [...this._emittedEvents];
  }

  toYAML(): string {
    return serializer.toYAML(this.definition);
  }

  stop(): void {}

  /**
   * Reset FSM to initial state without re-initialization
   * Clears all runtime state (signals, events) and returns to initial state
   * Re-runs idle state entry actions to allow selective document cleanup
   * Used when workspace needs to start fresh for trigger signals
   */
  /**
   * Pre-populate results entries before any signal processing.
   * Used by WorkspaceRuntime to inject `__meta` (and potentially other
   * seed data) so actions see it via `context.results`.
   *
   * Merges entries — safe to call between sessions (when not actively
   * processing). Throws if called mid-session to prevent mutation while
   * the signal queue is draining.
   */
  seedResults(results: Record<string, Record<string, unknown>>): void {
    if (this._processing) {
      throw new Error(
        "seedResults() cannot be called while a signal is being processed. " +
          "Seed data must be injected before or between engine.signal() calls.",
      );
    }
    for (const [key, value] of Object.entries(results)) {
      this._results.set(key, value);
    }
  }

  async reset(): Promise<void> {
    this._currentState = this._definition.initial;
    this._results.clear();
    this._documents.clear();
    this._signalQueue = [];
    this._emittedEvents = [];
    this._recursionDepth = 0;
    this._processedSignalsCount = 0;
    this._processing = false;

    // Re-run idle entry actions (like initialize() does)
    const initialState = this._definition.states[this._currentState];
    if (initialState?.entry) {
      logger.debug("Executing entry actions for reset state", {
        state: this._currentState,
        actionCount: initialState.entry.length,
      });

      await this.executeActions(
        initialState.entry,
        { type: "__reset__" },
        this._documents,
        this._emittedEvents,
        this._signalQueue,
        this._currentState,
      );
    }

    // Always persist after reset — clears stale documents from storage
    // even when initial state has no entry actions
    await this.persistDocuments();

    logger.debug("FSM reset to initial state", {
      fsmId: this._definition.id,
      initialState: this._currentState,
    });
  }
}

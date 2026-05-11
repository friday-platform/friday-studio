/**
 * Agent execution helpers extracted from SessionSupervisor
 * Used by WorkspaceRuntime to integrate FSM agent actions with AgentOrchestrator
 */

import type { AgentResult, AtlasAgentConfig } from "@atlas/agent-sdk";
import type { LLMAgentConfig, SystemAgentConfig, WorkspaceAgentConfig } from "@atlas/config";
import type { ArtifactStorageAdapter } from "@atlas/core/artifacts";
import type { AgentAction, Context, JSONSchema, Signal } from "@atlas/fsm-engine";
import { expandArtifactRefsInDocuments, interpolatePromptPlaceholders } from "@atlas/fsm-engine";
import {
  buildTemporalFacts,
  type DatetimeContext,
  type PlatformModels,
  type ProvenanceSource,
  wrapRetrieved,
} from "@atlas/llm";
import { logger } from "@atlas/logger";

/**
 * Type guard for LLM agent config
 */
function isLLMAgent(agent: WorkspaceAgentConfig): agent is LLMAgentConfig {
  return agent.type === "llm";
}

/**
 * Type guard for System agent config
 */
function isSystemAgent(agent: WorkspaceAgentConfig): agent is SystemAgentConfig {
  return agent.type === "system";
}

/**
 * Type guard for Atlas agent config
 */
function isAtlasAgent(agent: WorkspaceAgentConfig): agent is AtlasAgentConfig {
  return agent.type === "atlas";
}

/**
 * Extract agent-specific config from workspace agent config.
 *
 * @internal Exported for testing
 */
export function extractAgentConfig(
  agentConfig: WorkspaceAgentConfig | undefined,
): Record<string, unknown> | undefined {
  if (!agentConfig) return undefined;
  if (isAtlasAgent(agentConfig)) {
    return agentConfig.config;
  }
  return undefined;
}

/**
 * Extract agent prompt from config based on agent type.
 *
 * @internal Exported for testing
 */
export function extractAgentConfigPrompt(agentConfig: WorkspaceAgentConfig | undefined): string {
  if (!agentConfig) return "";

  if (isLLMAgent(agentConfig)) {
    // LLMAgentConfig.config.prompt is required in schema
    return agentConfig.config.prompt;
  }
  if (isAtlasAgent(agentConfig)) {
    // AtlasAgentConfig.prompt is required in schema
    return agentConfig.prompt;
  }
  if (isSystemAgent(agentConfig) && agentConfig.config?.prompt) {
    // SystemAgentConfig.config is optional, and config.prompt is optional
    return agentConfig.config.prompt;
  }
  return "";
}

/**
 * Build the final prompt for an agent.
 *
 * The agent config prompt is treated as a system-style prompt for the agent
 * (e.g. "always use a neon green background") and is concatenated before the
 * action prompt (the per-step task). This matches how `type: llm` workspace
 * agents are expanded in `packages/config/src/expand-agent-actions.ts`, where
 * `${config.prompt}\n\n${action.prompt}` is built up.
 *
 * @param actionPrompt - Prompt from the FSM AgentAction (per-step task)
 * @param agentConfigPrompt - Prompt from workspace.yml agent config (agent-wide)
 * @param documentContext - Built context from FSM documents and signal data
 * @returns Final prompt to send to the agent
 *
 * @internal Exported for testing
 */
export function buildFinalAgentPrompt(
  actionPrompt: string | undefined,
  agentConfigPrompt: string,
  documentContext: string,
): string {
  const taskPrompt = [agentConfigPrompt, actionPrompt].filter(Boolean).join("\n\n");
  return taskPrompt ? `${taskPrompt}\n\n${documentContext}` : documentContext;
}

export interface BuildAgentPromptOptions {
  /**
   * Trust tier for the signal payload, derived by the caller from the
   * workspace's signal config (see `provenanceForSignalProvider`). HTTP
   * webhook payloads carry caller-controlled bytes — wrap them as
   * `external` so the model's `<retrieved_content_hygiene>` rule fires
   * and treats them as data, not commands. Defaults to `"external"` —
   * the safest choice when the caller doesn't know the provider type.
   */
  signalProvenance?: ProvenanceSource;
  /** Stable identifier for the signal (defaults to `signal.type`). */
  signalOrigin?: string;
  /** Stable identifier for the prepare-result origin. */
  inputOrigin?: string;
}

/**
 * End-to-end agent prompt composition. Pulls the agent's workspace-config
 * prompt, interpolates `{{...}}` placeholders against the prepare result on
 * both the config and action prompts, and concatenates them with the document
 * context via {@link buildFinalAgentPrompt}.
 *
 * Exists as a single helper so the prompt assembled by `WorkspaceRuntime.executeAgent`
 * can be tested directly — and so a regression that re-routes the call site
 * around `buildFinalAgentPrompt` (dropping the agent config prompt) is caught
 * by a unit test, not only by an end-to-end run.
 *
 * @internal Exported for testing
 */
export function composeAgentPrompt(
  action: Pick<AgentAction, "prompt">,
  agentConfig: WorkspaceAgentConfig | undefined,
  prepareResult: Context["input"],
  documentContext: string,
): string {
  const agentConfigPrompt = extractAgentConfigPrompt(agentConfig);
  const interpolatedActionPrompt = action.prompt
    ? interpolatePromptPlaceholders(action.prompt, prepareResult)
    : action.prompt;
  const interpolatedConfigPrompt = interpolatePromptPlaceholders(agentConfigPrompt, prepareResult);
  return buildFinalAgentPrompt(interpolatedActionPrompt, interpolatedConfigPrompt, documentContext);
}

/**
 * Build agent prompt with context (extracted from SessionSupervisor lines 1347-1446)
 *
 * Includes:
 * - Signal data from FSM context
 * - FSM documents (business context) with expanded artifact content
 * - Previous agent outputs (from other documents)
 * - Task description
 *
 * Each section that carries values originating outside the workspace's
 * trusted code path (signal payload, document data, prepare-result Input)
 * is wrapped in a `<retrieved_content provenance="..." origin="..."
 * fetched_at="...">` envelope. The model's `<retrieved_content_hygiene>`
 * rule (in workspace-chat `prompt.txt`) treats anything inside these tags
 * as data, never as instructions — so a webhook payload that says "ignore
 * previous instructions" is data, not a command. Documents and prepare
 * results default to `user-authored` (workspace developer / FSM author
 * controls them); signal data defaults to whatever provenance the caller
 * computes from the signal's provider.
 */
export async function buildAgentPrompt(
  _agentId: string,
  fsmContext: Context,
  signal: Signal,
  abortSignal?: AbortSignal,
  _workspaceId?: string,
  _artifactStorage?: ArtifactStorageAdapter,
  options: BuildAgentPromptOptions = {},
): Promise<string> {
  const signalContext = signal.data;
  const signalDatetime = signal.data?.datetime as DatetimeContext | undefined;

  // Expand artifact refs to include actual content for downstream agents
  const documents = await expandArtifactRefsInDocuments(fsmContext.documents, abortSignal);

  const sections: string[] = [];

  // Add facts section (current date/time/etc) — temporal facts are
  // system-derived; no envelope wrapping.
  sections.push(buildTemporalFacts(signalDatetime));

  // Documents are workspace-authored business state. Tag as
  // user-authored so the model can distinguish data from instructions
  // even though the trust level is high.
  if (documents.length > 0) {
    const body = documents
      .map((d) => {
        return `### Document: ${d.id} (type: ${d.type})\n\`\`\`json\n${JSON.stringify(
          d.data,
          null,
          2,
        )}\n\`\`\``;
      })
      .join("\n\n");
    sections.push(
      wrapRetrieved({
        source: "user-authored",
        origin: "fsm:documents",
        body: `## Available Documents\n\n${body}`,
      }),
    );
  }

  // Prepare-result Input — emitted by a workspace-authored `prepare`
  // function; tagged user-authored. If a prepare function pulls in
  // signal payload bytes, those bytes inherit this envelope; the
  // workspace author is responsible for not splicing untrusted
  // values into the action prompt template directly.
  if (fsmContext.input) {
    sections.push(
      wrapRetrieved({
        source: "user-authored",
        origin: options.inputOrigin ?? "fsm:input",
        body: `## Input\n\n\`\`\`json\n${JSON.stringify(fsmContext.input, null, 2)}\n\`\`\``,
      }),
    );
  }

  // Signal data is the load-bearing trust boundary — provenance is
  // dictated by the signal's provider (caller passes
  // `signalProvenance` from `provenanceForSignalProvider(provider)`).
  // Default to `external` when unknown — safer than silently
  // inheriting `system-config`.
  if (signalContext && Object.keys(signalContext).length > 0) {
    sections.push(
      wrapRetrieved({
        source: options.signalProvenance ?? "external",
        origin: options.signalOrigin ?? `signal:${signal.type}`,
        body: `## Signal Data\n\n\`\`\`json\n${JSON.stringify(signalContext, null, 2)}\n\`\`\``,
      }),
    );
  }

  return sections.join("\n\n");
}

/**
 * Validate agent output after execution.
 *
 * Model-backed validation runs through the FSM engine's `runJudge` callback,
 * gated by the resolved `validate:` decision. This helper keeps only local
 * envelope/schema/document-reference checks before data enters FSM context.
 */
export function validateAgentOutput(
  result: AgentResult,
  context: Context,
  _agentType: "llm" | "system" | "sdk",
  _platformModels?: PlatformModels,
  expectedSchema?: JSONSchema,
): Promise<void> {
  return Promise.resolve().then(() => validateAgentOutputSync(result, context, expectedSchema));
}

function validateAgentOutputSync(
  result: AgentResult,
  context: Context,
  expectedSchema?: JSONSchema,
): void {
  // Skip validation for error results
  if (!result.ok) {
    logger.warn("Agent returned error, skipping validation", {
      agentId: result.agentId,
      error: result.error.reason,
    });
    return;
  }

  if (result.data === "") {
    logger.error("Agent output is empty!", { agentId: result.agentId });
    throw new Error(`Agent ${result.agentId} produced empty output`);
  }

  // Skip validation if no data
  if (!result.data) {
    logger.warn("Agent produced no output", { agentId: result.agentId });
    return;
  }

  // Validate against schema if provided
  if (expectedSchema && result.data) {
    const validation = validateJSONSchema(result.data, expectedSchema);
    if (!validation.valid) {
      throw new Error(
        `Agent ${result.agentId} output failed schema validation: ${validation.errors.join(", ")}`,
      );
    }
  }

  // Check for hallucinations (agent referencing non-existent documents)
  const referencedDocIds = extractDocumentReferences(result.data);
  const existingDocIds = new Set(context.documents.map((d) => d.id));

  const hallucinations = referencedDocIds.filter((id) => !existingDocIds.has(id));
  if (hallucinations.length > 0) {
    throw new Error(
      `Agent ${result.agentId} hallucinated document references: ${hallucinations.join(", ")}. ` +
        `Available documents: ${Array.from(existingDocIds).join(", ")}`,
    );
  }
}

/**
 * Extract document IDs referenced in agent output
 * Looks for patterns like "docId": "..." in JSON structures
 */
function extractDocumentReferences(data: unknown): string[] {
  const refs: string[] = [];

  // Convert to string for pattern matching
  const json = JSON.stringify(data);

  // Look for common document reference patterns
  const patterns = [
    /"docId":\s*"([^"]+)"/g,
    /"documentId":\s*"([^"]+)"/g,
    /"doc_id":\s*"([^"]+)"/g,
    /"document":\s*"([^"]+)"/g,
  ];

  for (const pattern of patterns) {
    const matches = json.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        refs.push(match[1]);
      }
    }
  }

  return Array.from(new Set(refs)); // Deduplicate
}

/**
 * Validate data against JSON Schema
 * Simplified implementation - full version should use Zod or AJV
 */
function validateJSONSchema(
  data: unknown,
  schema: JSONSchema,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Basic type validation
  if (schema.type) {
    const dataType = Array.isArray(data) ? "array" : data === null ? "null" : typeof data;

    if (dataType !== schema.type) {
      errors.push(`Expected type ${schema.type}, got ${dataType}`);
      return { valid: false, errors };
    }
  }

  // Object property validation
  if (schema.type === "object" && typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;

    // Check required properties
    if (schema.required) {
      for (const requiredProp of schema.required) {
        if (!(requiredProp in obj)) {
          errors.push(`Missing required property: ${requiredProp}`);
        }
      }
    }

    // Validate properties against schemas
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          const propValidation = validateJSONSchema(obj[key], propSchema as JSONSchema);
          if (!propValidation.valid) {
            errors.push(`Property ${key}: ${propValidation.errors.join(", ")}`);
          }
        }
      }
    }
  }

  // Array validation
  if (schema.type === "array" && Array.isArray(data)) {
    if (schema.items) {
      for (let i = 0; i < data.length; i++) {
        const itemValidation = validateJSONSchema(data[i], schema.items as JSONSchema);
        if (!itemValidation.valid) {
          errors.push(`Array item ${i}: ${itemValidation.errors.join(", ")}`);
        }
      }
    }
  }

  // String validation
  if (schema.type === "string" && typeof data === "string") {
    if (schema.minLength && data.length < schema.minLength) {
      errors.push(`String length ${data.length} is less than minimum ${schema.minLength}`);
    }
    if (schema.maxLength && data.length > schema.maxLength) {
      errors.push(`String length ${data.length} exceeds maximum ${schema.maxLength}`);
    }
    if (schema.pattern) {
      const regex = new RegExp(schema.pattern);
      if (!regex.test(data)) {
        errors.push(`String does not match pattern: ${schema.pattern}`);
      }
    }
  }

  // Number validation
  if (schema.type === "number" && typeof data === "number") {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push(`Number ${data} is less than minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push(`Number ${data} exceeds maximum ${schema.maximum}`);
    }
  }

  // Enum validation
  if (schema.enum) {
    if (!schema.enum.includes(data)) {
      errors.push(`Value ${JSON.stringify(data)} is not in allowed enum values`);
    }
  }

  return { valid: errors.length === 0, errors };
}

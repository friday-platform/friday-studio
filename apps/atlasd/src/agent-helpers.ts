/**
 * Agent execution helpers extracted from SessionSupervisor
 * Used by WorkspaceRuntime to integrate FSM agent actions with AgentOrchestrator
 */

import type { AgentResult, AtlasAgentConfig } from "@atlas/agent-sdk";
import type { LLMAgentConfig, SystemAgentConfig, WorkspaceAgentConfig } from "@atlas/config";
import type { ArtifactStorageAdapter } from "@atlas/core/artifacts";
import type { Context, JSONSchema, Signal } from "@atlas/fsm-engine";
import { expandArtifactRefsInDocuments } from "@atlas/fsm-engine";
import {
  type HallucinationDetectorConfig,
  SupervisionLevel,
  ValidationFailedError,
  validate as validateOutput,
} from "@atlas/hallucination";
import { buildTemporalFacts, type DatetimeContext, type PlatformModels } from "@atlas/llm";
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
 * Build the final prompt for an agent with correct precedence.
 *
 * Prompt precedence: action.prompt > agentConfig.prompt > context only
 *
 * @param actionPrompt - Prompt from the FSM AgentAction (highest priority)
 * @param agentConfigPrompt - Prompt from workspace.yml agent config (fallback)
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
  // Prompt precedence: action.prompt > agentConfig.prompt > context only
  const taskPrompt = actionPrompt || agentConfigPrompt;
  return taskPrompt ? `${taskPrompt}\n\n${documentContext}` : documentContext;
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
 * NOTE: Working memory integration would go here if needed, but for the initial
 * FSM integration, we're keeping this minimal.
 */
export async function buildAgentPrompt(
  _agentId: string,
  fsmContext: Context,
  signal: Signal,
  abortSignal?: AbortSignal,
  _workspaceId?: string,
  _artifactStorage?: ArtifactStorageAdapter,
): Promise<string> {
  const signalContext = signal.data;
  const signalDatetime = signal.data?.datetime as DatetimeContext | undefined;

  // Expand artifact refs to include actual content for downstream agents
  const documents = await expandArtifactRefsInDocuments(fsmContext.documents, abortSignal);

  const sections: string[] = [];

  // Add facts section (current date/time/etc)
  sections.push(buildTemporalFacts(signalDatetime));

  // Format documents for prompt - these are the FSM's business domain documents
  if (documents.length > 0) {
    const documentsSection = documents
      .map((d) => {
        return `### Document: ${d.id} (type: ${d.type})\n\`\`\`json\n${JSON.stringify(
          d.data,
          null,
          2,
        )}\n\`\`\``;
      })
      .join("\n\n");

    sections.push(`## Available Documents\n\n${documentsSection}`);
  }

  // Include prepare result (task + config from code action) so agents
  // receive computed values from prepare functions, matching LLM action behavior
  if (fsmContext.input) {
    sections.push(`## Input\n\n\`\`\`json\n${JSON.stringify(fsmContext.input, null, 2)}\n\`\`\``);
  }

  // Include signal data
  if (signalContext && Object.keys(signalContext).length > 0) {
    sections.push(
      `## Signal Data\n\n\`\`\`json\n${JSON.stringify(signalContext, null, 2)}\n\`\`\``,
    );
  }

  return sections.join("\n\n");
}

/**
 * Validate agent output (extracted from SessionSupervisor lines 1825-1938)
 *
 * Checks:
 * - Hallucination detection (referencing non-existent data) - ONLY for LLM agents
 * - Schema validation if expected schema provided
 * - Output format validation
 *
 * Throws on invalid output (FSM will abort transition)
 */
export async function validateAgentOutput(
  result: AgentResult,
  context: Context,
  agentType: "llm" | "system" | "sdk",
  platformModels?: PlatformModels,
  expectedSchema?: JSONSchema,
  supervisionLevel: SupervisionLevel = SupervisionLevel.STANDARD,
): Promise<void> {
  // Skip validation for error results
  if (!result.ok) {
    logger.warn("Agent returned error, skipping validation", {
      agentId: result.agentId,
      error: result.error.reason,
    });
    return;
  }

  // Skip validation if no data
  if (!result.data) {
    logger.warn("Agent produced no output", { agentId: result.agentId });
    return;
  }

  if (result.data === "") {
    logger.error("Agent output is empty!", { agentId: result.agentId });
    throw new Error(`Agent ${result.agentId} produced empty output`);
  }

  // Only run hallucination detection for ad-hoc LLM agents
  // System agents and SDK agents are code-based and should not be checked
  if (agentType === "llm" && platformModels) {
    const hallucinationDetectorConfig: HallucinationDetectorConfig = {
      platformModels,
      logger: logger.child({ component: "hallucination-detector" }),
    };

    const verdict = await validateOutput(result, supervisionLevel, hallucinationDetectorConfig);

    logger.info("Agent output validation", {
      agentId: result.agentId,
      status: verdict.status,
      confidence: verdict.confidence,
      threshold: verdict.threshold,
      issuesCount: verdict.issues.length,
      issues: verdict.issues,
    });

    if (verdict.status === "fail") {
      logger.error("Agent output failed validation", {
        agentId: result.agentId,
        confidence: verdict.confidence,
        retryGuidance: verdict.retryGuidance,
        issues: verdict.issues,
      });
      throw new ValidationFailedError(verdict, result.agentId);
    }
  } else if (agentType === "llm") {
    logger.debug("Skipping hallucination detection — no platformModels injected", {
      agentId: result.agentId,
    });
  } else {
    logger.debug("Skipping hallucination detection for non-LLM agent", {
      agentId: result.agentId,
      agentType,
    });
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

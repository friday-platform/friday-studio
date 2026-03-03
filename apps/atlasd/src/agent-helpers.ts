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
  analyzeResults as analyzeHallucinations,
  containsSeverePatterns,
  getSevereIssues,
  type HallucinationAnalysis,
  type HallucinationDetectorConfig,
  SupervisionLevel,
} from "@atlas/hallucination";
import type { ResourceStorageAdapter } from "@atlas/ledger";
import { buildTemporalFacts, type DatetimeContext } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { buildResourceGuidance, enrichCatalogEntries, toCatalogEntries } from "@atlas/resources";

function isLLMAgent(agent: WorkspaceAgentConfig): agent is LLMAgentConfig {
  return agent.type === "llm";
}

function isSystemAgent(agent: WorkspaceAgentConfig): agent is SystemAgentConfig {
  return agent.type === "system";
}

function isAtlasAgent(agent: WorkspaceAgentConfig): agent is AtlasAgentConfig {
  return agent.type === "atlas";
}

/** @internal Exported for testing. */
export function extractAgentConfig(
  agentConfig: WorkspaceAgentConfig | undefined,
): Record<string, unknown> | undefined {
  if (!agentConfig) return undefined;
  if (isAtlasAgent(agentConfig)) {
    return agentConfig.config;
  }
  return undefined;
}

/** @internal Exported for testing. */
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
 * Prompt precedence: action.prompt > agentConfig.prompt > context only.
 * @internal Exported for testing.
 */
export function buildFinalAgentPrompt(
  actionPrompt: string | undefined,
  agentConfigPrompt: string,
  documentContext: string,
): string {
  const taskPrompt = actionPrompt || agentConfigPrompt;
  return taskPrompt ? `${taskPrompt}\n\n${documentContext}` : documentContext;
}

/** Builds the context prompt from signal data, FSM documents, and workspace resources. */
export async function buildAgentPrompt(
  _agentId: string,
  fsmContext: Context,
  signal: Signal,
  abortSignal?: AbortSignal,
  resourceAdapter?: ResourceStorageAdapter,
  workspaceId?: string,
  artifactStorage?: ArtifactStorageAdapter,
): Promise<string> {
  const signalContext = signal.data;
  const signalDatetime = signal.data?.datetime as DatetimeContext | undefined;

  const documents = await expandArtifactRefsInDocuments(fsmContext.documents, abortSignal);

  const sections: string[] = [];

  sections.push(buildTemporalFacts(signalDatetime));

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

  if (signalContext && Object.keys(signalContext).length > 0) {
    sections.push(
      `## Signal Data\n\n\`\`\`json\n${JSON.stringify(signalContext, null, 2)}\n\`\`\``,
    );
  }

  if (resourceAdapter && workspaceId) {
    try {
      const metadata = await resourceAdapter.listResources(workspaceId);
      if (metadata.length > 0) {
        const catalogEntries = await toCatalogEntries(metadata, resourceAdapter, workspaceId);
        const entries = artifactStorage
          ? await enrichCatalogEntries(catalogEntries, artifactStorage)
          : catalogEntries.filter((e) => e.type !== "artifact_ref");
        const guidance = buildResourceGuidance(entries);
        if (guidance) {
          sections.push(guidance);
        }
        const hasDocuments = entries.some((e) => e.type === "document");
        if (hasDocuments) {
          const skillText = await resourceAdapter.getSkill();
          sections.push(skillText);
        }
      }
    } catch (err) {
      logger.warn("Failed to fetch workspace resources for prompt", {
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return sections.join("\n\n");
}

/** Validates agent output. Throws on hallucinations, schema violations, or invalid doc refs. */
export async function validateAgentOutput(
  result: AgentResult,
  context: Context,
  agentType: "llm" | "system" | "sdk",
  expectedSchema?: JSONSchema,
  supervisionLevel: SupervisionLevel = SupervisionLevel.STANDARD,
): Promise<void> {
  if (!result.ok) {
    logger.warn("Agent returned error, skipping validation", {
      agentId: result.agentId,
      error: result.error.reason,
    });
    return;
  }

  if (!result.data) {
    logger.warn("Agent produced no output", { agentId: result.agentId });
    return;
  }

  if (result.data === "") {
    logger.error("Agent output is empty!", { agentId: result.agentId });
    throw new Error(`Agent ${result.agentId} produced empty output`);
  }

  // Only LLM agents — system/SDK agents are code-based
  if (agentType === "llm") {
    const hallucinationDetectorConfig: HallucinationDetectorConfig = {
      logger: logger.child({ component: "hallucination-detector" }),
    };

    try {
      const analysis: HallucinationAnalysis = await analyzeHallucinations(
        [result],
        supervisionLevel,
        hallucinationDetectorConfig,
      );

      logger.info("Agent confidence validation", {
        agentId: result.agentId,
        confidence: analysis.averageConfidence,
        issues: analysis.issues,
        issuesCount: analysis.issues.length,
      });

      const isSevere = analysis.averageConfidence < 0.3 || containsSeverePatterns(analysis.issues);

      if (isSevere) {
        const severeIssues = getSevereIssues(analysis.issues);

        logger.error("SEVERE HALLUCINATION DETECTED", {
          agentId: result.agentId,
          confidence: analysis.averageConfidence,
          severeIssues,
          allIssues: analysis.issues,
        });

        throw new Error(
          `Agent ${result.agentId} hallucinated: ${
            severeIssues.length > 0 ? severeIssues.join("; ") : analysis.issues.join("; ")
          }`,
        );
      }
    } catch (error) {
      // If the error is from our validation above, re-throw it
      if (error instanceof Error && error.message.includes("hallucinated")) {
        throw error;
      }

      // Otherwise log and continue (validation system failure shouldn't block execution)
      logger.error("Failed to validate agent result", {
        agentId: result.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    logger.debug("Skipping hallucination detection for non-LLM agent", {
      agentId: result.agentId,
      agentType,
    });
  }

  if (expectedSchema && result.data) {
    const validation = validateJSONSchema(result.data, expectedSchema);
    if (!validation.valid) {
      throw new Error(
        `Agent ${result.agentId} output failed schema validation: ${validation.errors.join(", ")}`,
      );
    }
  }

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

/** Extracts document IDs referenced in agent output via JSON key patterns. */
function extractDocumentReferences(data: unknown): string[] {
  const refs: string[] = [];
  const json = JSON.stringify(data);

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

  return Array.from(new Set(refs));
}

/** Simplified JSON Schema validator — sufficient for output gate checks. */
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

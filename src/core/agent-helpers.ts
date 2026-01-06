/**
 * Agent execution helpers extracted from SessionSupervisor
 * Used by WorkspaceRuntime to integrate FSM agent actions with AgentOrchestrator
 */

import type { AgentResult } from "@atlas/agent-sdk";
import type { Context, JSONSchema, Signal } from "@atlas/fsm-engine";
import { expandArtifactRefsInDocuments } from "@atlas/fsm-engine";
import { logger } from "@atlas/logger";
import {
  analyzeResults as analyzeHallucinations,
  containsSeverePatterns,
  getSevereIssues,
  SupervisionLevel,
  type HallucinationAnalysis,
  type HallucinationDetectorConfig,
} from "@atlas/hallucination";

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
 * FSM integration, we're keeping this minimal. The session supervisor's MECMF
 * integration can be added later if needed.
 */
export async function buildAgentPrompt(
  _agentId: string,
  fsmContext: Context,
  signal: Signal,
  abortSignal?: AbortSignal,
): Promise<string> {
  const signalContext = signal.data;

  // Expand artifact refs to include actual content for downstream agents
  const documents = await expandArtifactRefsInDocuments(fsmContext.documents, abortSignal);

  const sections: string[] = [];

  // Add facts section (current date/time/etc)
  sections.push(buildFactsSection());

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

  // Include signal data
  if (signalContext && Object.keys(signalContext).length > 0) {
    sections.push(
      `## Signal Data\n\n\`\`\`json\n${JSON.stringify(signalContext, null, 2)}\n\`\`\``,
    );
  }

  return sections.join("\n\n");
}

/**
 * Build a facts section with current context information
 * Extracted from SessionSupervisor lines 2040-2077
 */
function buildFactsSection(): string {
  const now = new Date();

  const facts: string[] = [
    `Current Date: ${now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    })}`,
    `Current Time: ${now.toLocaleTimeString("en-US", {
      hour12: true,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    })}`,
    `Timestamp: ${now.toISOString()}`,
  ];

  return `## Context Facts\n${facts.map((fact) => `- ${fact}`).join("\n")}`;
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
  expectedSchema?: JSONSchema,
  supervisionLevel: SupervisionLevel = SupervisionLevel.STANDARD,
  agentType?: "llm" | "system" | "sdk",
): Promise<void> {
  // Skip validation if no output
  if (!result.output) {
    logger.warn("Agent produced no output", { agentId: result.agentId });
    return;
  }

  if (result.output === "") {
    logger.error("Agent output is empty!", { agentId: result.agentId });
    throw new Error(`Agent ${result.agentId} produced empty output`);
  }

  // Only run hallucination detection for ad-hoc LLM agents
  // System agents and SDK agents are code-based and should not be checked
  if (agentType === "llm") {
    const singleAgentResults: AgentResult[] = [result];

    const hallucinationDetectorConfig: HallucinationDetectorConfig = {
      logger: logger.child({ component: "hallucination-detector" }),
    };

    try {
      const analysis: HallucinationAnalysis = await analyzeHallucinations(
        singleAgentResults,
        supervisionLevel,
        hallucinationDetectorConfig,
      );

      logger.info("Agent confidence validation", {
        agentId: result.agentId,
        confidence: analysis.averageConfidence,
        issues: analysis.issues,
        issuesCount: analysis.issues.length,
      });

      // Check for severe hallucinations
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

  // Validate against schema if provided
  if (expectedSchema && result.output) {
    const validation = validateJSONSchema(result.output, expectedSchema);
    if (!validation.valid) {
      throw new Error(
        `Agent ${result.agentId} output failed schema validation: ${validation.errors.join(", ")}`,
      );
    }
  }

  // Check for hallucinations (agent referencing non-existent documents)
  const referencedDocIds = extractDocumentReferences(result.output);
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

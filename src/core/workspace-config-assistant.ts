/**
 * Workspace Configuration Assistant
 *
 * Provides natural language interfaces for workspace configuration,
 * particularly for job definitions and signal conditions.
 */

import { NaturalLanguageConditionParser } from "./conditions/natural-language-parser.ts";
import { logger } from "../utils/logger.ts";
import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

// Schema for job definition from natural language
const JobDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  triggers: z.array(z.object({
    signal: z.string(),
    condition: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
    naturalLanguageCondition: z.string().optional(),
  })),
  execution: z.object({
    strategy: z.enum(["sequential", "parallel", "staged", "conditional"]),
    agents: z.array(z.object({
      id: z.string(),
      role: z.string().optional(),
    })),
  }),
  session_prompts: z.object({
    planning: z.string().optional(),
    execution: z.string().optional(),
  }).optional(),
  resources: z.object({
    estimated_duration_seconds: z.number().optional(),
    cost_limit: z.number().optional(),
  }).optional(),
});

export type JobDefinition = z.infer<typeof JobDefinitionSchema>;

export interface WorkspaceContext {
  workspaceId: string;
  availableSignals: Array<{
    id: string;
    provider: string;
    payloadShape?: object;
    description?: string;
  }>;
  availableAgents: Array<{
    id: string;
    type: string;
    purpose?: string;
    capabilities?: string[];
  }>;
  existingJobs: Array<{
    name: string;
    description?: string;
    triggers: Array<{
      signal: string;
      condition?: string;
    }>;
  }>;
}

export class WorkspaceConfigAssistant {
  private conditionParser: NaturalLanguageConditionParser;
  private anthropic;

  constructor() {
    this.conditionParser = new NaturalLanguageConditionParser();
    this.anthropic = createAnthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    });
  }

  /**
   * Parse natural language job description into structured job definition
   */
  async parseJobDescription(
    description: string,
    context: WorkspaceContext,
  ): Promise<{
    job: JobDefinition;
    conditionsNeedConfirmation: Array<{
      trigger: number;
      confirmationId: string;
      originalCondition: string;
    }>;
  }> {
    logger.info("Parsing natural language job description", {
      workspaceId: context.workspaceId,
      description: description.slice(0, 100),
    });

    // Use AI to parse the job description into structured format
    const systemPrompt =
      `You are an expert at parsing natural language job descriptions into structured Atlas workspace configurations.

Available signals in this workspace:
${
        context.availableSignals.map((s) =>
          `- ${s.id} (${s.provider}): ${s.description || "No description"}`
        ).join("\n")
      }

Available agents in this workspace:
${
        context.availableAgents.map((a) =>
          `- ${a.id} (${a.type}): ${a.purpose || "No purpose specified"}`
        ).join("\n")
      }

Existing jobs for context:
${context.existingJobs.map((j) => `- ${j.name}: ${j.description || "No description"}`).join("\n")}

Parse the natural language description into a complete job definition. Guidelines:

1. **Name**: Create a clear, concise job name (kebab-case)
2. **Triggers**: Identify which signals should trigger this job and any conditions
3. **Agent Selection**: Choose appropriate agents based on the task requirements
4. **Execution Strategy**: 
   - "sequential" for step-by-step processes
   - "parallel" for independent concurrent tasks
   - "staged" for phased execution with dependencies
   - "conditional" for dynamic branching logic
5. **Session Prompts**: Add planning/execution guidance for the agents
6. **Resources**: Estimate duration and cost limits

For trigger conditions, use natural language that can be parsed later:
- "event type is Warning"
- "message contains error and severity is high"
- "kubernetes pod status is Failed"`;

    const userPrompt = `Parse this job description into a structured configuration:

"${description}"

Workspace context: ${context.workspaceId}`;

    try {
      const result = await generateObject({
        model: this.anthropic("claude-3-5-sonnet-20241022"),
        schema: JobDefinitionSchema,
        system: systemPrompt,
        prompt: userPrompt,
        temperature: 0.1,
      });

      const job = result.object;
      const conditionsNeedConfirmation = [];

      // Process natural language conditions
      for (let i = 0; i < job.triggers.length; i++) {
        const trigger = job.triggers[i];
        if (trigger.naturalLanguageCondition) {
          try {
            // Find the signal context for better parsing
            const signal = context.availableSignals.find((s) => s.id === trigger.signal);

            const conditionResult = await this.conditionParser.parseCondition(
              trigger.naturalLanguageCondition,
              {
                workspaceId: context.workspaceId,
                availableVariables: signal
                  ? this.extractVariablesFromPayload(signal.payloadShape)
                  : undefined,
                expectedPayloadShape: signal?.payloadShape,
              },
            );

            if (conditionResult.requiresConfirmation) {
              // Find the confirmation ID (this is a bit hacky, but the parser creates it internally)
              const confirmations = this.conditionParser.getPendingConfirmations(
                context.workspaceId,
              );
              const latestConfirmation = confirmations[confirmations.length - 1];

              conditionsNeedConfirmation.push({
                trigger: i,
                confirmationId: latestConfirmation.id,
                originalCondition: trigger.naturalLanguageCondition,
              });
            } else {
              // Auto-convert to structured condition
              const expression = conditionResult.parsed.expression;
              if (expression.type === "jsonlogic") {
                trigger.condition = JSON.stringify(expression.content);
              } else {
                trigger.condition = expression.content as string;
              }
            }
          } catch (error) {
            logger.warn("Failed to parse trigger condition", {
              trigger: trigger.naturalLanguageCondition,
              error: error instanceof Error ? error.message : String(error),
            });
            // Keep the natural language condition for manual review
          }
        }
      }

      logger.info("Job description parsed successfully", {
        jobName: job.name,
        triggerCount: job.triggers.length,
        agentCount: job.execution.agents.length,
        conditionsNeedingConfirmation: conditionsNeedConfirmation.length,
      });

      return {
        job,
        conditionsNeedConfirmation,
      };
    } catch (error) {
      logger.error("Failed to parse job description", {
        description: description.slice(0, 100),
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to parse job description: ${error}`);
    }
  }

  /**
   * Validate workspace configuration and identify issues
   */
  async validateWorkspaceConfig(config: any, context: WorkspaceContext): Promise<{
    valid: boolean;
    issues: Array<{
      type: "error" | "warning" | "suggestion";
      message: string;
      location?: string;
      suggestedFix?: string;
    }>;
  }> {
    const issues = [];

    // Check job definitions
    if (config.jobs) {
      for (const [jobName, jobConfig] of Object.entries(config.jobs)) {
        const typedJobConfig = jobConfig as any;
        // Validate agent references
        if (typedJobConfig.execution?.agents) {
          for (const agent of typedJobConfig.execution.agents) {
            if (!context.availableAgents.find((a) => a.id === agent.id)) {
              issues.push({
                type: "error" as const,
                message: `Job '${jobName}' references unknown agent '${agent.id}'`,
                location: `jobs.${jobName}.execution.agents`,
                suggestedFix: `Available agents: ${
                  context.availableAgents.map((a) => a.id).join(", ")
                }`,
              });
            }
          }
        }

        // Validate signal references
        if (typedJobConfig.triggers) {
          for (const trigger of typedJobConfig.triggers) {
            if (!context.availableSignals.find((s) => s.id === trigger.signal)) {
              issues.push({
                type: "error" as const,
                message: `Job '${jobName}' references unknown signal '${trigger.signal}'`,
                location: `jobs.${jobName}.triggers`,
                suggestedFix: `Available signals: ${
                  context.availableSignals.map((s) => s.id).join(", ")
                }`,
              });
            }

            // Validate conditions if present
            if (trigger.condition) {
              try {
                await this.conditionParser.parseCondition(trigger.condition, {
                  workspaceId: context.workspaceId,
                });
              } catch (error) {
                issues.push({
                  type: "warning" as const,
                  message: `Job '${jobName}' has invalid condition: ${error}`,
                  location: `jobs.${jobName}.triggers.condition`,
                  suggestedFix: "Use natural language conditions that can be validated",
                });
              }
            }
          }
        }
      }
    }

    // Check for unused signals
    const usedSignals = new Set();
    if (config.jobs) {
      for (const jobConfig of Object.values(config.jobs)) {
        const typedJobConfig = jobConfig as any;
        if (typedJobConfig.triggers) {
          for (const trigger of typedJobConfig.triggers) {
            usedSignals.add(trigger.signal);
          }
        }
      }
    }

    for (const signal of context.availableSignals) {
      if (!usedSignals.has(signal.id)) {
        issues.push({
          type: "suggestion" as const,
          message: `Signal '${signal.id}' is configured but not used by any jobs`,
          location: `signals.${signal.id}`,
          suggestedFix: "Consider creating a job that uses this signal or removing it",
        });
      }
    }

    return {
      valid: !issues.some((issue) => issue.type === "error"),
      issues,
    };
  }

  /**
   * Get pending condition confirmations for workspace
   */
  getPendingConditionConfirmations(workspaceId: string) {
    return this.conditionParser.getPendingConfirmations(workspaceId);
  }

  /**
   * Confirm a condition parsing
   */
  confirmConditionParsing(
    confirmationId: string,
    approved: boolean,
    selectedAlternative?: number,
    feedback?: string,
  ) {
    return this.conditionParser.confirmParsing(
      confirmationId,
      approved,
      selectedAlternative,
      feedback,
    );
  }

  /**
   * Extract variable names from payload shape
   */
  private extractVariablesFromPayload(payloadShape?: object): string[] {
    if (!payloadShape) {
      return ["message", "event", "source", "timestamp", "metadata"];
    }

    const extractKeys = (obj: any, prefix = ""): string[] => {
      const keys: string[] = [];
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        keys.push(fullKey);

        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          keys.push(...extractKeys(value, fullKey));
        }
      }
      return keys;
    };

    return extractKeys(payloadShape);
  }
}

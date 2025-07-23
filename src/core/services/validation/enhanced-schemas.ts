/**
 * Enhanced schemas with validation refinements for better draft validation
 *
 * These schemas extend the base @atlas/config schemas with additional
 * validation constraints that can catch common configuration errors
 * at the schema level rather than in custom validation logic.
 */

import { z } from "zod/v4";
import type { WorkspaceConfig } from "@atlas/config";
import { WorkspaceConfigSchema } from "@atlas/config";

/**
 * Enhanced job specification schema with reference validation
 *
 * Adds refinements to validate that:
 * - Signal references exist in the signals section
 * - Agent references exist in the agents section
 */
export function createEnhancedJobSchema(config: Partial<WorkspaceConfig>) {
  const availableSignals = new Set(Object.keys(config.signals || {}));
  const availableAgents = new Set(Object.keys(config.agents || {}));

  return z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    triggers: z.array(z.object({
      signal: z.string()
        .refine(
          (signalId) => availableSignals.has(signalId),
          (signalId) => ({ message: `Signal '${signalId}' does not exist` }),
        ),
      condition: z.any().optional(),
    })).optional(),
    execution: z.object({
      strategy: z.enum(["sequential", "parallel"]).optional(),
      agents: z.array(
        z.union([
          z.string(),
          z.object({
            id: z.string(),
            context: z.any().optional(),
          }),
        ]),
      ).refine(
        (agents) => {
          for (const agent of agents) {
            const agentId = typeof agent === "string" ? agent : agent.id;
            if (!availableAgents.has(agentId)) {
              return false;
            }
          }
          return true;
        },
        {
          message: "All referenced agents must exist in the agents section",
        },
      ).optional(),
    }).optional(),
  });
}

/**
 * Enhanced workspace configuration schema with cross-validation
 *
 * Performs validation that requires knowledge of multiple sections
 */
export function createEnhancedWorkspaceSchema(_config: Partial<WorkspaceConfig>) {
  return WorkspaceConfigSchema.refine(
    (data) => {
      // Validate agent references in jobs
      if (data.jobs && data.agents) {
        const agentIds = new Set(Object.keys(data.agents));

        for (const job of Object.values(data.jobs)) {
          if (job.execution?.agents) {
            for (const agent of job.execution.agents) {
              const agentId = typeof agent === "string" ? agent : agent.id;
              if (!agentIds.has(agentId)) {
                return false;
              }
            }
          }
        }
      }

      // Validate signal references in jobs
      if (data.jobs && data.signals) {
        const signalIds = new Set(Object.keys(data.signals));

        for (const job of Object.values(data.jobs)) {
          if (job.triggers) {
            for (const trigger of job.triggers) {
              if (!signalIds.has(trigger.signal)) {
                return false;
              }
            }
          }
        }
      }

      return true;
    },
    {
      message: "Invalid references between jobs, agents, and signals",
    },
  );
}

/**
 * Enhanced agent schema with validation for common misconfigurations
 */
export const EnhancedAgentSchema = z.object({
  type: z.enum(["llm", "remote", "system"]),
  description: z.string()
    .min(10, "Agent description should be at least 10 characters")
    .refine(
      (desc) => desc.toLowerCase() !== "todo" && desc.toLowerCase() !== "tbd",
      "Agent description should not be placeholder text",
    ),
  config: z.object({
    model: z.string().optional(),
    provider: z.string().optional(),
    prompt: z.string().optional(),
    tools: z.array(z.string()).optional(),
    endpoint: z.string().url().optional(),
    timeout: z.string().optional(),
  }).optional(),
});

/**
 * Enhanced signal schema with provider-specific validation
 */
export const EnhancedSignalSchema = z.object({
  provider: z.enum(["http", "schedule", "system", "manual"]),
  description: z.string()
    .min(5, "Signal description should be at least 5 characters"),
  config: z.object({
    path: z.string().optional(),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
    timeout: z.string().optional(),
    schedule: z.string().optional(),
    timezone: z.string().optional(),
  }).optional(),
  schema: z.record(z.string(), z.any()).optional(),
}).refine(
  (signal) => {
    // HTTP signals should have a path
    if (signal.provider === "http" && !signal.config?.path) {
      return false;
    }

    // Schedule signals should have a schedule
    if (signal.provider === "schedule" && !signal.config?.schedule) {
      return false;
    }

    return true;
  },
  {
    message: "Signal configuration is incomplete for the specified provider",
  },
);

/**
 * Completeness requirements for different readiness levels
 */
export const CompletenessRequirements = {
  draft: {
    requiredFields: ["workspace.name"],
    minScore: 0,
  },
  review: {
    requiredFields: ["workspace.name", "workspace.description"],
    minScore: 50,
    minAgents: 1,
  },
  ready: {
    requiredFields: ["workspace.name", "workspace.description"],
    minScore: 70,
    minAgents: 1,
    minJobs: 1,
  },
  production: {
    requiredFields: ["workspace.name", "workspace.description"],
    minScore: 90,
    minAgents: 1,
    minJobs: 1,
    minSignals: 1,
  },
};

/**
 * Validates workspace completeness against specific readiness level
 */
export function validateCompletenessLevel(
  config: Partial<WorkspaceConfig>,
  level: keyof typeof CompletenessRequirements,
): { valid: boolean; missing: string[] } {
  const requirements = CompletenessRequirements[level];
  const missing: string[] = [];

  // Check required fields
  for (const field of requirements.requiredFields) {
    const [section, key] = field.split(".");
    const sectionData = config[section as keyof WorkspaceConfig];
    if (!sectionData || !sectionData[key]) {
      missing.push(field);
    }
  }

  // Check minimum component counts
  if (
    requirements.minAgents &&
    (!config.agents || Object.keys(config.agents).length < requirements.minAgents)
  ) {
    missing.push(`at least ${requirements.minAgents} agent(s)`);
  }

  if (
    requirements.minJobs && (!config.jobs || Object.keys(config.jobs).length < requirements.minJobs)
  ) {
    missing.push(`at least ${requirements.minJobs} job(s)`);
  }

  if (
    requirements.minSignals &&
    (!config.signals || Object.keys(config.signals).length < requirements.minSignals)
  ) {
    missing.push(`at least ${requirements.minSignals} signal(s)`);
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Schema validation helper that provides better error messages
 */
export function validateWithEnhancedErrors<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  context: string = "configuration",
): { success: true; data: T } | {
  success: false;
  errors: Array<{ path: string; message: string; code: string }>;
} {
  const result = schema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.issues.map((issue) => ({
    path: issue.path.join(".") || context,
    message: issue.message,
    code: issue.code,
  }));

  return { success: false, errors };
}

/**
 * Quick validation helper for common workspace issues
 */
export function performQuickValidation(config: Partial<WorkspaceConfig>): {
  critical: string[];
  warnings: string[];
  suggestions: string[];
} {
  const critical: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // Critical issues
  if (!config.workspace?.name) {
    critical.push("Workspace name is required");
  }

  if (!config.agents || Object.keys(config.agents).length === 0) {
    critical.push("At least one agent is required");
  }

  if (!config.jobs || Object.keys(config.jobs).length === 0) {
    critical.push("At least one job is required");
  }

  // Warnings
  if (!config.workspace?.description || config.workspace.description.length < 10) {
    warnings.push("Workspace description is missing or too short");
  }

  if (config.agents) {
    for (const [agentId, agent] of Object.entries(config.agents)) {
      if (!agent.description || agent.description.length < 10) {
        warnings.push(`Agent '${agentId}' needs a better description`);
      }
    }
  }

  // Suggestions
  if (!config.signals || Object.keys(config.signals).length === 0) {
    suggestions.push("Consider adding signals to trigger your workflows");
  }

  if (!config.tools || !config.tools.mcp) {
    suggestions.push("Consider adding MCP tools to extend agent capabilities");
  }

  if (!config.memory) {
    suggestions.push("Consider enabling memory for persistent context");
  }

  return { critical, warnings, suggestions };
}

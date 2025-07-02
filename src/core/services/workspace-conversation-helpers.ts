import { WorkspaceDraft } from "./workspace-draft-store.ts";

export function getPatternSuggestions(pattern?: string): string[] {
  switch (pattern) {
    case "pipeline":
      return [
        "What's the first step in your pipeline?",
        "What data source will the pipeline process?",
        "Should the pipeline run on a schedule or be triggered manually?",
      ];

    case "ensemble":
      return [
        "What different analyses should run in parallel?",
        "How should the results be combined?",
        "Do you need a final summary or aggregation step?",
      ];

    case "hierarchy":
      return [
        "What decisions will the supervisor agent make?",
        "How many worker agents do you need?",
        "What tasks will each worker handle?",
      ];

    default:
      return [
        "What's the main goal of this workspace?",
        "What agents do you envision working together?",
        "How should the agents coordinate?",
      ];
  }
}

export function suggestNextSteps(draft: WorkspaceDraft): string[] {
  const suggestions: string[] = [];

  const agentCount = Object.keys(draft.config.agents || {}).length;
  const jobCount = Object.keys(draft.config.jobs || {}).length;
  const hasSignals = Object.keys(draft.config.signals || {}).length > 0;

  if (agentCount === 0) {
    suggestions.push("Add your first agent to the workspace");
  } else if (jobCount === 0) {
    suggestions.push("Create a job to coordinate your agents");
  } else if (!hasSignals) {
    suggestions.push("Set up a trigger for your workspace");
  } else {
    suggestions.push("Add more agents for additional capabilities");
    suggestions.push("Configure tools for your agents");
    suggestions.push("Review and publish your workspace");
  }

  return suggestions;
}

export function generateUpdateMessage(operation: string, config: Record<string, unknown>): string {
  switch (operation) {
    case "add_agent": {
      // Handle both old format (id/purpose) and new format (name/description)
      const agentName = config.id || config.name || "unnamed";
      const agentPurpose = config.purpose || config.description || "unspecified";
      return `Added agent '${agentName}' with purpose: ${agentPurpose}`;
    }

    case "update_agent":
      return `Updated agent '${config.id || config.name}'`;

    case "add_job":
      return `Created job '${config.id || config.name}' to coordinate agents`;

    case "set_trigger":
      return `Configured ${config.provider} trigger for the workspace`;

    case "add_tool":
      return `Added ${config.provider} tool provider`;

    default:
      return `Applied ${operation} to workspace configuration`;
  }
}

export function generateAgentPrompt(behavior: string, purpose: string): string {
  return `You are an agent with the following purpose: ${purpose}

Your behavior:
${behavior}

Focus on your specific role and provide clear, actionable outputs for downstream agents or users.`;
}

// Type-safe operation configs using @atlas/config types
export interface AddAgentConfig {
  id: string;
  type?: "llm" | "tempest" | "remote";
  model?: string;
  purpose: string;
  system_prompt?: string;
  tools?: string[];
}

export interface AddJobConfig {
  id: string;
  description: string;
  execution: {
    strategy: "sequential" | "parallel";
    agents: Array<{
      id: string;
      input_source?: "signal" | "previous" | "combined" | "filesystem_context";
    }>;
  };
  triggers?: Array<{ signal: string }>;
}

export function generateValidationFixSuggestions(
  errors: Array<{
    code?: string;
    path?: string[];
    message?: string;
    expected?: string;
    received?: string;
    keys?: string[];
  }>,
): string[] {
  const suggestions: string[] = [];

  for (const error of errors) {
    const path = error.path?.join(".");

    if (error.code === "invalid_type") {
      suggestions.push(
        `Fix type error at ${path}: expected ${error.expected}, got ${error.received}`,
      );
    } else if (error.code === "unrecognized_keys") {
      suggestions.push(`Remove unrecognized fields: ${error.keys?.join(", ")}`);
    } else if (error.code === "custom" && path?.includes("model")) {
      suggestions.push(`Use a supported model for the provider (check error message for list)`);
    } else if (error.message?.includes("MCP tool names")) {
      suggestions.push(
        `Rename to follow MCP naming rules: start with letter, use only letters/numbers/underscores/hyphens`,
      );
    } else if (error.message?.includes("Remote agents require")) {
      suggestions.push(`Add missing required field: ${error.message}`);
    } else {
      suggestions.push(`${error.message}`);
    }
  }

  return suggestions;
}

export function validateCrossReferences(config: {
  signals?: Record<string, unknown>;
  jobs?: Record<string, {
    triggers?: Array<{ signal: string }>;
    execution?: {
      agents?: Array<string | { id: string }>;
    };
  }>;
  agents?: Record<string, unknown>;
}): string[] {
  const errors: string[] = [];
  const signals = Object.keys(config.signals || {});
  const agents = Object.keys(config.agents || {});

  // Check job triggers reference existing signals
  for (const [jobId, job] of Object.entries(config.jobs || {})) {
    if (job.triggers) {
      for (const trigger of job.triggers) {
        if (trigger.signal && !signals.includes(trigger.signal)) {
          errors.push(
            `Job '${jobId}' references undefined signal '${trigger.signal}'. Available signals: ${
              signals.length > 0 ? signals.join(", ") : "none"
            }`,
          );
        }
      }
    }

    // Check job agents reference existing agents
    if (job.execution?.agents) {
      for (const agent of job.execution.agents) {
        const agentId = typeof agent === "string" ? agent : agent.id;
        if (!agents.includes(agentId)) {
          errors.push(
            `Job '${jobId}' references undefined agent '${agentId}'. Available agents: ${
              agents.length > 0 ? agents.join(", ") : "none"
            }`,
          );
        }
      }
    }
  }

  return errors;
}

import { registry } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { generateText } from "ai";
import {
  generateMCPServers,
  type MCPServerResult,
} from "../../../../system/agents/fsm-workspace-creator/enrichers/mcp-servers.ts";
import type { CatalogAgent } from "./catalog.ts";

// Legacy type (kept for backward compatibility)
export interface TaskPlan {
  steps: Array<{ agentId: string; description: string }>;
}

// Enhanced types for FSM-based execution
export interface EnhancedTaskStep {
  agentId?: string; // for agent steps
  description: string;
  executionType: "agent" | "llm";
  needs: string[]; // e.g., ["slack", "github"]
}

export interface EnhancedTaskPlan {
  steps: EnhancedTaskStep[];
  needs: string[]; // aggregated from all steps
  mcpServers: MCPServerResult[];
}

export type PlanResult = { success: true; plan: TaskPlan } | { success: false; reason: string };

export type EnhancedPlanResult =
  | { success: true; plan: EnhancedTaskPlan }
  | { success: false; reason: string };

/**
 * Use LLM to plan which agents to use and in what order.
 * This is the core of the MVP - testing if focused planning improves agent selection.
 */
export async function planTask(
  intent: string,
  agents: CatalogAgent[],
  abortSignal?: AbortSignal,
): Promise<PlanResult> {
  const model = registry.languageModel("anthropic:claude-sonnet-4-5");

  const prompt = `You are a task planner. Select agents and order steps to accomplish the user's intent.

Available agents:
${agents.map((a) => `- ${a.id}: ${a.description}`).join("\n")}

User intent: "${intent}"

Think through:
1. What data or actions are needed to accomplish this?
2. Which agents provide those capabilities?
3. What order makes sense (dependencies first)?
4. Are the step descriptions specific enough (include key parameters)?

Output JSON with this exact structure:
{
  "steps": [
    { "agentId": "agent-id", "description": "specific task for this agent with details" }
  ]
}

Rules:
- Pick agents that can actually accomplish the task
- Order steps logically (if step B needs data from step A, A must come first)
- Make descriptions specific and actionable (include parameters like dates, filters, etc)
- If NO agents can help, output: { "error": "explanation of what capabilities are missing" }
- Output ONLY valid JSON, no markdown or explanation

Examples:
User: "what's on my calendar today?"
Output: { "steps": [{ "agentId": "google-calendar", "description": "Fetch today's calendar events" }] }

User: "check my calendar and email me the results"
Output: { "steps": [
  { "agentId": "google-calendar", "description": "Fetch today's calendar events" },
  { "agentId": "gmail-send", "description": "Send email with calendar events to user" }
] }`;

  try {
    const result = await generateText({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3, // Lower = more consistent choices
      abortSignal,
    });

    logger.debug("Planning LLM response", { text: result.text });

    // Parse LLM response
    let parsed: unknown;
    try {
      // Remove markdown code blocks if present
      const cleanedText = result.text
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      parsed = JSON.parse(cleanedText);
    } catch (parseError) {
      logger.error("Failed to parse planning response", { error: parseError, text: result.text });
      return { success: false, reason: `Planning failed: Could not parse LLM response as JSON` };
    }

    // Check if LLM returned error
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string"
    ) {
      return { success: false, reason: parsed.error };
    }

    // Validate structure
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("steps" in parsed) ||
      !Array.isArray(parsed.steps)
    ) {
      return { success: false, reason: "Planning failed: Invalid response structure" };
    }

    if (parsed.steps.length === 0) {
      return { success: false, reason: "Planning failed: No steps generated" };
    }

    // Validate each step with type guards
    const validSteps: Array<{ agentId: string; description: string }> = [];
    for (const step of parsed.steps) {
      if (
        typeof step !== "object" ||
        step === null ||
        !("agentId" in step) ||
        !("description" in step) ||
        typeof step.agentId !== "string" ||
        typeof step.description !== "string"
      ) {
        return { success: false, reason: "Planning failed: Invalid step structure" };
      }
      validSteps.push({ agentId: step.agentId, description: step.description });
    }

    return { success: true, plan: { steps: validSteps } };
  } catch (error) {
    logger.error("Planning failed with exception", { error });
    return {
      success: false,
      reason: `Planning failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Enhanced planning with execution type detection and MCP server generation.
 * Identifies which steps need bundled agents vs ad-hoc LLM + MCP tools.
 */
export async function planTaskEnhanced(
  intent: string,
  agents: CatalogAgent[],
  abortSignal?: AbortSignal,
): Promise<EnhancedPlanResult> {
  const model = registry.languageModel("anthropic:claude-sonnet-4-5");

  // Build agent catalog for prompt
  const agentList = agents.map((a) => `- ${a.id}: ${a.description}`).join("\n");

  const prompt = `You are a task planner. Analyze the user's intent and determine execution strategy.

Available bundled agents:
${agentList}

User intent: "${intent}"

For each step, determine:
1. Can a bundled agent handle this? → Use agent
2. Requires MCP tools without bundled agent? → Use ad-hoc LLM with MCP tools

Think through:
- What capabilities are needed (calendar, slack, github, email, etc)?
- Which bundled agents provide those capabilities?
- What needs MCP tools but has no bundled agent?

Output JSON with this exact structure:
{
  "steps": [
    {
      "agentId": "agent-id",  // only if using bundled agent
      "description": "specific task description",
      "executionType": "agent",  // or "llm"
      "needs": ["capability1", "capability2"]  // e.g., ["slack", "calendar"]
    }
  ]
}

Rules:
- executionType="agent" requires agentId from available agents
- executionType="llm" means ad-hoc LLM call with MCP tools (no agentId)
- needs array identifies required capabilities (slack, github, calendar, etc)
- Order steps logically (dependencies first)
- If NO solution possible, output: { "error": "explanation" }
- Output ONLY valid JSON, no markdown

Examples:

User: "check my calendar today"
Output: {
  "steps": [{
    "agentId": "google-calendar",
    "description": "Fetch today's calendar events",
    "executionType": "agent",
    "needs": ["calendar"]
  }]
}

User: "send a message to #general on Slack"
(Assume no slack bundled agent available)
Output: {
  "steps": [{
    "description": "Send message to #general on Slack",
    "executionType": "llm",
    "needs": ["slack"]
  }]
}

User: "check calendar and post summary to Slack"
Output: {
  "steps": [
    {
      "agentId": "google-calendar",
      "description": "Fetch today's calendar events",
      "executionType": "agent",
      "needs": ["calendar"]
    },
    {
      "description": "Post calendar summary to Slack #general",
      "executionType": "llm",
      "needs": ["slack"]
    }
  ]
}`;

  try {
    const result = await generateText({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      abortSignal,
    });

    logger.debug("Enhanced planning LLM response", { text: result.text });

    // Parse response
    let parsed: unknown;
    try {
      const cleanedText = result.text
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      parsed = JSON.parse(cleanedText);
    } catch (parseError) {
      logger.error("Failed to parse enhanced planning response", {
        error: parseError,
        text: result.text,
      });
      return {
        success: false,
        reason: `Enhanced planning failed: Could not parse LLM response as JSON`,
      };
    }

    // Check for error response
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string"
    ) {
      return { success: false, reason: parsed.error };
    }

    // Validate structure
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("steps" in parsed) ||
      !Array.isArray(parsed.steps)
    ) {
      return { success: false, reason: "Enhanced planning failed: Invalid response structure" };
    }

    if (parsed.steps.length === 0) {
      return { success: false, reason: "Enhanced planning failed: No steps generated" };
    }

    // Validate and collect steps
    const validSteps: EnhancedTaskStep[] = [];
    for (const step of parsed.steps) {
      if (
        typeof step !== "object" ||
        step === null ||
        !("description" in step) ||
        typeof step.description !== "string" ||
        !("executionType" in step) ||
        (step.executionType !== "agent" && step.executionType !== "llm") ||
        !("needs" in step) ||
        !Array.isArray(step.needs)
      ) {
        return { success: false, reason: "Enhanced planning failed: Invalid step structure" };
      }

      // Validate needs array contains only strings
      const needs: string[] = [];
      for (const need of step.needs) {
        if (typeof need !== "string") {
          return {
            success: false,
            reason: "Enhanced planning failed: needs array must contain only strings",
          };
        }
        needs.push(need);
      }

      // Validate execution type constraints
      let agentId: string | undefined;
      if (step.executionType === "agent") {
        if (!("agentId" in step) || typeof step.agentId !== "string") {
          return {
            success: false,
            reason: "Enhanced planning failed: agent execution type requires agentId",
          };
        }
        agentId = step.agentId;
      }

      validSteps.push({
        agentId,
        description: step.description,
        executionType: step.executionType,
        needs,
      });
    }

    // Aggregate all needs
    const allNeeds = new Set<string>();
    for (const step of validSteps) {
      for (const need of step.needs) {
        allNeeds.add(need);
      }
    }

    // Generate MCP servers from needs
    // Convert needs to agent-like structure for generateMCPServers
    const agentsForMCP = validSteps
      .filter((step) => step.executionType === "llm")
      .map((step, index) => ({
        id: `llm-step-${index}`,
        name: step.description,
        description: step.description,
        needs: step.needs,
        config: {},
        executionType: "llm" as const,
      }));

    const mcpServers = generateMCPServers(agentsForMCP);

    logger.info("Enhanced planning succeeded", {
      stepCount: validSteps.length,
      needCount: allNeeds.size,
      mcpServerCount: mcpServers.length,
    });

    return { success: true, plan: { steps: validSteps, needs: Array.from(allNeeds), mcpServers } };
  } catch (error) {
    logger.error("Enhanced planning failed with exception", { error });
    return {
      success: false,
      reason: `Enhanced planning failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

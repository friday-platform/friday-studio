import type { RequiredConfigField } from "@atlas/core";
import {
  CredentialNotFoundError,
  resolveCredentialsByProvider,
  validateRequiredFields,
} from "@atlas/core";
import type { CredentialBinding } from "@atlas/core/artifacts";
import { registry, smallLLM } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { generateText } from "ai";
import {
  generateMCPServers,
  type MCPServerResult,
} from "../../../fsm-workspace-creator/enrichers/mcp-servers.ts";
import type { CatalogAgent } from "./catalog.ts";

/**
 * MCP context for planner - provides domain-to-MCP mapping
 */
export interface MCPContext {
  id: string;
  urlDomains: string[];
  connected: boolean;
}

// Enhanced types for FSM-based execution
export interface EnhancedTaskStep {
  agentId?: string; // for agent steps
  description: string;
  executionType: "agent" | "llm";
  needs: string[]; // e.g., ["slack", "github"]
  friendlyDescription?: string;
}

export interface EnhancedTaskPlan {
  steps: EnhancedTaskStep[];
  needs: string[]; // aggregated from all steps
  mcpServers: MCPServerResult[];
}

export type EnhancedPlanResult =
  | { success: true; plan: EnhancedTaskPlan }
  | { success: false; reason: string };

/**
 * Generate friendly descriptions for all steps in a single batch.
 * Falls back to raw descriptions on error.
 */
async function generateFriendlyDescriptions(
  steps: Array<{ agentId?: string; description: string }>,
  intent: string,
  abortSignal?: AbortSignal,
): Promise<string[]> {
  if (steps.length === 0) return [];

  try {
    const stepList = steps
      .map((s, i) => `${i + 1}. [${s.agentId || "llm"}] ${s.description}`)
      .join("\n");

    const result = await smallLLM({
      system:
        "Generate brief, friendly progress messages (≤10 words each) for what an AI assistant is doing. One per line, matching input order. Be specific but concise. No numbering, no punctuation at end. NEVER include UUIDs, artifact IDs, or technical identifiers - use filenames or descriptive terms instead.",
      prompt: `User intent: ${intent}\n\nSteps:\n${stepList}`,
      maxOutputTokens: 50 * steps.length,
      abortSignal,
    });

    const lines = result
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return steps.map((step, i) => lines[i] || step.description);
  } catch {
    return steps.map((s) => s.description);
  }
}

/**
 * Enhanced planning with execution type detection and MCP server generation.
 * Identifies which steps need bundled agents vs ad-hoc LLM + MCP tools.
 *
 * @param intent - User's intent/request
 * @param agents - Available bundled agents
 * @param mcpContext - MCP servers with URL domain mappings for tool selection priority
 * @param abortSignal - Optional abort signal
 */
export async function planTaskEnhanced(
  intent: string,
  agents: CatalogAgent[],
  mcpContext: MCPContext[],
  abortSignal?: AbortSignal,
): Promise<EnhancedPlanResult> {
  const model = registry.languageModel("anthropic:claude-sonnet-4-5");

  // Build agent catalog for prompt
  const agentList = agents.map((a) => `- ${a.id}: ${a.description}`).join("\n");

  // Build MCP context for URL domain matching
  const mcpWithDomains = mcpContext.filter((m) => m.urlDomains.length > 0);
  const mcpList =
    mcpWithDomains.length > 0
      ? mcpWithDomains.map((m) => `- ${m.id}: ${m.urlDomains.join(", ")}`).join("\n")
      : "(none)";

  const prompt = `You are a task planner. Analyze the user's intent and determine execution strategy.

Available bundled agents:
${agentList}

User intent: "${intent}"

## Tool Selection Priority (CRITICAL)

When handling URLs, follow this priority order:
1. Bundled agents (check available agents first)
2. MCP tools (check URL domain against Available MCPs below)
3. webfetch (ONLY if no MCP matches the URL domain)

Available MCPs with URL domains:
${mcpList}

**IMPORTANT**: If a URL domain matches an MCP, use needs=["<mcp-id>"], NOT webfetch.
- https://linear.app/... → needs=["linear"]
- https://github.com/... → needs=["github"]
- https://notion.so/... → needs=["notion"]
- https://example.com/... (no MCP) → needs=[] (uses webfetch)

## Built-in Capabilities (always available to LLM steps)

LLM steps (executionType="llm") automatically have these tools:
- webfetch: Fetch content from generic URLs that don't match any MCP
- artifacts_create, artifacts_get, artifacts_update: Store/retrieve task outputs

For each step, determine:
1. Can a bundled agent handle this? → Use agent
2. Does the URL match an MCP domain? → Use LLM with needs=[mcp-id]
3. Generic URL with no MCP? → Use LLM with needs=[]

Think through:
- What capabilities are needed (calendar, slack, github, email, etc)?
- Which bundled agents provide those capabilities?
- Does any URL match an available MCP's domain?
- What needs MCP tools but has no bundled agent?

Output JSON with this exact structure:
{
  "steps": [
    {
      "agentId": "agent-id",  // only if using bundled agent
      "description": "specific task description",
      "executionType": "agent",  // or "llm"
      "needs": ["capability1", "capability2"]  // e.g., ["slack", "calendar", "linear"]
    }
  ]
}

Rules:
- executionType="agent" requires agentId from available agents
- executionType="llm" means ad-hoc LLM call with MCP tools (no agentId)
- needs array identifies required capabilities (slack, github, calendar, linear, etc)
- If URL matches MCP domain, include MCP id in needs array
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

User: "summarize this Linear issue: https://linear.app/team/TEM-123"
(linear.app matches MCP "linear")
Output: {
  "steps": [{
    "description": "Fetch Linear issue TEM-123 details using Linear MCP",
    "executionType": "llm",
    "needs": ["linear"]
  }]
}

User: "what's in this GitHub PR: https://github.com/org/repo/pull/456"
(github.com matches MCP "github")
Output: {
  "steps": [{
    "description": "Fetch GitHub PR #456 details using GitHub MCP",
    "executionType": "llm",
    "needs": ["github"]
  }]
}

User: "read the content at https://example.com/page"
(example.com has no MCP match → use webfetch)
Output: {
  "steps": [{
    "description": "Fetch content from https://example.com/page using webfetch",
    "executionType": "llm",
    "needs": []
  }]
}

User: "fetch this URL and summarize it: https://news.com/article"
(news.com has no MCP match → use webfetch)
Output: {
  "steps": [
    {
      "description": "Fetch content from https://news.com/article using webfetch",
      "executionType": "llm",
      "needs": []
    },
    {
      "agentId": "get-summary",
      "description": "Summarize the fetched content",
      "executionType": "agent",
      "needs": []
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

    const mcpServersForValidation = generateMCPServers(agentsForMCP);

    // Validate Link credentials for MCP servers BEFORE execution
    // Fail fast if credentials are missing or ambiguous
    // Collect resolved credentials to pass to final MCP server generation
    const credentialBindings: CredentialBinding[] = [];
    for (const server of mcpServersForValidation) {
      // Extract required config fields from server config
      const requiredFields: RequiredConfigField[] = [];
      if (server.config.env) {
        for (const [key, value] of Object.entries(server.config.env)) {
          if (
            typeof value === "object" &&
            value !== null &&
            "from" in value &&
            value.from === "link"
          ) {
            requiredFields.push({
              key,
              description: `Link credential for ${key}`,
              type: "string", // Link credentials are always strings
            });
          }
        }
      }

      // Skip validation if no Link credentials required
      if (requiredFields.length === 0) {
        continue;
      }

      // Validate credentials
      const validation = await validateRequiredFields(requiredFields, server.config);

      // Fail fast on missing credentials
      if (validation.missingCredentials.length > 0) {
        const missing = validation.missingCredentials.at(0);
        return {
          success: false,
          reason: `Cannot execute task: ${missing?.reason}. MCP server '${server.id}' requires this credential.`,
        };
      }

      // Fail fast on ambiguous credentials (multiple credentials found)
      // Also collect the resolved credentials for final MCP server generation
      for (const resolved of validation.resolvedCredentials) {
        // Check if multiple credentials exist for this provider
        try {
          const allCreds = await resolveCredentialsByProvider(resolved.provider);
          if (allCreds.length > 1) {
            return {
              success: false,
              reason: `Cannot execute task: Found ${allCreds.length} credentials for provider '${resolved.provider}'. Please specify which credential to use by ID in workspace.yml.`,
            };
          }
        } catch (err) {
          if (err instanceof CredentialNotFoundError) {
            // Already caught by validateRequiredFields, this shouldn't happen
            return {
              success: false,
              reason: `Cannot execute task: No credentials found for provider '${err.provider}'`,
            };
          }
          throw err;
        }

        // Collect the resolved credential binding
        credentialBindings.push({
          targetType: "mcp",
          serverId: server.id,
          field: resolved.field,
          credentialId: resolved.credentialId,
          provider: resolved.provider,
          key: resolved.key,
        });
      }
    }

    // Regenerate MCP servers with the collected credential bindings
    const mcpServers = generateMCPServers(agentsForMCP, credentialBindings);

    logger.info("Enhanced planning succeeded", {
      stepCount: validSteps.length,
      needCount: allNeeds.size,
      mcpServerCount: mcpServers.length,
    });

    // Generate friendly descriptions in batch
    const friendlyDescriptions = await generateFriendlyDescriptions(
      validSteps,
      intent,
      abortSignal,
    );

    const stepsWithFriendly = validSteps.map((step, i) => ({
      ...step,
      friendlyDescription: friendlyDescriptions[i],
    }));

    return {
      success: true,
      plan: { steps: stepsWithFriendly, needs: Array.from(allNeeds), mcpServers },
    };
  } catch (error) {
    logger.error("Enhanced planning failed with exception", { error });
    return {
      success: false,
      reason: `Enhanced planning failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

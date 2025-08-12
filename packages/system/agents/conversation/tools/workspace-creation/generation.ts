import { z } from "zod/v4";
import { tool } from "ai";
import { createAtlasClient } from "@atlas/oapi-client";
import { WorkspaceGenerator } from "./generator.ts";

/**
 * Schema for workspace generation requirements
 */
export const WorkspaceRequirementsSchema = z.object({
  triggers: z.array(z.string()).optional().describe(
    "Specific trigger requirements (e.g., 'every 30 minutes', 'on webhook')",
  ),
  integrations: z.array(z.string()).optional().describe(
    "Required external integrations (e.g., 'Discord', 'Stripe API', 'HubSpot')",
  ),
  outputs: z.array(z.string()).optional().describe(
    "Desired output formats or destinations (e.g., 'Discord notifications', 'email alerts')",
  ),
  credentials: z.array(z.string()).optional().describe(
    "Known credential requirements (e.g., 'Discord webhook URL', 'API keys')",
  ),
}).optional().describe(
  "Structured requirements object for workspace generation",
);

export type WorkspaceRequirements = z.infer<typeof WorkspaceRequirementsSchema>;

/**
 * Main production tool for advanced workspace generation
 *
 * This tool provides the primary interface for conversation agents to create
 * complete Atlas workspace configurations using AI orchestration with the
 * Generate-Validate-Repair loop.
 */
export const generateWorkspace = tool({
  description:
    "Generate and optionally create complete Atlas workspace using AI orchestration with multi-attempt validation",
  inputSchema: z.object({
    userIntent: z.string().describe(
      "User's natural language description of their automation needs and goals",
    ),
    conversationContext: z.string().optional().describe(
      "Additional context from the conversation that provides relevant details",
    ),
    requirements: WorkspaceRequirementsSchema,
    debugLevel: z.enum(["minimal", "detailed"]).default("minimal").describe(
      "Level of technical detail to include in the response",
    ),
    createWorkspace: z.boolean().default(true).describe(
      "Whether to create workspace files after generation (true) or just generate config (false)",
    ),
    workspaceName: z.string().optional().describe(
      "Custom workspace directory name (defaults to generated name, will auto-resolve conflicts with -2, -3, etc.)",
    ),
  }),
  execute: async (
    { userIntent, conversationContext, requirements, debugLevel, createWorkspace, workspaceName },
  ) => {
    const generator = new WorkspaceGenerator();

    try {
      // Step 1: Generate workspace configuration (existing logic)
      const { config, reasoning } = await generator.generateWorkspace(
        userIntent,
        conversationContext,
        requirements,
        3, // maxAttempts
      );

      // Step 2: Create workspace if requested
      if (createWorkspace) {
        try {
          const client = createAtlasClient();
          const response = await client.POST("/api/workspaces/create", {
            body: {
              config,
              workspaceName: workspaceName || config.workspace.name,
            },
          });

          if (response.error) {
            throw new Error(`API error (${response.response.status}): ${JSON.stringify(response.error)}`);
          }

          const creationResult = response.data as {
            workspace: unknown;
            workspacePath: string;
            filesCreated: string[];
          };

          return {
            success: true,
            config,
            reasoning: debugLevel === "detailed"
              ? reasoning
              : "Workspace generated and created successfully",
            workspaceName: config.workspace.name,
            created: true,
            workspace: creationResult.workspace,
            workspacePath: creationResult.workspacePath,
            filesCreated: creationResult.filesCreated,
            summary: {
              signals: Object.keys(config.signals || {}).length,
              agents: Object.keys(config.agents || {}).length,
              jobs: Object.keys(config.jobs || {}).length,
              mcpServers: config.tools?.mcp?.servers
                ? Object.keys(config.tools.mcp.servers).length
                : 0,
            },
          };
        } catch (creationError) {
          // Return generation success but creation failure
          throw new Error(
            `Workspace generated successfully but creation failed: ${
              creationError instanceof Error ? creationError.message : String(creationError)
            }`,
          );
        }
      }

      // Generation only (createWorkspace = false)
      return {
        success: true,
        config,
        reasoning: debugLevel === "detailed" ? reasoning : "Workspace generated successfully",
        workspaceName: config.workspace.name,
        created: false,
        summary: {
          signals: Object.keys(config.signals || {}).length,
          agents: Object.keys(config.agents || {}).length,
          jobs: Object.keys(config.jobs || {}).length,
          mcpServers: config.tools?.mcp?.servers ? Object.keys(config.tools.mcp.servers).length : 0,
        },
      };
    } catch (error) {
      const errorMessage = debugLevel === "detailed"
        ? (error instanceof Error ? error.message : String(error))
        : getUserFriendlyError(error);
      throw new Error(
        `Workspace ${createWorkspace ? "creation" : "generation"} failed: ${errorMessage}`,
      );
    }
  },
});

/**
 * Convert technical errors into user-friendly messages
 */
function getUserFriendlyError(error: unknown): string {
  if (error instanceof Error) {
    // Handle specific error patterns
    if (error.message.includes("validation")) {
      return "The workspace configuration had validation issues. Please try with different requirements or contact support if this persists.";
    }
    if (error.message.includes("ANTHROPIC_API_KEY")) {
      return "AI service is not properly configured. Please contact your administrator.";
    }
    if (error.message.includes("tool")) {
      return "There was an issue with workspace construction. Please try again with a clearer description.";
    }
    if (error.message.includes("Failed after")) {
      return "The workspace generation couldn't complete successfully. Please try simplifying your requirements or providing more specific details.";
    }

    // Return the actual error message for debugging but make it user-friendly
    return error.message;
  }

  return "An unexpected error occurred during workspace generation. Please try again.";
}

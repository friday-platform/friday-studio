import type { AtlasTools } from "@atlas/agent-sdk";
import { client } from "@atlas/client/v2";
import { MCPServerMetadataSchema } from "@atlas/core/mcp-registry/schemas";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";
import { deriveCredentialHints } from "./mcp-server-utils.ts";

const CreateInputSchema = z
  .object({
    name: z.string().min(1).max(100).describe("Display name for the MCP server."),
    description: z.string().max(500).optional().describe("What this server does."),
    command: z
      .string()
      .min(1)
      .optional()
      .describe("Command to run (e.g. 'npx'). Provide either command+args or url, not both."),
    args: z
      .array(z.string())
      .optional()
      .default([])
      .describe(
        "Arguments for the command. Exclude credential placeholders — extract them into envVars.",
      ),
    url: z
      .string()
      .url()
      .optional()
      .describe(
        "URL for a streamable-http MCP server. " + "Provide either url or command+args, not both.",
      ),
    envVars: z
      .array(
        z.object({
          key: z.string().min(1).describe("Environment variable name."),
          description: z.string().optional().describe("What this variable is for."),
          exampleValue: z.string().optional().describe("Example value."),
        }),
      )
      .optional()
      .default([])
      .describe(
        "Secrets and credential placeholders extracted from the command (e.g. `YOUR_API_KEY` from `--api-key YOUR_API_KEY`). " +
          "The user connects these via connect_service.",
      ),
  })
  .refine((data) => (data.url ? !data.command : !!data.command), {
    message: "Provide either command+args or url, not both.",
  });

interface CreateSuccess {
  success: true;
  server: {
    id: string;
    name: string;
    description?: string;
    source: string;
    needsCredentials: boolean;
    provider?: string;
    requiredConfig?: string[];
  };
  warning?: string;
}

interface CreateFailure {
  success: false;
  error: string;
}

type CreateResult = CreateSuccess | CreateFailure;

/**
 * Build the `create_mcp_server` tool for workspace chat.
 *
 * Adds a custom MCP server to the workspace from a command+args (stdio) or
 * HTTP URL. Automatically creates a Link provider for credential management.
 * On success, returns the server with credential-setup hints.
 */
export function createCreateMcpServerTool(logger: Logger): AtlasTools {
  return {
    create_mcp_server: tool({
      description:
        "Add a custom MCP server. Provide either a command+args or a URL. " +
        "Extract credential placeholders (e.g. `--api-key YOUR_API_KEY`) from args into envVars — " +
        "leave only structural flags like `-y` or `--port` in args.",
      inputSchema: CreateInputSchema,
      execute: async (input): Promise<CreateResult> => {
        const { name, description, command, args, url, envVars } = input;

        // Map tool input to daemon route shape
        const body = url
          ? { name, description, httpUrl: url }
          : {
              name,
              description,
              configJson: {
                transport: { type: "stdio" as const, command: command!, args: args ?? [] },
                envVars: envVars ?? [],
              },
            };

        try {
          const res = await client.mcpRegistry.custom.$post({ json: body });
          const responseBody = await res.json();

          if (res.status === 201) {
            const parsed = z
              .object({ server: MCPServerMetadataSchema, warning: z.string().optional() })
              .safeParse(responseBody);

            if (!parsed.success) {
              logger.warn("create_mcp_server: unexpected 201 shape", {
                name,
                body: responseBody,
                issues: parsed.error.issues,
              });
              return { success: false, error: "Server created but returned unexpected data." };
            }

            const { server, warning } = parsed.data;
            const hints = deriveCredentialHints(server.configTemplate.env);

            logger.info("create_mcp_server succeeded", {
              name,
              id: server.id,
              needsCredentials: hints.needsCredentials,
              provider: hints.provider,
            });

            return {
              success: true,
              server: {
                id: server.id,
                name: server.name,
                description: server.description,
                source: server.source,
                ...hints,
              },
              ...(warning !== undefined && { warning }),
            };
          }

          if (res.status === 400 || res.status === 409) {
            const errorBody = responseBody as Record<string, unknown>;
            const errorMsg = String(errorBody.error ?? "Failed to create MCP server.");
            logger.info("create_mcp_server rejected", {
              name,
              status: res.status,
              error: errorMsg,
            });
            return { success: false, error: errorMsg };
          }

          const errorMsg =
            typeof responseBody === "object" && responseBody !== null && "error" in responseBody
              ? String(responseBody.error)
              : `Create failed: ${res.status}`;
          logger.warn("create_mcp_server failed", { name, status: res.status, error: errorMsg });
          return { success: false, error: errorMsg };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("create_mcp_server threw", { name, error: message });
          return { success: false, error: `Create failed: ${message}` };
        }
      },
    }),
  };
}

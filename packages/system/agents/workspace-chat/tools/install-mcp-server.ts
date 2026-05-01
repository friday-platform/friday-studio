import type { AtlasTools } from "@atlas/agent-sdk";
import { client } from "@atlas/client/v2";
import { MCPServerMetadataSchema } from "@atlas/core/mcp-registry/schemas";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";
import { deriveCredentialHints } from "./mcp-server-utils.ts";

const InstallInputSchema = z.object({
  registryName: z
    .string()
    .min(1)
    .describe(
      "Canonical name of the MCP server from the official registry " +
        "(e.g. 'io.github/Digital-Defiance/mcp-filesystem'). " +
        "Get this from search_mcp_servers results.",
    ),
});

interface InstallSuccess {
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

interface InstallFailure {
  success: false;
  error: string;
  existingId?: string;
}

type InstallResult = InstallSuccess | InstallFailure;

/**
 * Build the `install_mcp_server` tool for workspace chat.
 *
 * Installs an MCP server from the official registry by its canonical name.
 * On success, returns the installed server with credential-setup hints so
 * the LLM can guide the user through `connect_service` if needed.
 */
export function createInstallMcpServerTool(logger: Logger): AtlasTools {
  return {
    install_mcp_server: tool({
      description:
        "Install an MCP server from the official registry by its canonical name (from search_mcp_servers). " +
        "Returns needsCredentials and provider so you can guide the user through connect_service.",
      inputSchema: InstallInputSchema,
      execute: async ({ registryName }): Promise<InstallResult> => {
        try {
          const res = await client.mcpRegistry.install.$post({ json: { registryName } });
          const body = await res.json();

          if (res.status === 201) {
            const parsed = z
              .object({ server: MCPServerMetadataSchema, warning: z.string().optional() })
              .safeParse(body);

            if (!parsed.success) {
              logger.warn("install_mcp_server: unexpected 201 shape", {
                registryName,
                body,
                issues: parsed.error.issues,
              });
              return { success: false, error: "Install succeeded but returned unexpected data." };
            }

            const { server, warning } = parsed.data;
            const hints = deriveCredentialHints(server.configTemplate.env);

            logger.info("install_mcp_server succeeded", {
              registryName,
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

          if (res.status === 409) {
            const errorBody = body as Record<string, unknown>;
            const errorMsg = String(errorBody.error ?? "Server is already installed.");
            const existingId = errorBody.existingId ? String(errorBody.existingId) : undefined;
            logger.info("install_mcp_server: already installed", { registryName, existingId });
            return { success: false, error: errorMsg, existingId };
          }

          if (res.status === 400) {
            const errorBody = body as Record<string, unknown>;
            const errorMsg = String(errorBody.error ?? "This server cannot be auto-installed.");
            logger.info("install_mcp_server: translator rejected", {
              registryName,
              error: errorMsg,
            });
            return { success: false, error: errorMsg };
          }

          if (res.status === 404) {
            const errorBody = body as Record<string, unknown>;
            const errorMsg = String(
              errorBody.error ?? `Server "${registryName}" not found in registry.`,
            );
            logger.info("install_mcp_server: not found", { registryName });
            return { success: false, error: errorMsg };
          }

          const errorMsg =
            typeof body === "object" && body !== null && "error" in body
              ? String(body.error)
              : `Install failed: ${res.status}`;
          logger.warn("install_mcp_server failed", {
            registryName,
            status: res.status,
            error: errorMsg,
          });
          return { success: false, error: errorMsg };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("install_mcp_server threw", { registryName, error: message });
          return { success: false, error: `Install failed: ${message}` };
        }
      },
    }),
  };
}

/**
 * Artifact tools for the workspace-chat agent.
 *
 * Provides `display_artifact` (re-exported from conversation tools) and
 * `artifacts_get` (direct tool mirroring the MCP registration).
 *
 * Exported as a pre-typed `AtlasTools` object to avoid TS2589 deep type
 * instantiation when spread into `streamText`'s tools parameter.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { createLogger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";
import { displayArtifact } from "./display-artifact.ts";

const logger = createLogger({ name: "workspace-chat-artifacts" });

/**
 * Direct tool for retrieving an artifact by ID.
 * Mirrors the MCP `artifacts_get` tool (packages/mcp-server/src/tools/artifacts/get.ts)
 * so workspace-chat can use it without platform tool passthrough.
 */
const artifactsGet = tool({
  description: "Get artifact by ID",
  inputSchema: z.object({
    artifactId: z.string().describe("Artifact ID"),
    revision: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Revision number (defaults to latest)"),
  }),
  execute: async ({ artifactId, revision }) => {
    logger.info("artifacts_get called", { artifactId, revision });

    const response = await parseResult(
      client.artifactsStorage[":id"].$get({
        param: { id: artifactId },
        query: { revision: revision?.toString() },
      }),
    );

    if (!response.ok) {
      return { success: false, error: `Failed to retrieve artifact: ${artifactId}` };
    }

    const { artifact, contents } = response.data;
    return { ...artifact, contents };
  },
});

/** Artifact tools typed as AtlasTools to prevent TS2589 in streamText generics. */
export const artifactTools: AtlasTools = {
  display_artifact: displayArtifact,
  artifacts_get: artifactsGet,
};

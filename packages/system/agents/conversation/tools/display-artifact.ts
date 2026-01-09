import { tool } from "ai";
import { z } from "zod";
import { client, parseResult } from "@atlas/client/v2";
import { createLogger } from "@atlas/logger";

const logger = createLogger({ name: "display-artifact" });

export const displayArtifact = tool({
  description:
    "Display an artifact to the user. Only use artifact IDs from tool responses. Never invent IDs.",
  inputSchema: z.object({ artifactId: z.string().describe("Artifact ID from a tool response") }),
  execute: async ({ artifactId }) => {
    const result = await parseResult(
      client.artifactsStorage[":id"].$get({ param: { id: artifactId }, query: {} }),
    );

    if (!result.ok) {
      logger.error("Artifact not found for display", { artifactId, error: result.error });
      return {
        success: false,
        error: `Artifact not found: ${artifactId}. Check the ID of the artifact you just tried to display.`,
      };
    }

    return {
      success: true,
      artifactId,
      displayed: {
        type: result.data.artifact.type,
        title: result.data.artifact.title,
        summary: result.data.artifact.summary,
      },
    };
  },
});

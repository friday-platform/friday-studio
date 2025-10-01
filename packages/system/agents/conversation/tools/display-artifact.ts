import { tool } from "ai";
import { z } from "zod";

export const displayArtifact = tool({
  description: "Display an artifact by id",
  inputSchema: z.object({ artifactId: z.string().describe("The id of the artifact to display") }),
  execute: ({ artifactId }) => ({ artifactId }),
});

import { tool } from "ai";
import { z } from "zod";

/**
 * Factory that creates a link auth tool constrained to available providers.
 * @param providers - Array of provider IDs that the user has configured in Link
 * @returns A tool with a provider enum constrained to the available providers
 */
export function createConnectServiceTool(providers: string[]) {
  return tool({
    description: "Prompt the user to connect an external service (OAuth or API key)",
    inputSchema: z.object({
      provider: z.enum(providers).describe("Provider ID from the available services list"),
    }),
    execute: ({ provider }) => {
      return { provider };
    },
  });
}

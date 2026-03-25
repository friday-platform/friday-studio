import { client, parseResult } from "@atlas/client/v2";
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
    execute: async ({ provider }) => {
      if (provider === "slack-app") {
        const result = await parseResult(
          client.link.v1.summary.$get({ query: { provider: "slack-user" } }),
        );
        if (!result.ok) {
          return { error: "Unable to verify Slack Organization status. Please try again." };
        }
        if (result.data.credentials.length === 0) {
          return {
            error:
              "Slack bot setup requires connecting your Slack Organization first. " +
              "Please connect the Slack Organization integration, then try again.",
          };
        }
      }
      return { provider };
    },
  });
}

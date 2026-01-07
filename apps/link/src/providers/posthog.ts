import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import { defineApiKeyProvider } from "./types.ts";

/**
 * PostHog Personal API Key schema.
 * Personal API keys are obtained from PostHog settings with the MCP Server preset.
 * @see https://posthog.com/docs/model-context-protocol
 */
const PostHogSecretSchema = z.object({ access_token: z.string().min(1, "API key is required") });

/**
 * Schema for PostHog /api/users/@me/ response (subset of fields we need).
 * @see https://posthog.com/docs/api/user
 */
const PostHogUserSchema = z.object({
  uuid: z.string(),
  email: z.string(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

/**
 * PostHog Personal API Key provider.
 * Uses Personal API Keys for authentication (not OAuth).
 *
 * Note: PostHog has regional endpoints:
 * - US Cloud: https://us.posthog.com
 * - EU Cloud: https://eu.posthog.com
 * MCP endpoint (https://mcp.posthog.com/mcp) handles routing internally.
 */
export const posthogProvider = defineApiKeyProvider({
  id: "posthog",
  displayName: "PostHog",
  description: "PostHog analytics via Personal API Key",
  secretSchema: PostHogSecretSchema,
  setupInstructions: `
## Creating a PostHog Personal API Key

1. Go to [PostHog Personal API Keys](https://us.posthog.com/settings/user-api-keys?preset=mcp_server)
   - This link pre-selects the **MCP Server** preset with correct scopes
   - EU users: Use [eu.posthog.com](https://eu.posthog.com/settings/user-api-keys?preset=mcp_server) instead

2. Click **+ Create a personal API Key**

3. Give your key a label (e.g., "Friday Key")

4. The MCP Server preset should already be selected with appropriate scopes

5. Click **Create** and copy the key immediately (you won't see it again)

6. Paste the key in the field above

### Security Notes
- Personal API keys provide full access like logging in - keep them private
- Use the MCP Server preset to limit scopes to only what's needed
- Keys can be invalidated individually from PostHog settings

### Rate Limits
PostHog API has rate limits of 240/min and 1200/hour for analytics endpoints.
See [PostHog docs](https://posthog.com/docs/api/overview#rate-limiting) for details.
`.trim(),
  health: async (secret) => {
    try {
      // Use US endpoint - most common. EU users would need EU-specific setup.
      const response = await fetch("https://us.posthog.com/api/users/@me/", {
        headers: {
          Authorization: `Bearer ${secret.access_token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const text = await response.text();
        return { healthy: false, error: `PostHog API returned ${response.status}: ${text}` };
      }

      const user = PostHogUserSchema.parse(await response.json());
      return {
        healthy: true,
        metadata: {
          uuid: user.uuid,
          email: user.email,
          name: [user.first_name, user.last_name].filter(Boolean).join(" ") || undefined,
        },
      };
    } catch (e) {
      return { healthy: false, error: stringifyError(e) };
    }
  },
});

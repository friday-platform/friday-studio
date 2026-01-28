import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import { defineApiKeyProvider } from "./types.ts";

/**
 * Schema validates Anthropic API key format.
 * Matches both standard (sk-ant-api03-) and admin (sk-ant-admin-) keys.
 */
export const AnthropicSecretSchema = z.object({
  api_key: z
    .string()
    .regex(/^sk-ant-/, "Invalid Anthropic API key format. Must start with sk-ant-"),
});

/**
 * Schema for /v1/models response.
 * Used for zero-cost health check.
 */
const ModelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string() })).optional(),
  error: z.object({ message: z.string() }).optional(),
});

export const anthropicProvider = defineApiKeyProvider({
  id: "anthropic",
  displayName: "Anthropic",
  description: "Create an Anthropic API Key",
  docsUrl: "https://docs.anthropic.com/en/api/getting-started",
  secretSchema: AnthropicSecretSchema,
  setupInstructions: `
1. Go to [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Sign in or create an account
3. Click **Create Key**
5. Copy your key - it starts with \`sk-ant-api03-\`
`,
  health: async (secret) => {
    try {
      // GET /v1/models is zero-cost health check
      const response = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": secret.api_key, "anthropic-version": "2023-06-01" },
      });

      const data = ModelsResponseSchema.parse(await response.json());

      if (data.error) {
        return { healthy: false, error: data.error.message };
      }

      return { healthy: true, metadata: { modelsAvailable: data.data?.length ?? 0 } };
    } catch (e) {
      return { healthy: false, error: stringifyError(e) };
    }
  },
});

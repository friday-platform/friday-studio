import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import { defineApiKeyProvider } from "./types.ts";

/**
 * Schema for GitHub PAT credentials.
 * Validates that the token is a valid GitHub Personal Access Token format.
 */
const GitHubSecretSchema = z.object({
  access_token: z
    .string()
    .refine((token) => token.startsWith("ghp_") || token.startsWith("github_pat_"), {
      message: "Token must start with 'ghp_' (classic PAT) or 'github_pat_' (fine-grained PAT)",
    }),
});

/**
 * GitHub PAT provider.
 * Uses Personal Access Tokens for authentication instead of OAuth.
 */
export const githubProvider = defineApiKeyProvider({
  id: "github",
  displayName: "GitHub",
  description: "GitHub access via Personal Access Token",
  secretSchema: GitHubSecretSchema,
  setupInstructions: `
## Creating a GitHub Personal Access Token

1. Go to [GitHub Settings → Developer Settings → Personal Access Tokens](https://github.com/settings/tokens)

2. Choose token type:
   - **Fine-grained tokens** (recommended): Click "Generate new token" under Fine-grained tokens
   - **Classic tokens**: Click "Generate new token (classic)"

3. Configure your token:
   - Give it a descriptive name
   - Set an expiration (shorter is more secure)
   - Select the scopes/permissions needed for your use case

4. Click "Generate token" and copy the token immediately (you won't see it again)

5. Paste the token in the field above

### Token Format
- Classic PATs start with \`ghp_\`
- Fine-grained PATs start with \`github_pat_\`
`.trim(),
  health: async (secret) => {
    try {
      const response = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${secret.access_token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "atlas-link",
        },
      });

      if (!response.ok) {
        const text = await response.text();
        return { healthy: false, error: `GitHub API returned ${response.status}: ${text}` };
      }

      const user = (await response.json()) as { login: string; id: number };
      return { healthy: true, metadata: { login: user.login, id: user.id } };
    } catch (e) {
      return { healthy: false, error: stringifyError(e) };
    }
  },
});

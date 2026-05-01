import { createLogger } from "@atlas/logger";
import { z } from "zod";
import {
  type ApiKeyProvider,
  type DynamicProviderInput,
  defineApiKeyProvider,
  defineOAuthProvider,
  type OAuthProvider,
} from "./types.ts";

const logger = createLogger({ component: "provider:dynamic" });

/**
 * Hydrate dynamic provider input into full ProviderDefinition.
 * OAuth: discover userinfo endpoint for identify()
 * ApiKey: build Zod schema from secretSchema record
 */
export function hydrateDynamicProvider(
  input: DynamicProviderInput,
): OAuthProvider | ApiKeyProvider {
  if (input.type === "apikey") {
    const schemaFields: Record<string, z.ZodString> = {};
    for (const key of Object.keys(input.secretSchema)) {
      schemaFields[key] = z.string();
    }

    return defineApiKeyProvider({
      id: input.id,
      displayName: input.displayName,
      description: input.description,
      secretSchema: z.object(schemaFields),
      setupInstructions:
        input.setupInstructions ?? `Enter your ${input.displayName} API credentials.`,
    });
  }

  // OAuth discovery mode
  return defineOAuthProvider({
    id: input.id,
    displayName: input.displayName,
    description: input.description,
    oauthConfig: input.oauthConfig,
    identify: async (tokens) => {
      try {
        const serverOrigin = new URL(input.oauthConfig.serverUrl).origin;
        const metadataUrl = new URL(
          "/.well-known/oauth-protected-resource",
          input.oauthConfig.serverUrl,
        );
        const metadataRes = await fetch(metadataUrl.toString(), {
          signal: AbortSignal.timeout(5_000),
        });
        if (metadataRes.ok) {
          const metadata = z
            .object({ userinfo_endpoint: z.string().optional() })
            .parse(await metadataRes.json());
          if (metadata.userinfo_endpoint) {
            // Validate userinfo_endpoint shares same origin to prevent SSRF
            const userinfoOrigin = new URL(metadata.userinfo_endpoint).origin;
            if (userinfoOrigin !== serverOrigin) {
              // Origin mismatch - fall through to token hash
            } else {
              const userinfoRes = await fetch(metadata.userinfo_endpoint, {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
                signal: AbortSignal.timeout(5_000),
                redirect: "error",
              });
              if (userinfoRes.ok) {
                const userinfo = z
                  .object({ sub: z.string().optional(), email: z.string().optional() })
                  .parse(await userinfoRes.json());
                const identifier = userinfo.sub ?? userinfo.email;
                if (identifier) {
                  return identifier;
                }
              }
            }
          }
        }
      } catch (err) {
        logger.debug("OAuth identify discovery failed, falling back to token hash", {
          providerId: input.id,
          serverUrl: input.oauthConfig.serverUrl,
          error: err,
        });
      }
      return await hashToken(tokens.access_token);
    },
  });
}

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `token:${hashHex}`;
}

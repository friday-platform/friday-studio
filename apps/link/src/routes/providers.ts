import { z } from "zod";
import { factory } from "../factory.ts";
import { registry } from "../providers/registry.ts";

/**
 * Provider catalog router.
 * Mounted at /v1/providers in main app.
 */
export const providersRouter = factory
  .createApp()
  .get("/", (c) => {
    const providers = registry
      .list()
      .map((p) => ({
        id: p.id,
        displayName: p.displayName,
        description: p.description,
        iconUrl: p.iconUrl ?? null,
        docsUrl: p.docsUrl ?? null,
      }));
    return c.json({ providers });
  })
  .get("/:id", (c) => {
    const { id } = c.req.param();
    const provider = registry.get(id);

    if (!provider) {
      return c.json(
        { error: "provider_not_found", message: `Provider '${id}' not registered` },
        404,
      );
    }

    return c.json(
      {
        id: provider.id,
        type: provider.type,
        displayName: provider.displayName,
        description: provider.description,
        iconUrl: provider.iconUrl ?? null,
        docsUrl: provider.docsUrl ?? null,
        // Type-specific fields
        ...(provider.type === "apikey"
          ? {
              setupInstructions: provider.setupInstructions,
              secretSchema: z.toJSONSchema(provider.secretSchema),
            }
          : {}),
        ...(provider.type === "oauth"
          ? {
              oauthConfig:
                provider.oauthConfig.mode === "static"
                  ? {
                      mode: "static",
                      authorizationEndpoint: provider.oauthConfig.authorizationEndpoint,
                      tokenEndpoint: provider.oauthConfig.tokenEndpoint,
                      userinfoEndpoint: provider.oauthConfig.userinfoEndpoint,
                      clientAuthMethod: provider.oauthConfig.clientAuthMethod,
                      scopes: provider.oauthConfig.scopes,
                      extraAuthParams: provider.oauthConfig.extraAuthParams,
                      // OMIT clientId and clientSecret - these are secrets
                    }
                  : {
                      mode: "discovery",
                      serverUrl: provider.oauthConfig.serverUrl,
                      scopes: provider.oauthConfig.scopes,
                    },
            }
          : {}),
        ...(provider.type === "app_install"
          ? { platform: provider.platform, setupInstructions: provider.setupInstructions }
          : {}),
        supportsHealth:
          provider.type === "apikey" || provider.type === "oauth"
            ? typeof provider.health === "function"
            : provider.type === "app_install"
              ? typeof provider.healthCheck === "function"
              : false,
      },
      200,
    );
  });

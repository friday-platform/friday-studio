import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { factory } from "../factory.ts";
import { registry } from "../providers/registry.ts";
import { DynamicProviderInputSchema } from "../providers/types.ts";

/**
 * Provider catalog router.
 * Mounted at /v1/providers in main app.
 */
export const providersRouter = factory
  .createApp()
  .get("/", async (c) => {
    const allProviders = await registry.list();
    const providers = allProviders.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      description: p.description,
      iconUrl: p.iconUrl ?? null,
      docsUrl: p.docsUrl ?? null,
    }));
    return c.json({ providers });
  })
  .get("/:id", async (c) => {
    const { id } = c.req.param();
    const provider = await registry.get(id);

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
              oauthConfig: ((): Record<string, unknown> => {
                const c = provider.oauthConfig;
                if (c.mode === "static") {
                  return {
                    mode: "static",
                    authorizationEndpoint: c.authorizationEndpoint,
                    tokenEndpoint: c.tokenEndpoint,
                    userinfoEndpoint: c.userinfoEndpoint,
                    clientAuthMethod: c.clientAuthMethod,
                    scopes: c.scopes,
                    extraAuthParams: c.extraAuthParams,
                    // OMIT clientId and clientSecret - these are secrets
                  };
                }
                if (c.mode === "discovery") {
                  return { mode: "discovery", serverUrl: c.serverUrl, scopes: c.scopes };
                }
                // delegated
                return {
                  mode: "delegated",
                  authorizationEndpoint: c.authorizationEndpoint,
                  scopes: c.scopes,
                  extraAuthParams: c.extraAuthParams,
                  // OMIT clientId, delegatedExchangeUri, delegatedRefreshUri,
                  // encodeState — internal flow details not for public catalog.
                };
              })(),
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
  })
  .delete("/:id", async (c) => {
    const { id } = c.req.param();
    const deleted = await registry.deleteDynamicProvider(id);
    if (!deleted) {
      return c.json(
        { ok: false, error: `Provider "${id}" not found or is a built-in provider` },
        404,
      );
    }
    return c.json({ ok: true }, 200);
  })
  .post("/", zValidator("json", z.object({ provider: DynamicProviderInputSchema })), async (c) => {
    const { provider } = c.req.valid("json");

    // Atomic store - handles both static and dynamic conflict detection
    const stored = await registry.storeDynamicProvider(provider);
    if (!stored) {
      return c.json({ ok: false, error: `Provider "${provider.id}" already exists` }, 409);
    }

    return c.json(
      {
        ok: true,
        provider: { id: provider.id, type: provider.type, displayName: provider.displayName },
      },
      201,
    );
  });

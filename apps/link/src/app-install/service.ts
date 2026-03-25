/** App installation OAuth flows (Slack, GitHub). */

import { logger } from "@atlas/logger";
import {
  type PlatformRouteRepository,
  RouteOwnershipError,
} from "../adapters/platform-route-repository.ts";
import {
  AppInstallCredentialSecretSchema,
  type AppInstallProvider,
  type AppInstallResult,
  type ProviderDefinition,
} from "../providers/types.ts";
import type { Credential, StorageAdapter } from "../types.ts";
import { type AppInstallState, decodeAppInstallState, encodeAppInstallState } from "./app-state.ts";
import { AppInstallError } from "./errors.ts";

/** Minimal registry interface - service only needs get() */
type ProviderLookup = { get(id: string): Promise<ProviderDefinition | undefined> };

/** Orchestrates app installation flows: auth URL, token exchange, credential storage, routing. */
export class AppInstallService {
  constructor(
    private registry: ProviderLookup,
    private credentialStorage: StorageAdapter,
    private routeStorage: PlatformRouteRepository,
    private callbackBaseUrl: string, // From LINK_CALLBACK_BASE
    private log = logger,
  ) {}

  /** Generate authorization URL and encode state JWT for callback. */
  async initiateInstall(
    providerId: string,
    redirectUri?: string,
    userId?: string,
    credentialId?: string,
  ): Promise<{ authorizationUrl: string }> {
    const provider = await this.requireAppInstallProvider(providerId);
    const callbackUrl = `${this.callbackBaseUrl}/v1/callback/${providerId}`;

    const state = await encodeAppInstallState({
      p: providerId,
      r: redirectUri,
      u: userId,
      c: credentialId,
    });

    this.log.info("app_install_initiated", {
      provider: providerId,
      platform: provider.platform,
      userId,
      credentialId,
    });

    return {
      authorizationUrl: await provider.buildAuthorizationUrl(callbackUrl, state, { credentialId }),
    };
  }

  /**
   * Exchange authorization code for tokens, store credential, upsert platform route.
   * Routes to reinstall flow when no code but installation_id is present (GitHub).
   */
  async completeInstall(
    state: string,
    code: string | undefined,
    callbackParams?: URLSearchParams,
  ): Promise<{ credential: Credential; redirectUri?: string; updated: boolean }> {
    const decoded = await this.decodeState(state);
    const { p: providerId, r: redirectUri, u: userId, c: credentialId } = decoded;

    const provider = await this.requireAppInstallProvider(providerId);

    const callbackUrl = `${this.callbackBaseUrl}/v1/callback/${providerId}`;
    const uid = userId ?? "dev";

    if (credentialId || userId) {
      const params = callbackParams ?? new URLSearchParams();
      if (credentialId) params.set("credential_id", credentialId);
      if (userId) params.set("user_id", userId);
      callbackParams = params;
    }

    let result: AppInstallResult;
    if (!code) {
      const installationId = callbackParams?.get("installation_id") ?? "";
      if (provider.completeReinstallation && installationId) {
        const claimable = await this.routeStorage.isClaimable(installationId, uid);
        if (!claimable) {
          throw new AppInstallError(
            "INSTALLATION_OWNED",
            `Installation ${installationId} belongs to another user`,
          );
        }
        result = await provider.completeReinstallation(installationId);
      } else {
        // No reinstall path — let provider handle (throws approval_pending, missing_code, etc.)
        result = await provider.completeInstallation(code, callbackUrl, callbackParams);
      }
    } else {
      result = await provider.completeInstallation(code, callbackUrl, callbackParams);
    }

    const { credential, updated } = await this.persistInstallResult(result, userId, provider);

    this.log.info("app_install_completed", {
      provider: providerId,
      platform: provider.platform,
      externalId: result.externalId,
      externalName: result.externalName,
      credentialId: credential.id,
      updated,
      userId,
    });

    return { credential, redirectUri, updated };
  }

  /** Reconnect owned installations server-side. Returns null if unsupported or no owned routes. */
  async reconnect(providerId: string, userId?: string): Promise<Credential[] | null> {
    const provider = await this.requireAppInstallProvider(providerId);

    if (!provider.completeReinstallation) {
      return null;
    }

    const uid = userId ?? "dev";
    const ownedInstallationIds = await this.routeStorage.listByUser(uid, provider.platform);
    if (ownedInstallationIds.length === 0) {
      return null;
    }

    const credentials: Credential[] = [];
    for (const id of ownedInstallationIds) {
      try {
        const result = await provider.completeReinstallation(id);
        const { credential } = await this.persistInstallResult(result, userId, provider);
        credentials.push(credential);

        this.log.info("app_install_reconnected", {
          provider: providerId,
          platform: provider.platform,
          externalId: result.externalId,
          externalName: result.externalName,
          credentialId: credential.id,
          userId,
        });
      } catch (e) {
        if (e instanceof AppInstallError && e.code === "INSTALLATION_OWNED") {
          this.log.error("app_install_reconnect_ownership_conflict", {
            provider: providerId,
            installationId: id,
            userId,
            error: e,
          });
        } else {
          this.log.warn("app_install_reconnect_failed", {
            provider: providerId,
            installationId: id,
            error: e,
          });
        }
      }
    }

    return credentials.length > 0 ? credentials : null;
  }

  /** Decode and verify JWT state, throwing STATE_INVALID on failure. */
  private async decodeState(state: string): Promise<AppInstallState> {
    try {
      return await decodeAppInstallState(state);
    } catch {
      throw new AppInstallError("STATE_INVALID", "OAuth flow not found or expired");
    }
  }

  /** Upsert credential + route from an AppInstallResult. Returns saved credential and update flag. */
  private async persistInstallResult(
    result: AppInstallResult,
    userId: string | undefined,
    provider: AppInstallProvider,
  ): Promise<{ credential: Credential; updated: boolean }> {
    const uid = userId ?? "dev";
    const useRouteTable = provider.usesRouteTable !== false;

    if (useRouteTable) {
      const claimable = await this.routeStorage.isClaimable(result.externalId, uid);
      if (!claimable) {
        throw new AppInstallError(
          "INSTALLATION_OWNED",
          `Route ${result.externalId} is owned by another user`,
        );
      }
    }

    const existingCredential = await this.credentialStorage.findByProviderAndExternalId(
      result.credential.provider,
      result.externalId,
      uid,
    );

    let credentialId: string;
    let updated = false;

    if (existingCredential) {
      await this.credentialStorage.update(existingCredential.id, result.credential, uid);
      credentialId = existingCredential.id;
      updated = true;
    } else {
      const { id } = await this.credentialStorage.save(result.credential, uid);
      credentialId = id;
    }

    if (useRouteTable) {
      try {
        await this.routeStorage.upsert(result.externalId, uid, provider.platform);
      } catch (e) {
        if (e instanceof RouteOwnershipError) {
          throw new AppInstallError("INSTALLATION_OWNED", e.message);
        }
        throw e;
      }
    }

    const credential = await this.credentialStorage.get(credentialId, uid);
    if (!credential) {
      throw new AppInstallError("CREDENTIAL_NOT_FOUND", "Credential vanished after save");
    }

    return { credential, updated };
  }

  /** Re-create platform route from existing credential (idempotent recovery). */
  async reconcileRoute(providerId: string, credentialId: string, userId: string): Promise<void> {
    const provider = await this.requireAppInstallProvider(providerId);
    const credential = await this.credentialStorage.get(credentialId, userId);

    if (!credential || credential.provider !== providerId) {
      throw new AppInstallError(
        "CREDENTIAL_NOT_FOUND",
        "Credential not found or mismatched provider",
      );
    }

    const secretResult = AppInstallCredentialSecretSchema.safeParse(credential.secret);
    if (!secretResult.success) {
      throw new AppInstallError(
        "INVALID_CREDENTIAL",
        "Credential secret does not match expected schema",
      );
    }
    const secret = secretResult.data;
    if (!("externalId" in secret)) {
      throw new AppInstallError("INVALID_CREDENTIAL", "Credential secret missing externalId");
    }

    if (provider.usesRouteTable !== false) {
      try {
        await this.routeStorage.upsert(secret.externalId, userId, provider.platform);
      } catch (e) {
        if (e instanceof RouteOwnershipError) {
          throw new AppInstallError("INSTALLATION_OWNED", e.message);
        }
        throw e;
      }
    }

    this.log.info("app_install_route_reconciled", {
      provider: providerId,
      platform: provider.platform,
      externalId: secret.externalId,
      credentialId,
      userId,
    });
  }

  /** Uninstall app: delete route then credential. */
  async uninstall(providerId: string, credentialId: string, userId: string): Promise<void> {
    const provider = await this.requireAppInstallProvider(providerId);
    const credential = await this.credentialStorage.get(credentialId, userId);

    if (!credential) {
      this.log.warn("app_install_uninstall_not_found", { credentialId, userId });
      return; // Idempotent - already gone
    }

    if (credential.provider !== providerId) {
      throw new AppInstallError(
        "INVALID_PROVIDER_TYPE",
        `Credential provider mismatch: expected ${providerId}, got ${credential.provider}`,
      );
    }

    const secretResult = AppInstallCredentialSecretSchema.safeParse(credential.secret);
    if (!secretResult.success) {
      throw new AppInstallError("INVALID_CREDENTIAL", "Credential secret malformed");
    }
    if (!("externalId" in secretResult.data)) {
      throw new AppInstallError("INVALID_CREDENTIAL", "Credential secret missing externalId");
    }

    if (provider.usesRouteTable !== false) {
      await this.routeStorage.delete(secretResult.data.externalId, userId);
    }
    await this.credentialStorage.delete(credentialId, userId);

    this.log.info("app_install_uninstalled", {
      provider: providerId,
      platform: provider.platform,
      externalId: secretResult.data.externalId,
      credentialId,
      userId,
    });
  }

  private async requireAppInstallProvider(providerId: string): Promise<AppInstallProvider> {
    const provider = await this.registry.get(providerId);
    if (!provider) {
      throw new AppInstallError("PROVIDER_NOT_FOUND", `Provider not found: ${providerId}`);
    }
    if (provider.type !== "app_install") {
      throw new AppInstallError(
        "INVALID_PROVIDER_TYPE",
        `Provider is not app_install type: ${providerId}`,
      );
    }
    return provider;
  }
}

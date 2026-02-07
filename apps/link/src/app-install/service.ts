/**
 * AppInstallService
 * Main integration point for app installation OAuth flows (Slack, GitHub, Discord).
 *
 * @module app-install/service
 */

import { logger } from "@atlas/logger";
import type { PlatformRouteRepository } from "../adapters/platform-route-repository.ts";
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

/**
 * AppInstallService orchestrates app installation flows end-to-end.
 * Integrates authorization URL generation, token exchange, credential storage, and platform routing.
 */
export class AppInstallService {
  constructor(
    private registry: ProviderLookup,
    private credentialStorage: StorageAdapter,
    private routeStorage: PlatformRouteRepository,
    private callbackBaseUrl: string, // From LINK_CALLBACK_BASE
    private log = logger,
  ) {}

  /**
   * Initiate an app install flow.
   * Generates authorization URL and encodes state JWT for callback.
   *
   * @param providerId - Provider ID from registry
   * @param redirectUri - Optional user redirect after successful install
   * @param userId - User ID for multi-tenant credential storage
   * @returns Authorization URL to redirect user to
   * @throws {AppInstallError} If provider not found or not app_install type
   *
   * @example
   * ```ts
   * const { authorizationUrl } = await service.initiateInstall(
   *   "slack",
   *   "https://myapp.example.com/settings",
   *   "user-123"
   * );
   * // redirect user to authorizationUrl
   * ```
   */
  async initiateInstall(
    providerId: string,
    redirectUri?: string,
    userId?: string,
  ): Promise<{ authorizationUrl: string }> {
    const provider = await this.requireAppInstallProvider(providerId);
    // Provider-namespaced callback URL for readability (e.g., /v1/callback/slack)
    const callbackUrl = `${this.callbackBaseUrl}/v1/callback/${providerId}`;

    const state = await encodeAppInstallState({ p: providerId, r: redirectUri, u: userId });

    this.log.info("app_install_initiated", {
      provider: providerId,
      platform: provider.platform,
      userId,
    });

    return { authorizationUrl: provider.buildAuthorizationUrl(callbackUrl, state) };
  }

  /**
   * Complete an app install flow.
   * Exchanges authorization code for tokens, stores credential, and upserts platform route.
   * Handles idempotent re-install (updates existing credential instead of creating new).
   *
   * For providers that support reinstallation (e.g., GitHub), this method automatically
   * routes to the reinstall flow when no code is provided but installation_id is present.
   *
   * @param state - State parameter from OAuth callback
   * @param code - Authorization code from OAuth callback (optional for reinstall flows)
   * @param callbackParams - Additional callback parameters (e.g., installation_id)
   * @returns Credential, optional redirect URI, and update flag
   * @throws {AppInstallError} If state invalid/expired or installation fails
   *
   * @example
   * ```ts
   * const { credential, redirectUri, updated } = await service.completeInstall(state, code);
   * if (updated) {
   *   console.log(`Re-installed app into workspace`);
   * }
   * if (redirectUri) {
   *   // redirect user back to their app
   * }
   * ```
   */
  async completeInstall(
    state: string,
    code: string | undefined,
    callbackParams?: URLSearchParams,
  ): Promise<{ credential: Credential; redirectUri?: string; updated: boolean }> {
    // 1. Decode and verify JWT state
    const decoded = await this.decodeState(state);
    const { p: providerId, r: redirectUri, u: userId } = decoded;

    // 2. Get provider from registry
    const provider = await this.requireAppInstallProvider(providerId);

    // 3. Get install result — either reinstall (no code) or normal OAuth exchange
    const callbackUrl = `${this.callbackBaseUrl}/v1/callback/${providerId}`;
    let result: AppInstallResult;
    if (!code) {
      const installationId = Number(callbackParams?.get("installation_id"));
      if (provider.completeReinstallation && installationId > 0) {
        result = await provider.completeReinstallation(installationId);
      } else {
        // No reinstall path — let provider handle (throws approval_pending, missing_code, etc.)
        result = await provider.completeInstallation(code, callbackUrl, callbackParams);
      }
    } else {
      result = await provider.completeInstallation(code, callbackUrl, callbackParams);
    }

    // 4. Persist credential and route
    const { credential, updated } = await this.persistInstallResult(result, userId);

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

  /**
   * Attempt server-side reconnection for providers with existing installations.
   * Lists installation IDs via app-level auth, then completes reinstallation for each.
   * Returns null when provider doesn't support reconnection or has no installations.
   */
  async reconnect(providerId: string, userId?: string): Promise<Credential[] | null> {
    const provider = await this.requireAppInstallProvider(providerId);

    if (!provider.listInstallationIds || !provider.completeReinstallation) {
      return null;
    }

    const ids = await provider.listInstallationIds();
    if (ids.length === 0) {
      return null;
    }

    const credentials: Credential[] = [];
    for (const id of ids) {
      const result = await provider.completeReinstallation(id);
      const { credential } = await this.persistInstallResult(result, userId);
      credentials.push(credential);

      this.log.info("app_install_reconnected", {
        provider: providerId,
        platform: provider.platform,
        externalId: result.externalId,
        externalName: result.externalName,
        credentialId: credential.id,
        userId,
      });
    }

    return credentials;
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
  ): Promise<{ credential: Credential; updated: boolean }> {
    const uid = userId ?? "dev";

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

    await this.routeStorage.upsert(result.externalId, uid);

    const credential = await this.credentialStorage.get(credentialId, uid);
    if (!credential) {
      throw new AppInstallError("CREDENTIAL_NOT_FOUND", "Credential vanished after save");
    }

    return { credential, updated };
  }

  /**
   * Reconcile route for existing credential.
   * Idempotent recovery endpoint - re-creates route from credential data.
   * Used when platform_route entry is missing but credential exists.
   *
   * @param providerId - Provider ID from registry
   * @param credentialId - Credential ID to reconcile
   * @param userId - User ID for multi-tenant credential storage
   * @throws {AppInstallError} If credential not found or missing external ID
   *
   * @example
   * ```ts
   * await service.reconcileRoute("slack", "cred-123", "user-123");
   * console.log("Route reconciled - incoming events will now route correctly");
   * ```
   */
  async reconcileRoute(providerId: string, credentialId: string, userId: string): Promise<void> {
    const provider = await this.requireAppInstallProvider(providerId);
    const credential = await this.credentialStorage.get(credentialId, userId);

    if (!credential || credential.provider !== providerId) {
      throw new AppInstallError(
        "CREDENTIAL_NOT_FOUND",
        "Credential not found or mismatched provider",
      );
    }

    // Parse and validate credential secret
    const secretResult = AppInstallCredentialSecretSchema.safeParse(credential.secret);
    if (!secretResult.success) {
      throw new AppInstallError(
        "INVALID_CREDENTIAL",
        "Credential secret does not match expected schema",
      );
    }
    const secret = secretResult.data;

    // Upsert route (team_id → user_id)
    await this.routeStorage.upsert(secret.externalId, userId);

    this.log.info("app_install_route_reconciled", {
      provider: providerId,
      platform: provider.platform,
      externalId: secret.externalId,
      credentialId,
      userId,
    });
  }

  /**
   * Uninstall app installation. Deletes route AND credential.
   * @throws {AppInstallError} If credential not found or provider mismatch
   */
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

    // Get team_id from credential secret
    const secretResult = AppInstallCredentialSecretSchema.safeParse(credential.secret);
    if (!secretResult.success) {
      throw new AppInstallError("INVALID_CREDENTIAL", "Credential secret malformed");
    }

    // Delete route first (stops events), then credential
    await this.routeStorage.delete(secretResult.data.externalId, userId);
    await this.credentialStorage.delete(credentialId, userId);

    this.log.info("app_install_uninstalled", {
      provider: providerId,
      platform: provider.platform,
      externalId: secretResult.data.externalId,
      credentialId,
      userId,
    });
  }

  /**
   * Get app install provider from registry and validate type.
   * @throws {AppInstallError} If provider not found or not app_install type
   */
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

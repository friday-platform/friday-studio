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
  type ProviderDefinition,
} from "../providers/types.ts";
import type { Credential, StorageAdapter } from "../types.ts";
import { type AppInstallState, decodeAppInstallState, encodeAppInstallState } from "./app-state.ts";
import { AppInstallError } from "./errors.ts";

/** Minimal registry interface - service only needs get() */
type ProviderLookup = { get(id: string): ProviderDefinition | undefined };

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
    const provider = this.requireAppInstallProvider(providerId);
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
   * @param state - State parameter from OAuth callback
   * @param code - Authorization code from OAuth callback
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
    code: string,
  ): Promise<{ credential: Credential; redirectUri?: string; updated: boolean }> {
    // 1. Decode and verify JWT state
    let decoded: AppInstallState;
    try {
      decoded = await decodeAppInstallState(state);
    } catch {
      throw new AppInstallError("STATE_INVALID", "OAuth flow not found or expired");
    }

    const { p: providerId, r: redirectUri, u: userId } = decoded;

    // 2. Get provider from registry
    const provider = this.requireAppInstallProvider(providerId);
    // Provider-namespaced callback URL (must match what was used in initiateInstall)
    const callbackUrl = `${this.callbackBaseUrl}/v1/callback/${providerId}`;

    // 3. Exchange code for tokens and get workspace identity
    const result = await provider.completeInstallation(code, callbackUrl);

    // 4. Check for existing credential by externalId (re-install case)
    const existingCredential = await this.credentialStorage.findByProviderAndExternalId(
      result.credential.provider,
      result.externalId,
      userId ?? "dev",
    );

    let credentialId: string;
    let updated = false;

    if (existingCredential) {
      // Update existing credential instead of creating new
      await this.credentialStorage.update(
        existingCredential.id,
        result.credential,
        userId ?? "dev",
      );
      credentialId = existingCredential.id;
      updated = true;
    } else {
      // Create new credential
      const { id } = await this.credentialStorage.save(result.credential, userId ?? "dev");
      credentialId = id;
    }

    // 5. Upsert platform route (team_id → user_id)
    await this.routeStorage.upsert(result.externalId, userId ?? "dev");

    // 6. Fetch saved credential to return with metadata
    const credential = await this.credentialStorage.get(credentialId, userId ?? "dev");
    if (!credential) {
      throw new AppInstallError("CREDENTIAL_NOT_FOUND", "Credential vanished after save");
    }

    this.log.info("app_install_completed", {
      provider: providerId,
      platform: provider.platform,
      externalId: result.externalId,
      externalName: result.externalName,
      credentialId,
      updated,
      userId,
    });

    return { credential, redirectUri, updated };
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
    const provider = this.requireAppInstallProvider(providerId);
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
   * Get app install provider from registry and validate type.
   * @throws {AppInstallError} If provider not found or not app_install type
   */
  private requireAppInstallProvider(providerId: string): AppInstallProvider {
    const provider = this.registry.get(providerId);
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

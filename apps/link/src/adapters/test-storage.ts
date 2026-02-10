/**
 * In-memory test implementations for Link service storage.
 * Used by both service.test.ts and routes/app-install.test.ts.
 *
 * These are real implementations (Map-backed), not mock-framework artifacts.
 * They live alongside production adapters because they implement the same
 * interfaces with the same behavioral contracts.
 */

import { AppInstallCredentialSecretSchema } from "../providers/types.ts";
import type {
  Credential,
  CredentialInput,
  Metadata,
  SaveResult,
  StorageAdapter,
} from "../types.ts";
import { type PlatformRouteRepository, RouteOwnershipError } from "./platform-route-repository.ts";

export class TestStorageAdapter implements StorageAdapter {
  private credentials = new Map<string, Credential>();
  private idCounter = 0;

  save(input: CredentialInput, _userId: string): Promise<SaveResult> {
    const id = `cred-${++this.idCounter}`;
    const credential: Credential = {
      id,
      ...input,
      metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    };
    this.credentials.set(id, credential);
    return Promise.resolve({ id, metadata: credential.metadata });
  }

  update(id: string, input: CredentialInput, _userId: string) {
    const existing = this.credentials.get(id);
    if (!existing) return Promise.reject(new Error("Credential not found"));
    const updated: Credential = {
      ...existing,
      ...input,
      id,
      metadata: { ...existing.metadata, updatedAt: new Date().toISOString() },
    };
    this.credentials.set(id, updated);
    return Promise.resolve(updated.metadata);
  }

  get(id: string, _userId: string): Promise<Credential | null> {
    return Promise.resolve(this.credentials.get(id) ?? null);
  }

  list(type: string, _userId: string) {
    return Promise.resolve(
      Array.from(this.credentials.values())
        .filter((c) => c.type === type)
        .map((c) => ({
          id: c.id,
          type: c.type,
          provider: c.provider,
          label: c.label,
          metadata: c.metadata,
        })),
    );
  }

  delete(id: string, _userId: string) {
    this.credentials.delete(id);
    return Promise.resolve();
  }

  findByProviderAndExternalId(
    provider: string,
    externalId: string,
    _userId: string,
  ): Promise<Credential | null> {
    for (const cred of this.credentials.values()) {
      if (cred.provider === provider) {
        const parsed = AppInstallCredentialSecretSchema.safeParse(cred.secret);
        if (parsed.success && parsed.data.externalId === externalId) {
          return Promise.resolve(cred);
        }
      }
    }
    return Promise.resolve(null);
  }

  // Not used by service - stub to satisfy interface
  upsert(): Promise<SaveResult> {
    throw new Error("TestStorageAdapter.upsert() should not be called");
  }
  updateMetadata(): Promise<Metadata> {
    throw new Error("TestStorageAdapter.updateMetadata() should not be called");
  }
}

export class TestPlatformRouteRepository implements PlatformRouteRepository {
  private routes = new Map<string, { userId: string; platform: string }>();

  upsert(teamId: string, userId: string, platform: string): Promise<void> {
    const existing = this.routes.get(teamId);
    // Mimic Postgres: only update if same owner or unclaimed
    if (existing && existing.userId !== userId) {
      return Promise.reject(new RouteOwnershipError(teamId));
    }
    this.routes.set(teamId, { userId, platform });
    return Promise.resolve();
  }

  delete(teamId: string, userId: string): Promise<void> {
    const existing = this.routes.get(teamId);
    if (existing && existing.userId !== userId) return Promise.resolve();
    this.routes.delete(teamId);
    return Promise.resolve();
  }

  isClaimable(teamId: string, userId: string): Promise<boolean> {
    const existing = this.routes.get(teamId);
    return Promise.resolve(!existing || existing.userId === userId);
  }

  listByUser(userId: string, platform?: string): Promise<string[]> {
    const ids: string[] = [];
    for (const [teamId, route] of this.routes) {
      if (route.userId === userId && (!platform || route.platform === platform)) {
        ids.push(teamId);
      }
    }
    return Promise.resolve(ids);
  }

  /** Test helper - get route owner for assertions */
  getRoute(teamId: string): string | undefined {
    return this.routes.get(teamId)?.userId;
  }

  /** Test helper - seed a route */
  seedRoute(teamId: string, userId: string, platform = "slack"): void {
    this.routes.set(teamId, { userId, platform });
  }
}

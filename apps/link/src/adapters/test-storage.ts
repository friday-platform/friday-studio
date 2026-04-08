import { AppInstallCredentialSecretSchema } from "../providers/types.ts";
import type {
  Credential,
  CredentialInput,
  Metadata,
  SaveResult,
  StorageAdapter,
} from "../types.ts";
import { type PlatformRouteRepository, RouteOwnershipError } from "./platform-route-repository.ts";
import type { SlackAppWorkspaceRepository } from "./slack-app-workspace-repository.ts";

export class TestStorageAdapter implements StorageAdapter {
  private credentials = new Map<string, Credential>();
  private idCounter = 0;

  /** Check if a provider already has a default credential among active entries. */
  private hasDefaultForProvider(provider: string): boolean {
    for (const cred of this.credentials.values()) {
      if (cred.provider === provider && cred.isDefault) return true;
    }
    return false;
  }

  save(input: CredentialInput, _userId: string): Promise<SaveResult> {
    const id = `cred-${++this.idCounter}`;
    const isDefault = !this.hasDefaultForProvider(input.provider);
    const credential: Credential = {
      id,
      ...input,
      isDefault,
      metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    };
    this.credentials.set(id, credential);
    return Promise.resolve({ id, isDefault, metadata: credential.metadata });
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
          isDefault: c.isDefault,
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
        if (
          parsed.success &&
          "externalId" in parsed.data &&
          parsed.data.externalId === externalId
        ) {
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
  updateMetadata(
    id: string,
    metadata: { displayName?: string },
    _userId: string,
  ): Promise<Metadata> {
    const cred = this.credentials.get(id);
    if (!cred) return Promise.reject(new Error("Credential not found"));
    if (metadata.displayName !== undefined) {
      cred.displayName = metadata.displayName;
    }
    cred.metadata.updatedAt = new Date().toISOString();
    return Promise.resolve(cred.metadata);
  }
  setDefault(id: string, _userId: string): Promise<void> {
    const target = this.credentials.get(id);
    if (!target) return Promise.reject(new Error("Credential not found"));
    // Clear old default for this provider
    for (const cred of this.credentials.values()) {
      if (cred.provider === target.provider && cred.isDefault) {
        cred.isDefault = false;
      }
    }
    target.isDefault = true;
    return Promise.resolve();
  }
  getDefaultByProvider(provider: string, _userId: string): Promise<Credential | null> {
    for (const cred of this.credentials.values()) {
      if (cred.provider === provider && cred.isDefault) return Promise.resolve(cred);
    }
    return Promise.resolve(null);
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

/**
 * In-memory implementation that mirrors the RLS-enforced Postgres adapter:
 * every query is scoped by `userId`, and rows carry a user_id so tests can
 * exercise per-user isolation the same way production would.
 */
export class TestSlackAppWorkspaceRepository implements SlackAppWorkspaceRepository {
  private mappings = new Map<string, { workspaceId: string; userId: string }>();

  insert(credentialId: string, workspaceId: string, userId: string): Promise<void> {
    // Enforce per-user 1:1 (user_id, workspace_id). Mimics the unique index
    // added by 20260408000000_add_user_id_to_slack_app_workspace.sql.
    for (const [cid, entry] of this.mappings) {
      if (entry.userId === userId && entry.workspaceId === workspaceId && cid !== credentialId) {
        this.mappings.delete(cid);
      }
    }
    this.mappings.set(credentialId, { workspaceId, userId });
    return Promise.resolve();
  }

  deleteByCredentialId(credentialId: string, userId: string): Promise<void> {
    const entry = this.mappings.get(credentialId);
    if (entry && entry.userId === userId) {
      this.mappings.delete(credentialId);
    }
    return Promise.resolve();
  }

  findByWorkspaceId(workspaceId: string, userId: string): Promise<{ credentialId: string } | null> {
    for (const [credentialId, entry] of this.mappings) {
      if (entry.workspaceId === workspaceId && entry.userId === userId) {
        return Promise.resolve({ credentialId });
      }
    }
    return Promise.resolve(null);
  }

  findByCredentialId(
    credentialId: string,
    userId: string,
  ): Promise<{ workspaceId: string } | null> {
    const entry = this.mappings.get(credentialId);
    if (!entry || entry.userId !== userId) return Promise.resolve(null);
    return Promise.resolve({ workspaceId: entry.workspaceId });
  }

  /** Test helper — returns the stored workspace regardless of user. */
  getWorkspace(credentialId: string): string | undefined {
    return this.mappings.get(credentialId)?.workspaceId;
  }
}

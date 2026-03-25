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
import type { WebhookSecretRepository } from "./webhook-secret-repository.ts";

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

export class TestWebhookSecretRepository implements WebhookSecretRepository {
  private secrets = new Map<string, { userId: string; signingSecret: string }>();

  insert(appId: string, userId: string, signingSecret: string): Promise<void> {
    // Mimic ON CONFLICT DO UPDATE — always upsert
    this.secrets.set(appId, { userId, signingSecret });
    return Promise.resolve();
  }

  delete(appId: string): Promise<void> {
    this.secrets.delete(appId);
    return Promise.resolve();
  }

  /** Test helper - get stored secret for assertions */
  getSecret(appId: string): { userId: string; signingSecret: string } | undefined {
    return this.secrets.get(appId);
  }
}

export class TestSlackAppWorkspaceRepository implements SlackAppWorkspaceRepository {
  private mappings = new Map<string, string>(); // credentialId → workspaceId

  insert(credentialId: string, workspaceId: string): Promise<void> {
    this.mappings.set(credentialId, workspaceId);
    return Promise.resolve();
  }

  deleteByCredentialId(credentialId: string): Promise<void> {
    this.mappings.delete(credentialId);
    return Promise.resolve();
  }

  findByWorkspaceId(workspaceId: string): Promise<{ credentialId: string } | null> {
    for (const [credentialId, wsId] of this.mappings) {
      if (wsId === workspaceId) return Promise.resolve({ credentialId });
    }
    return Promise.resolve(null);
  }

  findByCredentialId(credentialId: string): Promise<{ workspaceId: string } | null> {
    const wsId = this.mappings.get(credentialId);
    if (!wsId) return Promise.resolve(null);
    return Promise.resolve({ workspaceId: wsId });
  }

  /** Test helper - get workspace for a credential */
  getWorkspace(credentialId: string): string | undefined {
    return this.mappings.get(credentialId);
  }
}

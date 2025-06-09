import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { ProviderCredentials, ProviderState } from "./types.ts";

export interface ProviderStateData {
  providers: Record<string, ProviderState>;
  lastUpdated: Date;
}

export class ProviderStateManager {
  private workspaceId: string;
  private statePath: string;
  private state: ProviderStateData;

  constructor(workspaceId: string, atlasDir: string = ".atlas") {
    this.workspaceId = workspaceId;
    this.statePath = join(atlasDir, "provider-state.json");
    this.state = {
      providers: {},
      lastUpdated: new Date(),
    };
  }

  async load(): Promise<void> {
    try {
      const data = await Deno.readTextFile(this.statePath);
      const parsed = JSON.parse(data);

      // Convert date strings back to Date objects
      this.state = {
        providers: parsed.providers,
        lastUpdated: new Date(parsed.lastUpdated),
      };

      // Convert lastHealthCheck dates
      for (const providerId in this.state.providers) {
        const provider = this.state.providers[providerId];
        if (provider.lastHealthCheck) {
          provider.lastHealthCheck = new Date(provider.lastHealthCheck as any);
        }
      }

      console.log(
        `[ProviderStateManager] Loaded state for ${
          Object.keys(this.state.providers).length
        } providers`,
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        console.log(
          "[ProviderStateManager] No existing state file, starting fresh",
        );
      } else {
        console.error("[ProviderStateManager] Error loading state:", error);
      }
    }
  }

  async save(): Promise<void> {
    try {
      await ensureDir(join(".", ".atlas"));

      this.state.lastUpdated = new Date();
      await Deno.writeTextFile(
        this.statePath,
        JSON.stringify(this.state, null, 2),
      );

      console.log("[ProviderStateManager] State saved");
    } catch (error) {
      console.error("[ProviderStateManager] Error saving state:", error);
      throw error;
    }
  }

  getProviderState(providerId: string): ProviderState | undefined {
    return this.state.providers[providerId];
  }

  setProviderState(providerId: string, state: ProviderState): void {
    this.state.providers[providerId] = state;
  }

  // Secure credential storage (in production, use OS keychain)
  async storeCredentials(
    providerId: string,
    credentials: ProviderCredentials,
  ): Promise<void> {
    // For now, store in a separate encrypted file
    const credPath = join(".atlas", `${providerId}-credentials.enc`);

    // TODO: Implement proper encryption
    // For development, just store as JSON with warning
    const warning =
      "WARNING: Credentials stored in plain text. Use proper encryption in production!";

    await Deno.writeTextFile(
      credPath,
      JSON.stringify(
        {
          warning,
          credentials,
        },
        null,
        2,
      ),
    );
  }

  async loadCredentials(
    providerId: string,
  ): Promise<ProviderCredentials | undefined> {
    try {
      const credPath = join(".atlas", `${providerId}-credentials.enc`);
      const data = await Deno.readTextFile(credPath);
      const parsed = JSON.parse(data);
      return parsed.credentials;
    } catch {
      return undefined;
    }
  }

  async deleteCredentials(providerId: string): Promise<void> {
    try {
      const credPath = join(".atlas", `${providerId}-credentials.enc`);
      await Deno.remove(credPath);
    } catch {
      // Ignore if doesn't exist
    }
  }
}

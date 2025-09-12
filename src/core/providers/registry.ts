import { PROVIDER_CLASSES } from "@atlas/signals";
import type { IProvider, IProviderRegistry, ProviderConfig, ProviderType } from "./types.ts";

export class ProviderRegistry implements IProviderRegistry {
  private static instance: ProviderRegistry;
  private providers: Map<string, IProvider> = new Map();
  private factories: Map<string, (config: ProviderConfig) => Promise<IProvider>> = new Map();

  private constructor() {}

  static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  register(provider: IProvider): void {
    this.providers.set(provider.id, provider);
    console.log(`[ProviderRegistry] Registered provider: ${provider.id} (${provider.type})`);
  }

  get(id: string): IProvider | undefined {
    return this.providers.get(id);
  }

  getByType(type: ProviderType): IProvider[] {
    return Array.from(this.providers.values()).filter((p) => p.type === type);
  }

  registerFactory(
    providerId: string,
    factory: (config: ProviderConfig) => Promise<IProvider>,
  ): void {
    this.factories.set(providerId, factory);
  }

  async loadFromConfig(config: ProviderConfig): Promise<IProvider> {
    // Check if already loaded
    const existing = this.providers.get(config.id);
    if (existing) {
      return existing;
    }

    // Get provider class from static map
    const ProviderClass = PROVIDER_CLASSES[config.provider];
    if (!ProviderClass) {
      throw new Error(`No provider registered for type: ${config.provider}`);
    }

    // Create and register provider
    const provider = this.createProviderInstance(ProviderClass, config);
    this.register(provider);

    return provider;
  }

  private createProviderInstance(ProviderClass: unknown, config: ProviderConfig): IProvider {
    // Preserve existing configuration transformation logic
    switch (config.provider) {
      case "http":
        return new ProviderClass({
          id: config.id,
          description: config.config?.description || `HTTP signal for ${config.id}`,
          provider: "http" as const,
          path: config.config?.path,
          method: config.config?.method,
        });

      case "timer":
      case "schedule":
      case "cron":
      case "cron-scheduler":
        return new ProviderClass({
          id: config.id,
          description: config.config?.description || `Timer signal for ${config.id}`,
          provider: config.provider,
          schedule: config.config?.schedule,
          timezone: config.config?.timezone,
        });

      case "cli":
        return new ProviderClass({
          id: config.id,
          description: config.config?.description || `CLI signal for ${config.id}`,
          provider: "cli" as const,
          command: config.config?.command,
          args: config.config?.args,
          flags: config.config?.flags,
        });

      case "fs-watch":
        return new ProviderClass({
          id: config.id,
          description: config.config?.description || `File watch signal for ${config.id}`,
          provider: "fs-watch" as const,
          path: config.config?.path,
          recursive: config.config?.recursive,
        });

      default:
        return new ProviderClass(config);
    }
  }
}

import { logger } from "@atlas/logger";
import {
  type FileWatchSignalConfig,
  FileWatchSignalProvider,
  type HTTPSignalConfig,
  HTTPSignalProvider,
} from "@atlas/signals";
import type { MaybePromise } from "@atlas/utils";
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
    logger.info("Registered provider", { providerId: provider.id, providerType: provider.type });
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

  loadFromConfig(config: ProviderConfig): MaybePromise<IProvider> {
    // Check if already loaded
    const existing = this.providers.get(config.id);
    if (existing) {
      return existing;
    }

    // Create and register provider
    const provider = this.createProviderInstance(config);
    this.register(provider);

    return provider;
  }

  /**
   * @FIXME
   * This function currently does a weird cross between static and dynamic registration
   * of signal providers. Right now ProviderConfig is a Record<string, unknown> base
   * implementation. What we need to do to address this on a type level is to turn
   * ProviderConfig into a tagged union based on the `provider` field.
   *
   * Longer-term, this should be a complete registry like the Agent server, where configuration
   * is encapsulated within the signal provider itself. Since these are already classes,
   * there really is no reason for them to be separate.
   */
  private createProviderInstance(config: ProviderConfig): IProvider {
    // Preserve existing configuration transformation logic
    switch (config.provider) {
      case "http": {
        const cfg: HTTPSignalConfig = config.config as HTTPSignalConfig;
        return new HTTPSignalProvider(cfg);
      }

      case "fs-watch": {
        const cfg: FileWatchSignalConfig = config.config as FileWatchSignalConfig;
        return new FileWatchSignalProvider(cfg);
      }
      default:
        throw new Error("Unknown signal provider");
    }
  }
}

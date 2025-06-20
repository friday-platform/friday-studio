import type { IProvider, IProviderRegistry, ProviderConfig, ProviderType } from "./types.ts";

export class ProviderRegistry implements IProviderRegistry {
  private static instance: ProviderRegistry;
  private providers: Map<string, IProvider> = new Map();
  private factories: Map<
    string,
    (config: ProviderConfig) => Promise<IProvider>
  > = new Map();

  private constructor() {}

  static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  register(provider: IProvider): void {
    this.providers.set(provider.id, provider);
    console.log(
      `[ProviderRegistry] Registered provider: ${provider.id} (${provider.type})`,
    );
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

    // Get factory
    const factory = this.factories.get(config.provider);
    if (!factory) {
      throw new Error(`No factory registered for provider: ${config.provider}`);
    }

    // Create and register provider
    const provider = await factory(config);
    this.register(provider);

    return provider;
  }

  // Built-in provider factories
  static registerBuiltinProviders() {
    const registry = ProviderRegistry.getInstance();

    // Register built-in signal providers
    registry.registerFactory("http", async (config) => {
      const { HTTPSignalProvider } = await import("./builtin/http-signal.ts");
      
      // Transform ProviderConfig to HTTPSignalConfig
      const httpConfig = {
        id: config.id,
        description: config.config?.description || `HTTP signal for ${config.id}`,
        provider: "http" as const,
        path: config.config?.path,
        method: config.config?.method
      };
      
      return new HTTPSignalProvider(httpConfig);
    });

    registry.registerFactory("http-webhook", async (config) => {
      const { HttpWebhookProvider } = await import("./builtin/http-webhook.ts");
      return new HttpWebhookProvider(config);
    });

    registry.registerFactory("timer", async (config) => {
      const { TimerSignalProvider } = await import("./builtin/timer-signal.ts");
      return new TimerSignalProvider(config);
    });

    registry.registerFactory("stream", async (_config) => {
      const { StreamSignalProvider } = await import("./builtin/stream-signal.ts");
      return new StreamSignalProvider();
    });

    registry.registerFactory("k8s-events", async (config) => {
      const { K8sEventsSignalProvider } = await import("./builtin/k8s-events.ts");
      return new K8sEventsSignalProvider();
    });

    // Register built-in agent providers
    registry.registerFactory("anthropic", async (config) => {
      const { AnthropicAgentProvider } = await import(
        "./builtin/anthropic-agent.ts"
      );
      return new AnthropicAgentProvider(config);
    });

    registry.registerFactory("openai", async (config) => {
      const { OpenAIAgentProvider } = await import("./builtin/openai-agent.ts");
      return new OpenAIAgentProvider(config);
    });
  }
}

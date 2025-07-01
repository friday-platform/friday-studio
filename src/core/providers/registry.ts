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
        method: config.config?.method,
      };

      return new HTTPSignalProvider(httpConfig);
    });

    registry.registerFactory("http-webhook", async (config) => {
      const { HttpWebhookProvider } = await import("./builtin/http-webhook.ts");
      return new HttpWebhookProvider(config);
    });

    // Timer/Cron signal providers (all variants use the same implementation)
    const createTimerProvider = async (config: ProviderConfig) => {
      const { TimerSignalProvider } = await import("./builtin/timer-signal.ts");

      // Transform ProviderConfig to TimerSignalConfig
      const timerConfig = {
        id: config.id,
        description: config.config?.description || `Timer signal for ${config.id}`,
        provider: config.provider as "timer" | "schedule" | "cron" | "cron-scheduler",
        schedule: config.config?.schedule,
        timezone: config.config?.timezone,
      };

      return new TimerSignalProvider(timerConfig);
    };

    registry.registerFactory("timer", createTimerProvider);
    registry.registerFactory("schedule", createTimerProvider);
    registry.registerFactory("cron", createTimerProvider);
    registry.registerFactory("cron-scheduler", createTimerProvider);

    registry.registerFactory("stream", async (_config) => {
      const { StreamSignalProvider } = await import("./builtin/stream-signal.ts");
      return new StreamSignalProvider();
    });

    registry.registerFactory("k8s-events", async (_config) => {
      const { K8sEventsSignalProvider } = await import("./builtin/k8s-events.ts");
      return new K8sEventsSignalProvider();
    });

    registry.registerFactory("cli", async (config) => {
      const { CliSignalProvider } = await import("./builtin/cli-signal.ts");

      // Transform ProviderConfig to CliSignalConfig
      const cliConfig = {
        id: config.id,
        description: config.config?.description || `CLI signal for ${config.id}`,
        provider: "cli" as const,
        command: config.config?.command,
        args: config.config?.args,
        flags: config.config?.flags,
      };

      return new CliSignalProvider(cliConfig);
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

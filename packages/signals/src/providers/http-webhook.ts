import { AtlasScope } from "../../../../src/core/scope.ts";
import type { IWorkspaceSignal } from "../../../../src/types/core.ts";
import type {
  HealthStatus,
  IProviderSignal,
  ISignalProvider,
  ProviderConfig,
  ProviderState,
} from "./types.ts";
import { ProviderStatus, ProviderType } from "./types.ts";

interface HttpWebhookConfig extends Record<string, unknown> {
  endpoint: string;
}

export class HttpWebhookProvider implements ISignalProvider {
  id: string;
  readonly type = ProviderType.SIGNAL;
  name = "HTTP Webhook Provider";
  version = "1.0.0";

  private state: ProviderState;
  private config: HttpWebhookConfig;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    const providerConfig = (config.config || {}) as HttpWebhookConfig;
    this.config = providerConfig;
    this.state = { status: ProviderStatus.NOT_CONFIGURED };
  }

  setup(): Promise<void> {
    console.log(`[HttpWebhookProvider] Setting up ${this.id}`);

    try {
      // Validate config
      if (!this.config.endpoint) {
        throw new Error("Endpoint is required for HTTP webhook provider");
      }

      this.state.status = ProviderStatus.READY;
      this.state.config = this.config;
    } catch (error) {
      this.state.status = ProviderStatus.ERROR;
      this.state.error = error instanceof Error ? error.message : String(error);
      throw error;
    }

    return Promise.resolve();
  }

  teardown(): Promise<void> {
    console.log(`[HttpWebhookProvider] Tearing down ${this.id}`);
    this.state.status = ProviderStatus.DISABLED;
    return Promise.resolve();
  }

  getState(): ProviderState {
    return { ...this.state };
  }

  checkHealth(): Promise<HealthStatus> {
    const health: HealthStatus = {
      healthy: this.state.status === ProviderStatus.READY,
      lastCheck: new Date(),
      message:
        this.state.status === ProviderStatus.READY
          ? "Webhook endpoint ready"
          : `Provider status: ${this.state.status}`,
    };

    this.state.lastHealthCheck = health.lastCheck;

    return Promise.resolve(health);
  }

  createSignal(config: unknown): IProviderSignal {
    return new HttpWebhookSignal(this.id, config);
  }
}

interface HttpWebhookSignalConfig extends Record<string, unknown> {
  id: string;
}

class HttpWebhookSignal implements IProviderSignal {
  id: string;
  providerId: string;
  config: Record<string, unknown>;

  constructor(providerId: string, config: unknown) {
    const signalConfig = config as HttpWebhookSignalConfig;
    this.id = signalConfig.id;
    this.providerId = providerId;
    this.config = signalConfig;
  }

  validate(): boolean {
    return !!this.id && !!this.config;
  }

  toRuntimeSignal(): IWorkspaceSignal {
    // Create a runtime signal that can be used by the workspace
    return new HttpWebhookRuntimeSignal(this);
  }
}

class HttpWebhookRuntimeSignal extends AtlasScope implements IWorkspaceSignal {
  provider: { id: string; name: string };
  private signalConfig: IProviderSignal;

  constructor(signalConfig: IProviderSignal) {
    super({ id: signalConfig.id });
    this.signalConfig = signalConfig;
    this.provider = { id: signalConfig.providerId, name: "HTTP Webhook" };
  }

  trigger(): Promise<void> {
    console.log(`[HttpWebhook] Signal ${this.id} triggered`);
    // In a real implementation, this would handle the webhook payload
    return Promise.resolve();
  }

  configure(config: unknown): void {
    Object.assign(this.signalConfig.config, config);
  }
}

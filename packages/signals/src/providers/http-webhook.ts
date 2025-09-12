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

export class HttpWebhookProvider implements ISignalProvider {
  id: string;
  readonly type = ProviderType.SIGNAL;
  name = "HTTP Webhook Provider";
  version = "1.0.0";

  private state: ProviderState;
  private config: unknown;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.config = config.config || {};
    this.state = { status: ProviderStatus.NOT_CONFIGURED };
  }

  async setup(): Promise<void> {
    // TODO: Keep async for IProvider interface compliance, even though no await is used
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
  }

  async teardown(): Promise<void> {
    // TODO: Keep async for IProvider interface compliance, even though no await is used
    console.log(`[HttpWebhookProvider] Tearing down ${this.id}`);
    this.state.status = ProviderStatus.DISABLED;
  }

  getState(): ProviderState {
    return { ...this.state };
  }

  async checkHealth(): Promise<HealthStatus> {
    // TODO: Keep async for IProvider interface compliance, even though no await is used
    const health: HealthStatus = {
      healthy: this.state.status === ProviderStatus.READY,
      lastCheck: new Date(),
      message:
        this.state.status === ProviderStatus.READY
          ? "Webhook endpoint ready"
          : `Provider status: ${this.state.status}`,
    };

    this.state.lastHealthCheck = health.lastCheck;

    return health;
  }

  createSignal(config: unknown): IProviderSignal {
    return new HttpWebhookSignal(this.id, config);
  }
}

class HttpWebhookSignal implements IProviderSignal {
  id: string;
  providerId: string;
  config: Record<string, unknown>;

  constructor(providerId: string, config: unknown) {
    this.id = config.id;
    this.providerId = providerId;
    this.config = config;
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
    super();
    this.signalConfig = signalConfig;
    this.id = signalConfig.id;
    this.provider = { id: signalConfig.providerId, name: "HTTP Webhook" };
  }

  async trigger(): Promise<void> {
    // TODO: Keep async for future extensibility, even though no await is used currently
    console.log(`[HttpWebhook] Signal ${this.id} triggered`);
    // In a real implementation, this would handle the webhook payload
  }

  configure(config: unknown): void {
    Object.assign(this.signalConfig.config, config);
  }
}

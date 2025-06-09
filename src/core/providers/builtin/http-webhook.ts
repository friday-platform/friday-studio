import type { 
  ISignalProvider, 
  IProvider,
  ProviderState, 
  HealthStatus,
  IProviderSignal,
  ProviderConfig
} from "../types.ts";
import { ProviderStatus, ProviderType } from "../types.ts";
import { AtlasScope } from "../../scope.ts";
import type { IWorkspaceSignal } from "../../../types/core.ts";

export class HttpWebhookProvider implements ISignalProvider {
  id: string;
  type = ProviderType.SIGNAL;
  name = "HTTP Webhook Provider";
  version = "1.0.0";
  
  private state: ProviderState;
  private config: any;
  
  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.config = config.config || {};
    this.state = {
      status: ProviderStatus.NOT_CONFIGURED
    };
  }
  
  async setup(): Promise<void> {
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
    console.log(`[HttpWebhookProvider] Tearing down ${this.id}`);
    this.state.status = ProviderStatus.DISABLED;
  }
  
  getState(): ProviderState {
    return { ...this.state };
  }
  
  async checkHealth(): Promise<HealthStatus> {
    const health: HealthStatus = {
      healthy: this.state.status === ProviderStatus.READY,
      lastCheck: new Date(),
      message: this.state.status === ProviderStatus.READY 
        ? "Webhook endpoint ready" 
        : `Provider status: ${this.state.status}`
    };
    
    this.state.lastHealthCheck = health.lastCheck;
    
    return health;
  }
  
  createSignal(config: any): IProviderSignal {
    return new HttpWebhookSignal(this.id, config);
  }
}

class HttpWebhookSignal implements IProviderSignal {
  id: string;
  providerId: string;
  config: Record<string, any>;
  
  constructor(providerId: string, config: any) {
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
    (this as any).id = signalConfig.id;
    this.provider = {
      id: signalConfig.providerId,
      name: "HTTP Webhook"
    };
  }
  
  async trigger(): Promise<void> {
    console.log(`[HttpWebhook] Signal ${this.id} triggered`);
    // In a real implementation, this would handle the webhook payload
  }
  
  configure(config: any): void {
    Object.assign(this.signalConfig.config, config);
  }
}
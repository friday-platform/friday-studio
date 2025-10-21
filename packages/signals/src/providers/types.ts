/**
 * Provider system for loading and managing external integrations
 */

export interface IProvider {
  id: string;
  type: ProviderType;
  name: string;
  version: string;

  // Lifecycle methods
  setup(): void;
  teardown(): void;

  // State methods
  getState(): ProviderState;
  checkHealth(): Promise<HealthStatus>;
}

export enum ProviderType {
  SIGNAL = "signal",
  AGENT = "agent",
}

export interface ProviderState {
  status: ProviderStatus;
  credentials?: ProviderCredentials;
  config?: Record<string, unknown>;
  lastHealthCheck?: Date;
  error?: string;
}

export enum ProviderStatus {
  NOT_CONFIGURED = "not_configured",
  READY = "ready",
  DISABLED = "disabled",
}

export interface ProviderCredentials {
  // Base interface - providers extend this
  type: string;
  isValid(): boolean;
}

export interface HealthStatus {
  healthy: boolean;
  message?: string;
  lastCheck: Date;
  details?: Record<string, unknown>;
}

export interface ISignalProvider extends IProvider {
  type: ProviderType.SIGNAL;
  createSignal(config: unknown): IProviderSignal;
}

export interface IAgentProvider extends IProvider {
  type: ProviderType.AGENT;
  createAgent(config: unknown): Promise<unknown>;
  getSupportedModels?(): string[];
}

// Provider-based signal that can be serialized
export interface IProviderSignal {
  id: string;
  providerId: string;
  config: Record<string, unknown>;

  // Methods that will be called by runtime
  validate(): boolean;
  toRuntimeSignal(): unknown; // Converts to IWorkspaceSignal
}

// Provider registry
export interface IProviderRegistry {
  register(provider: IProvider): void;
  get(id: string): IProvider | undefined;
  getByType(type: ProviderType): IProvider[];
  loadFromConfig(config: ProviderConfig): Promise<IProvider>;
}

// Serializable provider config
export interface ProviderConfig {
  id: string;
  type: ProviderType;
  provider: string; // e.g., "github", "anthropic", "openai"
  config?: Record<string, unknown>;
}

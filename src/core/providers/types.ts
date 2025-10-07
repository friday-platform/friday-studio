/**
 * Provider system for loading and managing external integrations
 */

import type { ProviderTypeKeys } from "@atlas/signals";
import type { MaybePromise } from "@atlas/utils";

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
  WORKFLOW = "workflow",
  SOURCE = "source",
  ACTION = "action",
}

interface ProviderState {
  status: ProviderStatus;
  credentials?: ProviderCredentials;
  config?: Record<string, unknown>;
  lastHealthCheck?: Date;
  error?: string;
}

enum ProviderStatus {
  NOT_CONFIGURED = "not_configured",
  CONFIGURING = "configuring",
  READY = "ready",
  ERROR = "error",
  DISABLED = "disabled",
}

interface ProviderCredentials {
  // Base interface - providers extend this
  type: string;
  isValid(): boolean;
}

interface HealthStatus {
  healthy: boolean;
  message?: string;
  lastCheck: Date;
  details?: Record<string, unknown>;
}

// Provider registry
export interface IProviderRegistry {
  register(provider: IProvider): void;
  get(id: string): IProvider | undefined;
  getByType(type: ProviderType): IProvider[];
  loadFromConfig(config: ProviderConfig): MaybePromise<IProvider>;
}

// Serializable provider config
export interface ProviderConfig {
  id: string;
  type: ProviderType;
  provider: ProviderTypeKeys; // e.g., "github", "anthropic", "openai"
  config: Record<string, unknown>;
}

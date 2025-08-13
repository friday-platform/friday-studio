/**
 * CLI Signal Provider - Built-in provider for command-line triggered signals
 * Handles CLI signals with configurable commands, arguments, and flags
 */

import type { HealthStatus, IProvider, ProviderState } from "./types.ts";
import { ProviderStatus, ProviderType } from "./types.ts";

export interface CliSignalConfig {
  id: string;
  description: string;
  provider: "cli";
  command: string;
  args?: string[];
  flags?: Record<string, string | number | boolean>;
}

export interface CliTriggerData {
  command?: string;
  args?: string[];
  flags?: Record<string, string | number | boolean>;
  metadata?: Record<string, unknown>;
}

export interface CliSignalData {
  id: string;
  type: string;
  timestamp: string;
  data: {
    command: string;
    args: string[];
    flags: Record<string, string | number | boolean>;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Built-in CLI Signal Provider for command-line triggered signals
 */
export class CliSignalProvider implements IProvider {
  // IProvider interface properties
  readonly id: string;
  readonly type = ProviderType.SIGNAL;
  readonly name = "CLI Signal Provider";
  readonly version = "1.0.0";

  private config: CliSignalConfig;
  private state: ProviderState;

  constructor(config: CliSignalConfig) {
    this.validateConfig(config);
    this.config = {
      ...config,
      args: config.args || [],
      flags: config.flags || {},
    };
    this.id = config.id;
    this.state = {
      status: ProviderStatus.NOT_CONFIGURED,
    };
  }

  private validateConfig(config: CliSignalConfig): void {
    if (!config.command || config.command.trim() === "") {
      throw new Error("CLI signal provider requires 'command' configuration");
    }

    if (config.args && !Array.isArray(config.args)) {
      throw new Error("CLI signal provider 'args' must be an array");
    }

    if (config.flags && (typeof config.flags !== "object" || Array.isArray(config.flags))) {
      throw new Error("CLI signal provider 'flags' must be an object");
    }

    // Validate args are all strings
    if (config.args) {
      for (const arg of config.args) {
        if (typeof arg !== "string") {
          throw new Error("CLI signal provider 'args' must contain only strings");
        }
      }
    }

    // Validate flags are primitive values
    if (config.flags) {
      for (const [key, value] of Object.entries(config.flags)) {
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          throw new Error(`CLI signal provider flag '${key}' must be string, number, or boolean`);
        }
      }
    }
  }

  // IProvider interface methods
  setup(): void {
    this.state.status = ProviderStatus.READY;
    this.state.config = this.config;
  }

  teardown(): void {
    this.state.status = ProviderStatus.DISABLED;
  }

  getState(): ProviderState {
    return { ...this.state };
  }

  checkHealth(): Promise<HealthStatus> {
    return Promise.resolve({
      healthy: this.state.status === ProviderStatus.READY,
      lastCheck: new Date(),
      message: this.state.status === ProviderStatus.READY
        ? "CLI signal provider ready"
        : `Provider status: ${this.state.status}`,
    });
  }

  /**
   * Get the provider ID
   */
  getProviderId(): string {
    return this.config.id;
  }

  /**
   * Get the provider type
   */
  getProviderType(): string {
    return "cli";
  }

  /**
   * Get the command for this signal
   */
  getCommand(): string {
    return this.config.command;
  }

  /**
   * Get the default args for this signal
   */
  getArgs(): string[] {
    return [...(this.config.args || [])];
  }

  /**
   * Get the default flags for this signal
   */
  getFlags(): Record<string, string | number | boolean> {
    return { ...(this.config.flags || {}) };
  }

  /**
   * Process CLI trigger data and convert to signal
   */
  processTrigger(triggerData: CliTriggerData | null = null): Promise<CliSignalData> {
    if (triggerData === null || triggerData === undefined) {
      throw new Error("CLI signal provider requires trigger data");
    }

    this.validateTriggerData(triggerData);

    // Use config command if not provided in trigger
    const command = triggerData.command || this.config.command;

    // Validate command matches config if provided in trigger
    if (triggerData.command && triggerData.command !== this.config.command) {
      throw new Error(
        `CLI signal command mismatch: expected '${this.config.command}', got '${triggerData.command}'`,
      );
    }

    // Merge config and trigger args
    const configArgs = this.config.args || [];
    const triggerArgs = triggerData.args || [];
    const mergedArgs = [...configArgs, ...triggerArgs];

    // Merge config and trigger flags (trigger overrides config)
    const configFlags = this.config.flags || {};
    const triggerFlags = triggerData.flags || {};
    const mergedFlags = { ...configFlags, ...triggerFlags };

    const signal: CliSignalData = {
      id: this.config.id,
      type: "cli",
      timestamp: new Date().toISOString(),
      data: {
        command,
        args: mergedArgs,
        flags: mergedFlags,
      },
    };

    // Include metadata if provided
    if (triggerData.metadata) {
      signal.data.metadata = triggerData.metadata;
    }

    return Promise.resolve(signal);
  }

  private validateTriggerData(triggerData: CliTriggerData): void {
    if (triggerData.args && !Array.isArray(triggerData.args)) {
      throw new Error("CLI trigger data 'args must be array'");
    }

    if (
      triggerData.flags &&
      (typeof triggerData.flags !== "object" || Array.isArray(triggerData.flags))
    ) {
      throw new Error("CLI trigger data 'flags must be object'");
    }

    // Validate args are all strings
    if (triggerData.args) {
      for (const arg of triggerData.args) {
        if (typeof arg !== "string") {
          throw new Error("CLI trigger data 'args' must contain only strings");
        }
      }
    }

    // Validate flags are primitive values
    if (triggerData.flags) {
      for (const [key, value] of Object.entries(triggerData.flags)) {
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          throw new Error(`CLI trigger data flag '${key}' must be string, number, or boolean`);
        }
      }
    }
  }
}

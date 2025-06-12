/**
 * Custom HTTP Adapter for proprietary or non-standard agent APIs
 * Placeholder implementation for future development
 */

import { BaseRemoteAdapter, type BaseRemoteAdapterConfig } from "./base-remote-adapter.ts";
import type {
  HealthStatus,
  RemoteAgentInfo,
  RemoteExecutionRequest,
  RemoteExecutionResult,
  RemoteExecutionEvent,
} from "../types.ts";

export interface CustomAdapterConfig extends BaseRemoteAdapterConfig {
  custom: Record<string, unknown>;
}

/**
 * Custom HTTP Protocol Adapter
 * Placeholder for custom/proprietary agent protocol support
 */
export class CustomAdapter extends BaseRemoteAdapter {
  protected override config: CustomAdapterConfig;

  constructor(config: CustomAdapterConfig) {
    super(config);
    this.config = config;
  }

  getProtocolName(): string {
    return "custom";
  }

  async discoverAgents(): Promise<RemoteAgentInfo[]> {
    throw new Error("Custom adapter not yet implemented");
  }

  async getAgentDetails(agentName: string): Promise<RemoteAgentInfo> {
    throw new Error("Custom adapter not yet implemented");
  }

  async executeAgent(request: RemoteExecutionRequest): Promise<RemoteExecutionResult> {
    throw new Error("Custom adapter not yet implemented");
  }

  async *executeAgentStream(request: RemoteExecutionRequest): AsyncIterableIterator<RemoteExecutionEvent> {
    throw new Error("Custom adapter not yet implemented");
  }

  async cancelExecution(executionId: string): Promise<void> {
    throw new Error("Custom adapter not yet implemented");
  }

  async healthCheck(): Promise<HealthStatus> {
    throw new Error("Custom adapter not yet implemented");
  }
}
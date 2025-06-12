/**
 * A2A (Agent-to-Agent) Adapter for Google's Agent-to-Agent protocol
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

export interface A2AAdapterConfig extends BaseRemoteAdapterConfig {
  a2a: Record<string, unknown>;
}

/**
 * A2A Protocol Adapter
 * Placeholder for Google Agent-to-Agent protocol support
 */
export class A2AAdapter extends BaseRemoteAdapter {
  protected override config: A2AAdapterConfig;

  constructor(config: A2AAdapterConfig) {
    super(config);
    this.config = config;
  }

  getProtocolName(): string {
    return "a2a";
  }

  async discoverAgents(): Promise<RemoteAgentInfo[]> {
    throw new Error("A2A adapter not yet implemented");
  }

  async getAgentDetails(agentName: string): Promise<RemoteAgentInfo> {
    throw new Error("A2A adapter not yet implemented");
  }

  async executeAgent(request: RemoteExecutionRequest): Promise<RemoteExecutionResult> {
    throw new Error("A2A adapter not yet implemented");
  }

  async *executeAgentStream(request: RemoteExecutionRequest): AsyncIterableIterator<RemoteExecutionEvent> {
    throw new Error("A2A adapter not yet implemented");
  }

  async cancelExecution(executionId: string): Promise<void> {
    throw new Error("A2A adapter not yet implemented");
  }

  async healthCheck(): Promise<HealthStatus> {
    throw new Error("A2A adapter not yet implemented");
  }
}
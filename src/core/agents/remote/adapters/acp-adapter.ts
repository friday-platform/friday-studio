/**
 * ACP (Agent Communication Protocol) Adapter
 * Implementation using the official acp-sdk for reliable protocol compliance
 * 
 * This file will be completed in the next task: "Implement ACP adapter using official SDK"
 */

import { BaseRemoteAdapter, type BaseRemoteAdapterConfig } from "./base-remote-adapter.ts";
import type {
  HealthStatus,
  RemoteAgentInfo,
  RemoteExecutionRequest,
  RemoteExecutionResult,
  RemoteExecutionEvent,
} from "../types.ts";

export interface ACPAdapterConfig extends BaseRemoteAdapterConfig {
  acp: {
    agent_name: string;
    default_mode: "sync" | "async" | "stream";
    timeout_ms: number;
    max_retries: number;
    health_check_interval: number;
  };
}

/**
 * ACP Protocol Adapter
 * Placeholder implementation - will be completed in next task
 */
export class ACPAdapter extends BaseRemoteAdapter {
  protected override config: ACPAdapterConfig;

  constructor(config: ACPAdapterConfig) {
    super(config);
    this.config = config;
  }

  getProtocolName(): string {
    return "acp";
  }

  async discoverAgents(): Promise<RemoteAgentInfo[]> {
    throw new Error("ACP adapter not yet implemented - coming in next task");
  }

  async getAgentDetails(agentName: string): Promise<RemoteAgentInfo> {
    throw new Error("ACP adapter not yet implemented - coming in next task");
  }

  async executeAgent(request: RemoteExecutionRequest): Promise<RemoteExecutionResult> {
    throw new Error("ACP adapter not yet implemented - coming in next task");
  }

  async *executeAgentStream(request: RemoteExecutionRequest): AsyncIterableIterator<RemoteExecutionEvent> {
    throw new Error("ACP adapter not yet implemented - coming in next task");
  }

  async cancelExecution(executionId: string): Promise<void> {
    throw new Error("ACP adapter not yet implemented - coming in next task");
  }

  async healthCheck(): Promise<HealthStatus> {
    throw new Error("ACP adapter not yet implemented - coming in next task");
  }
}
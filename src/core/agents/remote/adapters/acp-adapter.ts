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
  RemoteExecutionEvent,
  RemoteExecutionRequest,
  RemoteExecutionResult,
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

  discoverAgents(): Promise<RemoteAgentInfo[]> {
    throw new Error("ACP adapter not yet implemented - coming in next task");
  }

  getAgentDetails(_agentName: string): Promise<RemoteAgentInfo> {
    throw new Error("ACP adapter not yet implemented - coming in next task");
  }

  executeAgent(_request: RemoteExecutionRequest): Promise<RemoteExecutionResult> {
    throw new Error("ACP adapter not yet implemented - coming in next task");
  }

  async *executeAgentStream(
    _request: RemoteExecutionRequest,
  ): AsyncIterableIterator<RemoteExecutionEvent> {
    // Placeholder generator - throw immediately but include yield for generator requirements
    throw new Error("ACP adapter not yet implemented - coming in next task");
    // deno-lint-ignore no-unreachable
    yield;
  }

  cancelExecution(_executionId: string): Promise<void> {
    throw new Error("ACP adapter not yet implemented - coming in next task");
  }

  healthCheck(): Promise<HealthStatus> {
    throw new Error("ACP adapter not yet implemented - coming in next task");
  }
}

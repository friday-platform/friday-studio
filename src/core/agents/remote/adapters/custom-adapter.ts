/**
 * Custom HTTP Adapter for proprietary or non-standard agent APIs
 * Placeholder implementation for future development
 */

import { BaseRemoteAdapter, type BaseRemoteAdapterConfig } from "./base-remote-adapter.ts";
import type {
  HealthStatus,
  RemoteAgentInfo,
  RemoteExecutionEvent,
  RemoteExecutionRequest,
  RemoteExecutionResult,
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

  discoverAgents(): Promise<RemoteAgentInfo[]> {
    throw new Error("Custom adapter not yet implemented");
  }

  getAgentDetails(_agentName: string): Promise<RemoteAgentInfo> {
    throw new Error("Custom adapter not yet implemented");
  }

  executeAgent(_request: RemoteExecutionRequest): Promise<RemoteExecutionResult> {
    throw new Error("Custom adapter not yet implemented");
  }

  async *executeAgentStream(
    _request: RemoteExecutionRequest,
  ): AsyncIterableIterator<RemoteExecutionEvent> {
    // Placeholder generator - throw immediately but include yield for generator requirements
    throw new Error("Custom adapter not yet implemented");
    // deno-lint-ignore no-unreachable
    yield;
  }

  cancelExecution(_executionId: string): Promise<void> {
    throw new Error("Custom adapter not yet implemented");
  }

  healthCheck(): Promise<HealthStatus> {
    throw new Error("Custom adapter not yet implemented");
  }
}

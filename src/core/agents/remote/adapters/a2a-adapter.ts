/**
 * A2A (Agent-to-Agent) Adapter for Google's Agent-to-Agent protocol
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

  discoverAgents(): Promise<RemoteAgentInfo[]> {
    throw new Error("A2A adapter not yet implemented");
  }

  getAgentDetails(_agentName: string): Promise<RemoteAgentInfo> {
    throw new Error("A2A adapter not yet implemented");
  }

  executeAgent(_request: RemoteExecutionRequest): Promise<RemoteExecutionResult> {
    throw new Error("A2A adapter not yet implemented");
  }

  async *executeAgentStream(
    _request: RemoteExecutionRequest,
  ): AsyncIterableIterator<RemoteExecutionEvent> {
    // Placeholder generator that never yields
    throw new Error("A2A adapter not yet implemented");
    // deno-lint-ignore no-unreachable
    yield { type: "error", error: "A2A adapter not yet implemented" } as RemoteExecutionEvent;
  }

  cancelExecution(_executionId: string): Promise<void> {
    throw new Error("A2A adapter not yet implemented");
  }

  resumeExecution(_executionId: string, _response: string | import("../types.ts").RemoteMessagePart[]): Promise<RemoteExecutionResult> {
    throw new Error("A2A adapter does not support resumeExecution");
  }

  healthCheck(): Promise<HealthStatus> {
    throw new Error("A2A adapter not yet implemented");
  }
}

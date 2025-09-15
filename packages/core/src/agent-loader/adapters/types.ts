import type { AtlasAgent } from "@atlas/agent-sdk";

/**
 * Agent source type defines where an agent is loaded from in Atlas.
 * Maps to specific adapters in the agent loader system.
 */
export type AgentSourceType = "system" | "bundled" | "sdk" | "yaml";

/**
 * Raw agent data from an adapter before conversion to AtlasAgent.
 * Acts as the bridge between different source formats and the unified SDK.
 */
export interface AgentSourceData {
  type: AgentSourceType;
  id: string;
  /** Raw YAML content for yaml agents */
  content?: string;
  /** Already converted AtlasAgent for sdk/system/bundled agents */
  agent?: AtlasAgent;
  metadata: {
    /** Where this agent was loaded from */
    sourceLocation: string;
    /** When the agent definition was last changed */
    lastModified?: Date;
    /** Agent version if specified */
    version?: string;
  };
}

/**
 * Adapter interface for loading agents from different sources.
 * Core of Atlas agent loading system - each source type has its own adapter.
 */
export interface AgentAdapter {
  /** Load a specific agent by ID */
  loadAgent(id: string): Promise<AgentSourceData>;
  /** List all available agents from this source */
  listAgents(): Promise<AgentSummary[]>;
  /** Check if an agent exists without loading it */
  exists(id: string): Promise<boolean>;
  /** Adapter name for debugging/logging */
  readonly adapterName: string;
  /** Type of agents this adapter provides */
  readonly sourceType: AgentSourceType;
}

/**
 * Lightweight agent metadata for listings.
 * Used by the registry to display available agents without full loading.
 */
export interface AgentSummary {
  /** Unique identifier */
  id: string;
  /** Where this agent comes from */
  type: AgentSourceType;
  /** Human-readable display name */
  displayName?: string;
  /** What this agent does */
  description?: string;
  /** Agent version */
  version?: string;
}

/**
 * Check if an agent is restricted to system workspaces.
 * System agents are built-in and only available to system workspaces.
 */
function isSystemAgent(source: AgentSourceData | AgentSummary): boolean {
  return source.type === "system";
}

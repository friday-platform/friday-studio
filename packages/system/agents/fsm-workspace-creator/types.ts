/**
 * Shared types for FSM workspace creator
 */

import type { WorkspacePlan } from "@atlas/core/artifacts";

/**
 * Agent classification result: either uses a bundled agent or LLM with MCP tools
 */
export type AgentType =
  | { kind: "bundled"; bundledId: string; name: string }
  | { kind: "llm"; mcpTools: string[] };

/**
 * Classified agent with all necessary information for FSM generation
 */
export interface ClassifiedAgent {
  id: string;
  name: string;
  description: string;
  config: Record<string, unknown>;
  type: AgentType;
}

/**
 * Simplified agent structure for LLM code generation
 * Flattens the discriminated union for easier LLM comprehension
 */
export interface SimplifiedAgent {
  id: string;
  name: string;
  description: string;
  config: Record<string, unknown>;
  executionType: "bundled" | "llm";
  bundledAgentId?: string; // If executionType === 'bundled'
  mcpTools?: string[]; // If executionType === 'llm'
}

/**
 * Job from workspace plan
 */
export type Job = WorkspacePlan["jobs"][0];

/**
 * Signal from workspace plan
 */
export type Signal = WorkspacePlan["signals"][0];

/**
 * ACP (Agent Communication Protocol) Types and Utilities
 *
 * This module provides type-safe interfaces for the Agent Communication Protocol
 * based on the official OpenAPI specification from i-am-bee/acp.
 *
 * Types are auto-generated from the OpenAPI spec using openapi-typescript.
 */

// Re-export the core types from the generated types file
export type { components, operations, paths } from "./types.gen.ts";

// Import the types so we can use them in type aliases
import type { components, operations, paths } from "./types.gen.ts";

// Create convenient type aliases for commonly used types
export type ACPAgent = components["schemas"]["Agent"];
export type ACPRun = components["schemas"]["Run"];
export type ACPRunStatus = components["schemas"]["RunStatus"];
export type ACPRunMode = components["schemas"]["RunMode"];
export type ACPMessage = components["schemas"]["Message"];
export type ACPMessagePart = components["schemas"]["MessagePart"];
export type ACPEvent = components["schemas"]["Event"];
export type ACPError = components["schemas"]["Error"];
export type ACPAgentName = components["schemas"]["AgentName"];
export type ACPSessionId = components["schemas"]["SessionId"];
export type ACPRunId = components["schemas"]["RunId"];

// Request/Response types
export type ACPRunCreateRequest = components["schemas"]["RunCreateRequest"];
export type ACPRunResumeRequest = components["schemas"]["RunResumeRequest"];
export type ACPAgentsListResponse = components["schemas"]["AgentsListResponse"];
export type ACPRunEventsListResponse = components["schemas"]["RunEventsListResponse"];

// Event types
export type ACPMessageCreatedEvent = components["schemas"]["MessageCreatedEvent"];
export type ACPMessagePartEvent = components["schemas"]["MessagePartEvent"];
export type ACPMessageCompletedEvent = components["schemas"]["MessageCompletedEvent"];
export type ACPRunCreatedEvent = components["schemas"]["RunCreatedEvent"];
export type ACPRunInProgressEvent = components["schemas"]["RunInProgressEvent"];
export type ACPRunCompletedEvent = components["schemas"]["RunCompletedEvent"];
export type ACPRunFailedEvent = components["schemas"]["RunFailedEvent"];
export type ACPRunCancelledEvent = components["schemas"]["RunCancelledEvent"];
export type ACPErrorEvent = components["schemas"]["ErrorEvent"];

// Operation types for type-safe API client
export type PingOperation = operations["ping"];
export type ListAgentsOperation = operations["listAgents"];
export type GetAgentOperation = operations["getAgent"];
export type CreateRunOperation = operations["createRun"];
export type GetRunOperation = operations["getRun"];
export type ResumeRunOperation = operations["resumeRun"];
export type CancelRunOperation = operations["cancelRun"];
export type ListRunEventsOperation = operations["listRunEvents"];

// Path types for URL construction
export type ACPPaths = paths;

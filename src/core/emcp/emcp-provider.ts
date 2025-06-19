/**
 * Extended Model Context Protocol (EMCP) Provider Interface
 *
 * Extends MCP with Atlas-specific capabilities for enterprise orchestration:
 * - Configuration delegation
 * - Capability discovery
 * - Cost measurement
 * - Advanced security/identity
 * - AI integration
 */

export interface EMCPProviderConfig {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly capabilities: EMCPCapability[];
  readonly costMetrics?: EMCPCostMetrics;
  readonly securityRequirements?: EMCPSecurityRequirements;
}

export interface EMCPCapability {
  readonly type: string; // "codebase", "database", "api", etc.
  readonly operations: string[]; // "read", "write", "analyze", etc.
  readonly formats: string[]; // "typescript", "json", "sql", etc.
  readonly constraints?: EMCPConstraints;
}

export interface EMCPConstraints {
  readonly maxSize?: string; // "50kb", "100MB", etc.
  readonly timeout?: number; // milliseconds
  readonly rateLimit?: number; // requests per second
}

export interface EMCPCostMetrics {
  readonly tokenUsage?: boolean;
  readonly apiCalls?: boolean;
  readonly processingTime?: boolean;
  readonly dataTransfer?: boolean;
}

export interface EMCPSecurityRequirements {
  readonly authentication?: string[]; // "oauth", "token", "certificate"
  readonly authorization?: string[]; // "rbac", "scope-based"
  readonly encryption?: string[]; // "tls", "aes-256"
}

export interface EMCPResource {
  readonly uri: string;
  readonly type: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly lastModified?: Date;
  readonly metadata?: Record<string, unknown>;
}

export interface EMCPResourceContent {
  readonly uri: string;
  readonly mimeType: string;
  readonly content: string | Uint8Array;
  readonly metadata?: Record<string, unknown>;
}

export interface EMCPContext {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly reasoning?: string; // LLM reasoning context for provider
  readonly constraints?: EMCPConstraints;
}

export interface EMCPResult {
  readonly success: boolean;
  readonly content?: EMCPResourceContent;
  readonly resources?: EMCPResource[];
  readonly error?: string;
  readonly cost?: EMCPCostInfo;
  readonly metadata?: Record<string, unknown>;
}

export interface EMCPCostInfo {
  readonly tokenUsage?: number;
  readonly apiCalls?: number;
  readonly processingTimeMs?: number;
  readonly dataTransferBytes?: number;
}

/**
 * Base EMCP Provider Interface
 *
 * All Atlas context and tool providers implement this interface
 */
export interface IEMCPProvider {
  /**
   * Provider configuration and capabilities
   */
  readonly config: EMCPProviderConfig;

  /**
   * Initialize provider with workspace configuration
   */
  initialize(config: Record<string, unknown>): Promise<void>;

  /**
   * Check if provider can handle a specific context type
   */
  canProvide(contextType: string): boolean;

  /**
   * List available resources
   */
  listResources(context: EMCPContext): Promise<EMCPResource[]>;

  /**
   * Read a specific resource
   */
  readResource(uri: string, context: EMCPContext): Promise<EMCPResult>;

  /**
   * Provision context based on specification
   */
  provisionContext(spec: ContextSpec, context: EMCPContext): Promise<EMCPResult>;

  /**
   * Clean up resources and connections
   */
  shutdown(): Promise<void>;
}

/**
 * Context specification interface (will be extended by specific types)
 */
export interface ContextSpec {
  readonly type: string;
  readonly maxSize?: string;
  readonly timeout?: number;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Codebase-specific context specification
 */
export interface CodebaseContextSpec extends ContextSpec {
  readonly type: "codebase";
  readonly filePatterns?: string[];
  readonly focusAreas?: string[];
  readonly includeTests?: boolean;
  readonly language?: string;
  readonly basePath?: string;
}

/**
 * Database-specific context specification
 */
export interface DatabaseContextSpec extends ContextSpec {
  readonly type: "database";
  readonly schema?: boolean;
  readonly sampleData?: number;
  readonly tables?: string[];
}

/**
 * API documentation context specification
 */
export interface APIContextSpec extends ContextSpec {
  readonly type: "api";
  readonly endpoints?: string[];
  readonly includeExamples?: boolean;
  readonly format?: "openapi" | "swagger" | "graphql";
}

/**
 * MCP Registry - Three-tier discovery system for Atlas workspace creation
 *
 * This module provides intelligent MCP server discovery through:
 * - Tier 1: Agent-based discovery using existing agent configurations
 * - Tier 2: Static registry of curated, production-ready servers
 * - Tier 3: Web research discovery (placeholder for future implementation)
 */

export { MCPRegistry } from "./registry.ts";
export type { MCPDiscoveryRequest, MCPServerMetadata } from "./types.ts";

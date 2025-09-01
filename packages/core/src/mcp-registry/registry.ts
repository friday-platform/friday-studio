import { createLogger } from "@atlas/logger";
import type { AgentRegistry } from "../agent-loader/registry.ts";
import { AgentBasedMCPDiscovery } from "./agent-discovery.ts";
import { StaticMCPDiscovery } from "./static-discovery.ts";
import type {
  MCPDiscoveryRequest,
  MCPDiscoveryResult,
  MCPServerConfig,
  MCPServerMetadata,
  UnifiedDiscoveryResult,
  ValidationResult,
} from "./types.ts";
import { UnifiedDiscovery } from "./unified-discovery.ts";
import { WebMCPDiscovery } from "./web-discovery.ts";

/**
 * Core MCP Registry service that coordinates three-tier discovery
 */
export class MCPRegistry {
  private static instance: MCPRegistry | null = null;
  private logger = createLogger({ component: "MCPRegistry" });
  private agentDiscovery?: AgentBasedMCPDiscovery;
  private unifiedDiscovery?: UnifiedDiscovery;
  private staticDiscovery: StaticMCPDiscovery;
  private webDiscovery?: WebMCPDiscovery;
  private initialized = false;

  constructor(private agentRegistry?: AgentRegistry) {
    this.staticDiscovery = new StaticMCPDiscovery();
    if (this.agentRegistry) {
      this.agentDiscovery = new AgentBasedMCPDiscovery(this.agentRegistry);
      this.unifiedDiscovery = new UnifiedDiscovery(this.agentRegistry);
    }
    // WebDiscovery without research tool - will return empty results
    this.webDiscovery = new WebMCPDiscovery();
  }

  /** Get singleton instance */
  static async getInstance(agentRegistry?: AgentRegistry): Promise<MCPRegistry> {
    if (!MCPRegistry.instance) {
      MCPRegistry.instance = new MCPRegistry(agentRegistry);
      await MCPRegistry.instance.initialize();
    }
    return MCPRegistry.instance;
  }

  /** Initialize the registry */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.logger.info("Initializing MCP registry...");

    // Initialize static discovery
    await this.staticDiscovery.initialize();
    this.logger.debug("Static MCP discovery initialized");

    // Initialize agent discovery if available
    if (this.agentDiscovery) {
      await this.agentDiscovery.initialize();
      this.logger.debug("Agent-based MCP discovery initialized");
    }

    // Initialize unified discovery if available
    if (this.unifiedDiscovery) {
      await this.unifiedDiscovery.initialize();
      this.logger.debug("Unified discovery initialized");
    }

    this.initialized = true;
    this.logger.info("MCP registry initialized successfully");
  }

  /**
   * Discover the best MCP server for a given request
   * Uses three-tier discovery strategy with early return on high-confidence matches
   */
  async discoverBestMCPServer(request: MCPDiscoveryRequest): Promise<MCPDiscoveryResult | null> {
    await this.initialize();

    this.logger.debug("Starting MCP discovery", { intent: request.intent, domain: request.domain });

    // Tier 1: Agent-based discovery
    if (this.agentDiscovery) {
      try {
        const agentResults = await this.agentDiscovery.discover(request);
        if (agentResults.length > 0) {
          const bestAgentMatch = this.selectBestMatch(agentResults);
          // Return immediately if we found a high-confidence match from agents
          if (bestAgentMatch.confidence >= 0.8) {
            this.logger.info("High-confidence agent match found, skipping lower tiers", {
              serverId: bestAgentMatch.server.id,
              confidence: bestAgentMatch.confidence,
              source: bestAgentMatch.source,
            });
            return bestAgentMatch;
          }
        }
      } catch (error) {
        this.logger.warn("Agent-based discovery failed", { error });
      }
    }

    // Tier 2: Static discovery
    try {
      const staticResults = await this.staticDiscovery.discover(request);
      if (staticResults.length > 0) {
        const bestStaticMatch = this.selectBestMatch(staticResults);
        // Return immediately if we found a high-confidence match from static registry
        if (bestStaticMatch.confidence >= 0.7) {
          this.logger.info("High-confidence static match found, skipping web discovery", {
            serverId: bestStaticMatch.server.id,
            confidence: bestStaticMatch.confidence,
            source: bestStaticMatch.source,
          });
          return bestStaticMatch;
        }
      }
    } catch (error) {
      this.logger.warn("Static discovery failed", { error });
    }

    // Tier 3: Web discovery (placeholder for future implementation)
    if (this.webDiscovery) {
      try {
        const webResults = await this.webDiscovery.discover(request);
        if (webResults.length > 0) {
          const bestWebMatch = this.selectBestMatch(webResults);
          this.logger.info("Web discovery match found", {
            serverId: bestWebMatch.server.id,
            confidence: bestWebMatch.confidence,
            source: bestWebMatch.source,
          });
          return bestWebMatch;
        }
      } catch (error) {
        this.logger.warn("Web discovery failed", { error });
      }
    }

    this.logger.info("No MCP servers found for request", { intent: request.intent });
    return null;
  }

  /**
   * Discover the best solution (built-in agent or MCP server) for a given request
   * Uses unified discovery that prioritizes built-in agents over external MCP servers
   */
  async discoverBestSolution(request: MCPDiscoveryRequest): Promise<UnifiedDiscoveryResult | null> {
    await this.initialize();

    this.logger.debug("Starting unified solution discovery", {
      intent: request.intent,
      domain: request.domain,
    });

    if (this.unifiedDiscovery) {
      try {
        const result = await this.unifiedDiscovery.discover(request);
        if (result) {
          this.logger.info("Solution found via unified discovery", {
            type: result.type,
            id: result.type === "agent" ? result.agent.id : result.server.id,
            confidence: result.confidence,
            source: result.source,
          });
          return result;
        }
      } catch (error) {
        this.logger.warn("Unified discovery failed, falling back to MCP-only discovery", { error });
      }
    }

    // Fallback to MCP-only discovery if unified discovery is not available or fails
    const mcpResult = await this.discoverBestMCPServer(request);
    if (mcpResult) {
      return { ...mcpResult, type: "mcp" as const };
    }

    this.logger.info("No solutions found for request", { intent: request.intent });
    return null;
  }

  /** Get metadata for a specific MCP server */
  async getServerMetadata(serverId: string): Promise<MCPServerMetadata | null> {
    await this.initialize();
    return await this.staticDiscovery.getServerById(serverId);
  }

  /** Validate an MCP server configuration */
  validateServerConfig(config: MCPServerConfig): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Basic transport validation
    if (!config.transport?.type) {
      errors.push("Transport type is required");
    }

    if (config.transport?.type === "stdio" && !config.transport.command) {
      errors.push("Command is required for stdio transport");
    }

    if (config.transport?.type === "sse" && !config.transport.url) {
      errors.push("URL is required for SSE transport");
    }

    // Tools validation
    if (!config.tools) {
      errors.push("Tools configuration is required");
    } else if (!config.tools.allow && !config.tools.deny) {
      warnings.push("No tool filtering specified - consider using allow/deny lists for security");
    }

    // Auth validation
    if (config.auth && config.auth.type !== "none" && !config.auth.token_env) {
      warnings.push("Authentication type specified but no token_env provided");
    }

    return { success: errors.length === 0, errors, warnings };
  }

  /** Select the best match from candidates */
  private selectBestMatch(candidates: MCPDiscoveryResult[]): MCPDiscoveryResult {
    if (candidates.length === 0) {
      throw new Error("No candidates available for selection");
    }

    // Sort by confidence score first, then security rating as tiebreaker
    const sortedCandidates = candidates.sort((a, b) => {
      // First priority: confidence score
      if (a.confidence !== b.confidence) {
        return b.confidence - a.confidence;
      }

      // Second priority: security rating
      const securityRanking: Record<string, number> = { high: 3, medium: 2, low: 1, unverified: 0 };

      const aSecurityRank = securityRanking[a.server.securityRating] || 0;
      const bSecurityRank = securityRanking[b.server.securityRating] || 0;

      return bSecurityRank - aSecurityRank;
    });

    const bestMatch = sortedCandidates.at(0);
    if (bestMatch) {
      return bestMatch;
    }

    throw new Error("No candidates available for selection");
  }
}

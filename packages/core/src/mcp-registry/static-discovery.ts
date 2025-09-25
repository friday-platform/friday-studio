import { createLogger } from "@atlas/logger";
import { mcpServersRegistry } from "./mcp-servers-registry.ts";
import type { MCPDiscoveryRequest, MCPDiscoveryResult, MCPServerMetadata } from "./types.ts";

/**
 * Tier 2: Static MCP discovery
 * Uses curated registry of production-ready MCP servers
 */
export class StaticMCPDiscovery {
  private logger = createLogger({ component: "StaticMCPDiscovery" });
  private static registry: MCPServerMetadata[] = [];
  private static initialized = false;

  async initialize(): Promise<void> {
    if (StaticMCPDiscovery.initialized) {
      return;
    }

    this.logger.info("Initializing static MCP discovery...");
    await this.loadStaticRegistry();
    StaticMCPDiscovery.initialized = true;
    this.logger.info("Static MCP discovery initialized", {
      serverCount: StaticMCPDiscovery.registry.length,
    });
  }

  /** Discover MCP servers from static registry */
  async discover(request: MCPDiscoveryRequest): Promise<MCPDiscoveryResult[]> {
    await this.initialize();

    this.logger.debug("Starting static discovery", { intent: request.intent });

    // Semantic search over server descriptions and use cases
    let candidates = this.semanticSearch(request.intent);

    // Filter by domain if specified
    if (request.domain) {
      candidates = candidates.filter((server) => server.category === request.domain);
    }

    // Filter by capabilities if specified
    if (request.capabilities && request.capabilities.length > 0) {
      candidates = candidates.filter((server) =>
        this.serverHasCapabilities(server, request.capabilities),
      );
    }

    // Score and rank candidates
    const results = this.scoreStaticCandidates(candidates, request);

    this.logger.debug("Static discovery completed", {
      candidateCount: results.length,
      topCandidate: results[0]?.server.id,
    });

    return results;
  }

  /** Get server by ID */
  async getServerById(serverId: string): Promise<MCPServerMetadata | null> {
    await this.initialize();
    return StaticMCPDiscovery.registry.find((server) => server.id === serverId) || null;
  }

  /** Load static registry from TypeScript registry */
  private async loadStaticRegistry(): Promise<void> {
    const validatedServers: MCPServerMetadata[] = [];
    const validationErrors: Array<{ serverId: string; errors: string[] }> = [];

    // Validate each server in the registry
    for (const server of mcpServersRegistry.servers) {
      try {
        const serverWithSource = {
          ...server,
          source: "static", // Override source to be consistent
        };

        // Basic runtime validation instead of strict Zod validation
        this.validateServerBasics(serverWithSource);
        validatedServers.push(serverWithSource);
      } catch (error) {
        validationErrors.push({
          serverId: server.id || "unknown",
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
    }

    // Log validation results
    if (validationErrors.length > 0) {
      this.logger.error("Static registry validation errors", { validationErrors });
      throw new Error(
        `Failed to validate static registry: ${validationErrors.length} servers have validation errors`,
      );
    }

    StaticMCPDiscovery.registry = validatedServers;
    this.logger.debug("Static registry validation completed", {
      totalServers: validatedServers.length,
      validationPassed: true,
    });
  }

  /** Basic runtime validation for server metadata */
  private validateServerBasics(server: MCPServerMetadata): void {
    if (!server.id || typeof server.id !== "string") {
      throw new Error("Server must have a valid id");
    }
    if (!server.name || typeof server.name !== "string") {
      throw new Error("Server must have a valid name");
    }
    if (!server.description || typeof server.description !== "string") {
      throw new Error("Server must have a valid description");
    }
    if (!server.category || typeof server.category !== "string") {
      throw new Error("Server must have a valid category");
    }
    if (!server.configTemplate || typeof server.configTemplate !== "object") {
      throw new Error("Server must have a valid configTemplate");
    }
    if (!server.tools || !Array.isArray(server.tools) || server.tools.length === 0) {
      throw new Error("Server must have at least one tool");
    }
    if (!server.useCases || !Array.isArray(server.useCases) || server.useCases.length === 0) {
      throw new Error("Server must have at least one use case");
    }
  }

  /** Perform semantic search over server descriptions and use cases */
  private semanticSearch(query: string): MCPServerMetadata[] {
    const lowercaseQuery = query.toLowerCase();
    const queryWords = lowercaseQuery.split(/\s+/);

    return StaticMCPDiscovery.registry.filter((server) => {
      const searchText = [
        server.description,
        ...server.useCases,
        ...server.tools.map((tool) => tool.name),
        ...server.tools.map((tool) => tool.description),
        ...server.tools.flatMap((tool) => tool.capabilities),
      ]
        .join(" ")
        .toLowerCase();

      // Check if any query word appears in the search text
      return queryWords.some((word) => searchText.includes(word));
    });
  }

  /** Check if server has required capabilities */
  private serverHasCapabilities(
    server: MCPServerMetadata,
    requiredCapabilities: string[],
  ): boolean {
    const serverCapabilities = server.tools.flatMap((tool) => tool.capabilities);
    return requiredCapabilities.some((required) =>
      serverCapabilities.some((capability) =>
        capability.toLowerCase().includes(required.toLowerCase()),
      ),
    );
  }

  /** Score and rank static candidates */
  private scoreStaticCandidates(
    candidates: MCPServerMetadata[],
    request: MCPDiscoveryRequest,
  ): MCPDiscoveryResult[] {
    return candidates
      .map((server) => {
        const confidence = this.calculateStaticConfidence(server, request);

        return {
          server,
          confidence,
          reasoning: this.generateStaticReasoning(server, request),
          source: "static",
        };
      })
      .sort((a, b) => b.confidence - a.confidence);
  }

  /** Calculate confidence score for static registry matches */
  private calculateStaticConfidence(
    server: MCPServerMetadata,
    request: MCPDiscoveryRequest,
  ): number {
    let confidence = 0.6; // Base confidence for static registry

    // Domain matching bonus
    if (request.domain && server.category === request.domain) {
      confidence += 0.2;
    }

    // Intent matching bonus (keyword-based)
    const intentLower = request.intent.toLowerCase();
    const relevanceScore = this.calculateRelevanceScore(server, intentLower);
    confidence += relevanceScore * 0.3;

    // Security rating bonus
    const securityBonus = { high: 0.1, medium: 0.05, low: 0, unverified: -0.1 };
    confidence += securityBonus[server.securityRating] || 0;

    // Capabilities matching bonus
    if (request.capabilities && request.capabilities.length > 0) {
      if (this.serverHasCapabilities(server, request.capabilities)) {
        confidence += 0.15;
      }
    }

    return Math.min(confidence, 1.0);
  }

  /** Calculate relevance score based on keyword matching */
  private calculateRelevanceScore(server: MCPServerMetadata, intent: string): number {
    const searchText = [
      server.description,
      ...server.useCases,
      ...server.tools.map((tool) => `${tool.name} ${tool.description}`),
    ]
      .join(" ")
      .toLowerCase();

    const intentWords = intent.split(/\s+/);
    const matchingWords = intentWords.filter((word) => searchText.includes(word));

    return matchingWords.length / Math.max(intentWords.length, 1);
  }

  /** Generate reasoning for static registry recommendations */
  private generateStaticReasoning(server: MCPServerMetadata, request: MCPDiscoveryRequest): string {
    const matchingUseCases = server.useCases.filter((useCase) =>
      request.intent
        .toLowerCase()
        .split(/\s+/)
        .some((word) => useCase.toLowerCase().includes(word)),
    );

    let reasoning = `${server.description} is a ${server.securityRating}-security MCP server specialized in ${server.category}. `;

    if (matchingUseCases.length > 0) {
      reasoning += `It directly supports use cases like: ${matchingUseCases.slice(0, 2).join(", ")}. `;
    }

    reasoning += `This server provides ${server.tools.length} tools for comprehensive automation. `;
    reasoning += `Static registry recommendation ensures production-ready reliability and security.`;

    return reasoning;
  }
}

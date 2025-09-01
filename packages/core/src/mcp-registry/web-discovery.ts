import { targetedResearchAgent } from "@atlas/bundled-agents";
import { createLogger } from "@atlas/logger";
import type {
  MCPCategory,
  MCPDiscoveryRequest,
  MCPDiscoveryResult,
  MCPServerConfig,
  MCPServerMetadata,
} from "./types.ts";

interface WebSearchResult {
  url: string;
  content: string;
  score: number;
}

interface ParsedMCPServer {
  packageName?: string;
  repository?: string;
  description: string;
  transportType: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  capabilities: string[];
  securityRating: "high" | "medium" | "low" | "unverified";
}

/**
 * Tier 3: Web research MCP discovery
 * Uses the targeted research agent to discover new or specialized MCP tools via web search
 */
export class WebMCPDiscovery {
  private logger = createLogger({ component: "WebMCPDiscovery" });

  constructor() {}

  /**
   * Discover MCP servers via web research using the targeted research agent
   * Searches GitHub, NPM, and documentation sites for MCP servers matching requirements
   */
  async discover(request: MCPDiscoveryRequest): Promise<MCPDiscoveryResult[]> {
    this.logger.debug("Starting web-based MCP discovery", {
      intent: request.intent,
      domain: request.domain,
    });

    try {
      // Generate targeted search queries for MCP servers
      const searchQueries = this.generateSearchQueries(request);

      // Execute searches using the research agent
      const searchResults = await this.performWebSearch(searchQueries);

      if (searchResults.length === 0) {
        this.logger.debug("No web search results found");
        return [];
      }

      // Parse and validate discovered servers
      const parsedServers = await this.parseSearchResults(searchResults, request);

      // Convert to discovery results with scoring
      const discoveryResults = this.scoreWebCandidates(parsedServers, request);

      this.logger.info("Web discovery completed", {
        searchResults: searchResults.length,
        parsedServers: parsedServers.length,
        discoveryResults: discoveryResults.length,
      });

      return discoveryResults;
    } catch (error) {
      this.logger.error("Web discovery failed", {
        error: error instanceof Error ? error.message : String(error),
        intent: request.intent,
      });
      return [];
    }
  }

  /**
   * Generate search queries optimized for finding MCP servers
   * Limited to trusted MCP server directories and GitHub
   */
  private generateSearchQueries(request: MCPDiscoveryRequest): string[] {
    const baseQueries = [
      // MCP Servers directory
      `site:mcpservers.org ${request.intent}`,
      `site:mcpservers.org "MCP server" ${request.intent}`,

      // Smithery.ai MCP directory
      `site:smithery.ai ${request.intent}`,
      `site:smithery.ai "MCP server" ${request.intent}`,

      // GitHub repositories
      `site:github.com "mcp server" ${request.intent}`,
      `site:github.com "model context protocol" ${request.intent}`,
      `site:github.com mcp-server ${request.intent}`,
    ];

    if (request.domain) {
      baseQueries.push(
        `site:mcpservers.org ${request.domain} ${request.intent}`,
        `site:github.com "mcp server" ${request.domain} ${request.intent}`,
      );
    }

    return baseQueries.slice(0, 7); // Limit to avoid excessive API calls
  }

  /**
   * Execute web search using the targeted research agent
   */
  private async performWebSearch(queries: string[]): Promise<WebSearchResult[]> {
    const allResults: WebSearchResult[] = [];
    const seenUrls = new Set<string>();

    // Execute searches for each query
    for (const query of queries) {
      try {
        this.logger.debug("Executing web search", { query });

        // Use the targeted research agent for web search
        // Note: Passing undefined for stream since there are type compatibility issues
        // with the current research agent stream interface
        const result = await targetedResearchAgent.execute(
          `Find MCP servers that can be installed via npx: ${query}. Focus only on NPM packages that support npx installation, not SSE servers or custom installation methods. Include GitHub repositories and official MCP server directories. Provide exact package names, links to the package, and all required environment variables to setup the server.`,
          {
            tools: {},
            session: {
              sessionId: "mcp-web-discovery",
              workspaceId: "mcp-registry",
              userId: "system",
            },
            env: {},
            stream: undefined,
            logger: this.logger,
          },
        );

        // Parse URLs and content from the research result
        const urls = this.extractUrlsFromResult(result);

        for (const url of urls) {
          if (!seenUrls.has(url) && this.isMCPRelevant(url)) {
            allResults.push({
              url,
              content: result.slice(0, 400), // Use portion of synthesis as content
              score: 0.5, // Default score for web results
            });
            seenUrls.add(url);
          }
        }
      } catch (error) {
        this.logger.warn("Search query failed", {
          query,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return allResults;
  }

  /**
   * Parse search results to extract MCP server information
   */
  private async parseSearchResults(
    results: WebSearchResult[],
    request: MCPDiscoveryRequest,
  ): Promise<ParsedMCPServer[]> {
    const parsedServers: ParsedMCPServer[] = [];

    // Process in batches to avoid overwhelming the system
    const BATCH_SIZE = 3;
    for (let i = 0; i < results.length; i += BATCH_SIZE) {
      const batch = results.slice(i, Math.min(i + BATCH_SIZE, results.length));

      const batchPromises = batch.map((result) =>
        this.parseSingleResult(result, request).catch((error) => {
          this.logger.warn("Failed to parse search result", {
            url: result.url,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }),
      );

      const batchResults = await Promise.all(batchPromises);
      parsedServers.push(
        ...batchResults.filter((server): server is ParsedMCPServer => server !== null),
      );
    }

    return parsedServers;
  }

  /**
   * Parse a single search result to extract MCP server metadata
   */
  private async parseSingleResult(
    result: WebSearchResult,
    request: MCPDiscoveryRequest,
  ): Promise<ParsedMCPServer | null> {
    try {
      // Use simple heuristics for parsing since we have limited content
      const url = result.url;
      const content = result.content.toLowerCase();

      let packageName: string | undefined;
      let transportType: "stdio" | "sse" = "stdio";
      let command: string | undefined;
      let args: string[] | undefined;
      let serverUrl: string | undefined;

      // Extract package name from various sources
      if (url.includes("npmjs.com")) {
        const match = url.match(/\/package\/([^/]+)/);
        if (match) {
          packageName = match[1];
        }
      } else if (url.includes("github.com")) {
        const match = url.match(/github\.com\/([^/]+\/[^/]+)/);
        if (match) {
          const repoPath = match.at(1);
          // Infer package name from repository
          if (repoPath) {
            packageName = repoPath.split("/")[1];
          }
        }
      }

      // Determine transport type
      if (content.includes("sse") || content.includes("server-sent events")) {
        transportType = "sse";
        // Try to extract SSE URL
        const urlMatch = content.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
          serverUrl = urlMatch.at(0);
        }
      } else {
        // Default to stdio
        command = "npx";
        if (packageName) {
          args = ["-y", packageName];
        }
      }

      // Extract capabilities from content
      const capabilities = this.extractCapabilities(content, request);

      // Determine security rating based on source
      let securityRating: "high" | "medium" | "low" | "unverified" = "unverified";
      if (url.includes("github.com/anthropic") || url.includes("npmjs.com/@anthropic")) {
        securityRating = "high";
      } else if (url.includes("github.com") && content.includes("readme")) {
        securityRating = "medium";
      } else if (url.includes("npmjs.com")) {
        securityRating = "medium";
      }

      return {
        packageName,
        repository: url.includes("github.com") ? url : undefined,
        description: this.generateDescription(content, request.intent),
        transportType,
        command,
        args,
        url: serverUrl,
        capabilities,
        securityRating,
      };
    } catch (error) {
      this.logger.warn("Failed to parse search result", {
        url: result.url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Extract capabilities from content text
   */
  private extractCapabilities(content: string, request: MCPDiscoveryRequest): string[] {
    const capabilities: string[] = [];

    // Common MCP capabilities
    const capabilityKeywords = [
      "file-system",
      "database",
      "web-scraping",
      "api-integration",
      "data-processing",
      "authentication",
      "storage",
      "monitoring",
      "analytics",
      "communication",
      "automation",
      "search",
    ];

    for (const keyword of capabilityKeywords) {
      if (content.includes(keyword.replace("-", " ")) || content.includes(keyword)) {
        capabilities.push(keyword);
      }
    }

    // Add domain-specific capability based on request
    if (request.domain && !capabilities.some((cap) => cap.includes(request.domain!))) {
      capabilities.push(request.domain);
    }

    return capabilities.length > 0 ? capabilities : ["general"];
  }

  /**
   * Generate description from content and intent
   */
  private generateDescription(content: string, intent: string): string {
    // Extract first sentence or meaningful phrase
    const sentences = content.split(".").filter((s) => s.trim().length > 10);
    const firstSentence = sentences.at(0)?.trim();
    if (firstSentence) {
      return firstSentence.length > 200 ? firstSentence.slice(0, 200) + "..." : firstSentence;
    }

    return `MCP server for ${intent}`;
  }

  /**
   * Score and convert parsed servers to discovery results
   */
  private scoreWebCandidates(
    servers: ParsedMCPServer[],
    request: MCPDiscoveryRequest,
  ): MCPDiscoveryResult[] {
    return servers
      .map((server) => {
        // Calculate confidence score
        let confidence = 0.3; // Base confidence for web discoveries

        // Boost for security rating
        const securityBonus = { high: 0.3, medium: 0.2, low: 0.1, unverified: 0 };
        confidence += securityBonus[server.securityRating];

        // Boost for capability match
        if (
          request.domain &&
          server.capabilities.some(
            (cap) => cap.includes(request.domain!) || request.domain!.includes(cap),
          )
        ) {
          confidence += 0.2;
        }

        // Boost for intent keyword match
        const intentLower = request.intent.toLowerCase();
        if (server.description.toLowerCase().includes(intentLower)) {
          confidence += 0.15;
        }

        // Cap confidence for web discoveries
        confidence = Math.min(confidence, 0.65);

        const serverMetadata: MCPServerMetadata = {
          id: this.generateServerId(server),
          name: server.packageName || `MCP Server for ${request.intent}`,
          description: server.description,
          category: this.inferCategory(server, request),
          source: "web",
          transportTypes: [server.transportType],
          tools: server.capabilities.map((cap) => ({
            name: cap.replace("-", "_"),
            description: `${cap} functionality`,
            capabilities: [cap],
          })),
          useCases: [request.intent, ...server.capabilities],
          securityRating: server.securityRating,
          configTemplate: this.generateConfigTemplate(server),
          documentation: server.repository,
          repository: server.repository,
        };

        return {
          server: serverMetadata,
          confidence,
          reasoning: this.generateWebReasoning(server, request, confidence),
          source: "web" as const,
        };
      })
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Generate unique server ID
   */
  private generateServerId(server: ParsedMCPServer): string {
    if (server.packageName) {
      return server.packageName.replace(/[@/]/g, "-").toLowerCase();
    }

    return server.url?.replace(/[^a-z0-9]/gi, "-").toLowerCase() ?? "";
  }

  /**
   * Infer category from server and request
   */
  private inferCategory(server: ParsedMCPServer, request: MCPDiscoveryRequest): MCPCategory {
    if (request.domain) {
      return request.domain;
    }

    // Map capabilities to categories
    const categoryMapping: Record<string, MCPCategory> = {
      "file-system": "utility",
      development: "development",
      "web-scraping": "automation",
      utility: "utility",
      authentication: "utility",
      storage: "cloud",
      monitoring: "analytics",
      analytics: "analytics",
      automation: "automation",
      communication: "communication",
      testing: "testing",
      security: "security",
      content: "content",
      finance: "finance",
    };

    for (const capability of server.capabilities) {
      if (categoryMapping[capability]) {
        return categoryMapping[capability];
      }
    }

    return "utility";
  }

  /**
   * Generate MCP server configuration template
   */
  private generateConfigTemplate(server: ParsedMCPServer): MCPServerConfig {
    const config: MCPServerConfig = {
      transport: { type: server.transportType },
      tools: { allow: server.capabilities.map((cap) => cap.replace("-", "_")) },
      client_config: { timeout: "60s" },
    };

    if (server.transportType === "stdio") {
      config.transport.command = server.command || "npx";
      if (server.args) {
        config.transport.args = server.args;
      }
    } else if (server.transportType === "sse" && server.url) {
      config.transport.url = server.url;
    }

    return config;
  }

  /**
   * Generate reasoning for web-discovered servers
   */
  private generateWebReasoning(
    server: ParsedMCPServer,
    request: MCPDiscoveryRequest,
    confidence: number,
  ): string {
    const reasons: string[] = [];

    reasons.push(`Discovered via web search for "${request.intent}"`);

    if (server.securityRating !== "unverified") {
      reasons.push(`Security rating: ${server.securityRating}`);
    }

    if (server.capabilities.length > 1) {
      reasons.push(`Multiple capabilities: ${server.capabilities.join(", ")}`);
    }

    if (server.repository) {
      reasons.push("Open source repository available");
    }

    reasons.push(`Confidence: ${(confidence * 100).toFixed(0)}%`);

    return reasons.join(". ") + ". Requires validation before production use.";
  }

  /**
   * Extract URLs from research result text
   */
  private extractUrlsFromResult(result: string): string[] {
    const urlRegex = /https?:\/\/[^\s)\]]+/gi;
    const matches = result.match(urlRegex) || [];

    // Clean up URLs - remove trailing punctuation
    return matches
      .map((url) => url.replace(/[.,;:!?)\]]+$/, ""))
      .filter((url, index, arr) => arr.indexOf(url) === index) // Remove duplicates
      .slice(0, 10); // Limit to first 10 URLs
  }

  /**
   * Check if URL is relevant to MCP servers
   */
  private isMCPRelevant(url: string): boolean {
    const mcpIndicators = [
      "mcp",
      "model-context-protocol",
      "mcpservers.org",
      "smithery.ai",
      "github.com",
      "npmjs.com",
      "anthropic",
      "claude",
    ];

    const urlLower = url.toLowerCase();
    return mcpIndicators.some((indicator) => urlLower.includes(indicator));
  }
}

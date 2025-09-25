import type { AgentMetadata } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import type { AgentRegistry } from "../agent-loader/registry.ts";
import { StaticMCPDiscovery } from "./static-discovery.ts";
import type { MCPDiscoveryRequest, MCPDiscoveryResult, MCPServerMetadata } from "./types.ts";

/**
 * Tier 1: Agent-based MCP discovery
 * Analyzes existing agents in the workspace to recommend MCPs they use
 */
export class AgentBasedMCPDiscovery {
  private logger = createLogger({ component: "AgentBasedMCPDiscovery" });
  private staticDiscovery = new StaticMCPDiscovery();
  private initialized = false;

  constructor(private agentRegistry: AgentRegistry) {}

  /** Initialize the discovery system */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.logger.debug("Initializing agent-based MCP discovery");
    await this.staticDiscovery.initialize();
    this.initialized = true;
  }

  /** Discover MCP servers based on agent usage patterns and requirements */
  async discover(request: MCPDiscoveryRequest): Promise<MCPDiscoveryResult[]> {
    await this.initialize();

    this.logger.debug("Starting agent-based discovery", { intent: request.intent });

    try {
      // Find agents that might be relevant to the request
      const relevantAgents = await this.findRelevantAgents(request);

      if (relevantAgents.length === 0) {
        this.logger.debug("No relevant agents found for intent", { intent: request.intent });
        return [];
      }

      // Analyze agent capabilities to infer MCP requirements
      const mcpRecommendations = this.inferMCPRequirements(relevantAgents);

      if (mcpRecommendations.length === 0) {
        this.logger.debug("No MCP requirements inferred from agents");
        return [];
      }

      // Get MCP metadata from static registry and build results
      const results = await this.buildDiscoveryResults(mcpRecommendations, request);

      this.logger.debug("Agent-based discovery completed", {
        relevantAgents: relevantAgents.length,
        recommendations: mcpRecommendations.length,
        results: results.length,
      });

      // Return single best match if suitable
      const bestResult = results.at(0);
      if (bestResult) {
        return [bestResult];
      }
      return [];
    } catch (error) {
      this.logger.error("Agent-based discovery failed", { error });
      return [];
    }
  }

  /** Find agents relevant to the discovery request */
  private async findRelevantAgents(request: MCPDiscoveryRequest): Promise<AgentMetadata[]> {
    const allAgents = await this.agentRegistry.listAgents();
    const relevantAgents: AgentMetadata[] = [];

    for (const agent of allAgents) {
      if (this.isAgentRelevant(agent, request)) {
        relevantAgents.push(agent);
      }
    }

    return relevantAgents;
  }

  /** Check if an agent is relevant to the discovery request */
  private isAgentRelevant(agent: AgentMetadata, request: MCPDiscoveryRequest): boolean {
    const intentLower = request.intent.toLowerCase();

    // Check if agent domains match request domain
    if (request.domain) {
      const agentDomains = agent.expertise.domains.map((d) => d.toLowerCase());
      if (agentDomains.includes(request.domain.toLowerCase())) {
        return true;
      }
    }

    // Check if agent capabilities or domains contain intent keywords
    const searchableText = [...agent.expertise.domains, agent.description || ""]
      .join(" ")
      .toLowerCase();

    // Extract key terms from intent
    const intentWords = intentLower.split(/\s+/).filter((word) => word.length > 2);

    return intentWords.some((word) => searchableText.includes(word));
  }

  /** Infer MCP requirements from agent definitions */
  private inferMCPRequirements(agents: AgentMetadata[]): string[] {
    const mcpIds = new Set<string>();

    for (const agent of agents) {
      if (agent.mcpRequirements) {
        agent.mcpRequirements.forEach((id) => mcpIds.add(id));
      }
    }

    return Array.from(mcpIds);
  }

  /** Build discovery results from MCP recommendations */
  private async buildDiscoveryResults(
    mcpIds: string[],
    request: MCPDiscoveryRequest,
  ): Promise<MCPDiscoveryResult[]> {
    const results: MCPDiscoveryResult[] = [];

    for (const mcpId of mcpIds) {
      const serverMetadata = await this.staticDiscovery.getServerById(mcpId);
      if (!serverMetadata) {
        continue;
      }

      const confidence = this.calculateConfidence(serverMetadata, request);
      const reasoning = this.generateReasoning(serverMetadata, request);

      results.push({ server: serverMetadata, confidence, reasoning, source: "agents" });
    }

    // Sort by confidence descending
    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /** Calculate confidence score for agent-based recommendation */
  private calculateConfidence(server: MCPServerMetadata, request: MCPDiscoveryRequest): number {
    let confidence = 0.6; // Base confidence for agent inference

    // Domain matching bonus
    if (request.domain && server.category === request.domain) {
      confidence += 0.2;
    }

    // Intent matching bonus
    const intentLower = request.intent.toLowerCase();
    const serverText = [
      server.name,
      server.description,
      ...server.useCases,
      ...server.tools.map((t) => t.name),
    ]
      .join(" ")
      .toLowerCase();

    if (this.textMatchesIntent(serverText, intentLower)) {
      confidence += 0.1;
    }

    // Security rating bonus
    if (server.securityRating === "high") {
      confidence += 0.05;
    }

    return Math.min(confidence, 0.9); // Cap at 0.9 for agent-based discovery
  }

  /** Check if text matches intent keywords */
  private textMatchesIntent(text: string, intent: string): boolean {
    const intentWords = intent.split(/\s+/).filter((word) => word.length > 2);
    return intentWords.some((word) => text.includes(word));
  }

  /** Generate reasoning for agent-based recommendation */
  private generateReasoning(server: MCPServerMetadata, request: MCPDiscoveryRequest): string {
    return `Recommended based on agent capability analysis. Agents in your workspace have capabilities that align with ${server.name} for "${request.intent}" use cases. This inference suggests compatibility with your existing agent ecosystem.`;
  }
}

import type { AgentMetadata } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import type { AgentRegistry } from "../agent-loader/registry.ts";
import { createErrorCause } from "../errors.ts";
import { StaticMCPDiscovery } from "./static-discovery.ts";
import type {
  AgentDiscoveryResult,
  AgentSource,
  MCPDiscoveryRequest,
  MCPDiscoveryResult,
  UnifiedDiscoveryResult,
} from "./types.ts";

/**
 * Unified discovery system that can return both built-in agents and MCP servers
 * Prioritizes built-in agents over external MCP servers when suitable
 */
export class UnifiedDiscovery {
  private logger = createLogger({ component: "UnifiedDiscovery" });
  private staticDiscovery = new StaticMCPDiscovery();
  private initialized = false;

  constructor(private agentRegistry: AgentRegistry) {}

  /** Initialize the discovery system */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.logger.debug("Initializing unified discovery system");
    await this.staticDiscovery.initialize();
    this.initialized = true;
  }

  /** Discover the best solution (built-in agent or MCP server) for a request */
  async discover(request: MCPDiscoveryRequest): Promise<UnifiedDiscoveryResult | null> {
    await this.initialize();

    this.logger.debug("Starting unified discovery", { intent: request.intent });

    try {
      // Step 1: Check for suitable built-in agents first
      const agentResult = await this.discoverBuiltInAgent(request);
      if (agentResult && agentResult.confidence >= 0.7) {
        this.logger.info("High-confidence built-in agent found, returning directly", {
          agentId: agentResult.agent.id,
          confidence: agentResult.confidence,
          source: agentResult.source,
        });
        return agentResult;
      }

      // Step 2: If no suitable built-in agent, look for MCP servers
      const mcpResult = await this.discoverMCPServer(request);
      if (mcpResult) {
        return { ...mcpResult, type: "mcp" as const };
      }

      // Step 3: Return lower-confidence agent if available
      if (agentResult) {
        this.logger.info("Returning lower-confidence built-in agent", {
          agentId: agentResult.agent.id,
          confidence: agentResult.confidence,
        });
        return agentResult;
      }

      this.logger.info("No suitable solutions found", { intent: request.intent });
      return null;
    } catch (error) {
      const errorCause = createErrorCause(error);
      this.logger.error("Unified discovery failed", { error: error, errorCause });
      return null;
    }
  }

  /** Discover built-in agents that can handle the request */
  private async discoverBuiltInAgent(
    request: MCPDiscoveryRequest,
  ): Promise<AgentDiscoveryResult | null> {
    try {
      // Find agents that might be relevant to the request
      const relevantAgents = await this.findRelevantAgents(request);

      if (relevantAgents.length === 0) {
        this.logger.debug("No relevant built-in agents found", { intent: request.intent });
        return null;
      }

      // Find the best matching agent
      const bestAgent = this.findBestMatchingAgent(relevantAgents, request);
      if (!bestAgent) {
        return null;
      }

      // Calculate confidence for the agent
      const confidence = this.calculateAgentConfidence(bestAgent, request);
      const reasoning = this.generateAgentReasoning(bestAgent, request, confidence);

      // Get agent source type
      const sourceType = this.getAgentSourceType(bestAgent);

      return {
        agent: {
          id: bestAgent.id,
          name: bestAgent.displayName || bestAgent.id,
          description: bestAgent.description || "",
          expertise: bestAgent.expertise,
          source: sourceType,
        },
        confidence,
        reasoning,
        source: sourceType,
        type: "agent",
      };
    } catch (error) {
      const errorCause = createErrorCause(error);
      this.logger.error("Built-in agent discovery failed", { error: error, errorCause });
      return null;
    }
  }

  /** Discover MCP servers for capabilities not covered by built-in agents */
  private async discoverMCPServer(
    request: MCPDiscoveryRequest,
  ): Promise<MCPDiscoveryResult | null> {
    try {
      const staticResults = await this.staticDiscovery.discover(request);
      if (staticResults.length > 0) {
        const bestMatch = staticResults.reduce((best, current) =>
          current.confidence > best.confidence ? current : best,
        );
        return bestMatch;
      }
      return null;
    } catch (error) {
      const errorCause = createErrorCause(error);
      this.logger.error("MCP server discovery failed", { error: error, errorCause });
      return null;
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
    const searchableText = [
      ...agent.expertise.domains,
      ...agent.expertise.capabilities,
      agent.description || "",
    ]
      .join(" ")
      .toLowerCase();

    // Extract key terms from intent
    const intentWords = intentLower.split(/\s+/).filter((word) => word.length > 2);

    return intentWords.some((word) => searchableText.includes(word));
  }

  /** Find the best matching agent from relevant candidates */
  private findBestMatchingAgent(
    agents: AgentMetadata[],
    _request: MCPDiscoveryRequest,
  ): AgentMetadata | null {
    if (agents.length === 0) return null;

    // For now, return the first match. Could be enhanced with more sophisticated scoring
    return agents.at(0) || null;
  }

  /** Calculate confidence score for an agent match */
  private calculateAgentConfidence(agent: AgentMetadata, request: MCPDiscoveryRequest): number {
    let confidence = 0.8; // Base confidence for built-in agents (higher than MCP servers)

    // Domain matching bonus
    if (request.domain) {
      const agentDomains = agent.expertise.domains.map((d) => d.toLowerCase());
      if (agentDomains.includes(request.domain.toLowerCase())) {
        confidence += 0.1;
      }
    }

    // Intent matching bonus
    const intentLower = request.intent.toLowerCase();
    const agentText = [
      ...agent.expertise.domains,
      ...agent.expertise.capabilities,
      agent.description || "",
    ]
      .join(" ")
      .toLowerCase();

    const intentWords = intentLower.split(/\s+/).filter((word) => word.length > 2);
    const matchingWords = intentWords.filter((word) => agentText.includes(word));

    if (matchingWords.length > 0) {
      confidence += Math.min(0.1, matchingWords.length * 0.02);
    }

    return Math.min(confidence, 0.95); // Cap at 0.95
  }

  /** Generate reasoning for agent recommendation */
  private generateAgentReasoning(
    agent: AgentMetadata,
    request: MCPDiscoveryRequest,
    confidence: number,
  ): string {
    const reasons: string[] = [];

    reasons.push(
      `Built-in agent "${agent.displayName || agent.id}" matches your request for "${request.intent}"`,
    );

    if (agent.expertise.domains.length > 0) {
      reasons.push(`Specializes in: ${agent.expertise.domains.join(", ")}`);
    }

    if (agent.expertise.capabilities.length > 0) {
      reasons.push(`Capabilities: ${agent.expertise.capabilities.join(", ")}`);
    }

    reasons.push(`Confidence: ${(confidence * 100).toFixed(0)}%`);
    reasons.push("No external dependencies required - runs directly within Atlas");

    return reasons.join(". ") + ".";
  }

  /** Get the source type for an agent */
  private getAgentSourceType(_agent: AgentMetadata): AgentSource {
    // This is a simplified implementation - in a real system, you'd track this properly
    // For now, we'll assume most agents are bundled unless we can determine otherwise
    return "bundled";
  }
}

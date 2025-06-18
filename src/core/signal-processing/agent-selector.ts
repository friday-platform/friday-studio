/**
 * Agent Selection Logic
 * Intelligently selects the best agent for a given task based on capabilities
 */

import { logger } from "../../utils/logger.ts";
import type { AgentCapabilities, AgentRoutingRule, EnhancedTask } from "./types.ts";

export interface AgentInfo {
  id: string;
  name: string;
  type: string;
  capabilities?: AgentCapabilities;
  metadata?: Record<string, any>;
}

export class AgentSelector {
  private routingRules: AgentRoutingRule[] = [];
  private agentCapabilities: Map<string, AgentCapabilities> = new Map();

  constructor(routingRules: AgentRoutingRule[] = []) {
    this.routingRules = routingRules;
  }

  /**
   * Add routing rules
   */
  addRoutingRules(rules: AgentRoutingRule[]): void {
    this.routingRules.push(...rules);
    logger.debug("Added agent routing rules", {
      newRules: rules.length,
      totalRules: this.routingRules.length,
    });
  }

  /**
   * Register agent capabilities
   */
  registerAgentCapabilities(agentId: string, capabilities: AgentCapabilities): void {
    this.agentCapabilities.set(agentId, capabilities);
    logger.debug("Registered agent capabilities", {
      agentId,
      domains: capabilities.domains.length,
      actions: capabilities.actions.length,
      resourceTypes: capabilities.resourceTypes.length,
    });
  }

  /**
   * Select the best agent for a task
   */
  selectAgent(task: EnhancedTask, availableAgents: AgentInfo[]): AgentInfo | null {
    logger.debug("Selecting agent for task", {
      taskDescription: task.description,
      actionType: task.action.type,
      requiredCapabilities: task.requiredCapabilities,
      availableAgents: availableAgents.length,
    });

    if (availableAgents.length === 0) {
      logger.warn("No agents available for task selection");
      return null;
    }

    // Step 1: Apply routing rules
    const routedAgents = this.applyRoutingRules(task, availableAgents);

    if (routedAgents.length === 0) {
      logger.warn("No agents matched routing rules, using capability-based selection");
      return this.selectByCapabilities(task, availableAgents);
    }

    // Step 2: Score agents by capability match
    const scoredAgents = this.scoreAgents(task, routedAgents);

    // Step 3: Select best agent
    const bestAgent = scoredAgents[0];

    logger.info("Agent selected for task", {
      selectedAgent: bestAgent.agent.id,
      score: bestAgent.score,
      taskDescription: task.description,
      selectionMethod: "routing_rules",
    });

    return bestAgent.agent;
  }

  /**
   * Apply routing rules to filter agents
   */
  private applyRoutingRules(task: EnhancedTask, agents: AgentInfo[]): AgentInfo[] {
    const matchingRules = this.findMatchingRules(task);

    if (matchingRules.length === 0) {
      return agents;
    }

    // Collect all preferred and fallback agents from matching rules
    const preferredAgentIds = new Set<string>();
    const fallbackAgentIds = new Set<string>();

    for (const rule of matchingRules) {
      rule.preferredAgents.forEach((id) => preferredAgentIds.add(id));
      rule.fallbackAgents.forEach((id) => fallbackAgentIds.add(id));
    }

    // Filter available agents
    const availableAgentIds = new Set(agents.map((a) => a.id));

    // First try preferred agents
    const availablePreferred = Array.from(preferredAgentIds)
      .filter((id) => availableAgentIds.has(id))
      .map((id) => agents.find((a) => a.id === id)!)
      .filter(Boolean);

    if (availablePreferred.length > 0) {
      return availablePreferred;
    }

    // Fall back to fallback agents
    const availableFallback = Array.from(fallbackAgentIds)
      .filter((id) => availableAgentIds.has(id))
      .map((id) => agents.find((a) => a.id === id)!)
      .filter(Boolean);

    return availableFallback;
  }

  /**
   * Find routing rules that match the task
   */
  private findMatchingRules(task: EnhancedTask): AgentRoutingRule[] {
    return this.routingRules.filter((rule) => {
      // Check if task requires the capability
      const requiredCapability = rule.capability;

      // Simple capability matching - can be enhanced
      return task.requiredCapabilities.some((cap) =>
        cap === requiredCapability ||
        cap.startsWith(requiredCapability.split(".")[0])
      );
    });
  }

  /**
   * Score agents by capability match
   */
  private scoreAgents(
    task: EnhancedTask,
    agents: AgentInfo[],
  ): Array<{ agent: AgentInfo; score: number }> {
    const scored = agents.map((agent) => ({
      agent,
      score: this.calculateAgentScore(task, agent),
    }));

    // Sort by score (highest first)
    return scored.sort((a, b) => b.score - a.score);
  }

  /**
   * Calculate score for an agent based on task requirements
   */
  private calculateAgentScore(task: EnhancedTask, agent: AgentInfo): number {
    let score = 0;

    // Get agent capabilities
    const capabilities = this.agentCapabilities.get(agent.id) || agent.capabilities;

    if (!capabilities) {
      // Default score for agents without registered capabilities
      return 1;
    }

    // Score based on domain match
    const taskDomain = this.extractDomainFromTask(task);
    if (capabilities.domains.includes(taskDomain)) {
      score += 10;
    }

    // Score based on action match
    if (capabilities.actions.includes(task.action.type)) {
      score += 8;
    }

    // Score based on complexity match
    if (capabilities.complexityLevels.includes(task.estimatedComplexity)) {
      score += 5;
    }

    // Score based on resource type match
    const taskResourceType = task.action.target.type;
    if (capabilities.resourceTypes.includes(taskResourceType)) {
      score += 6;
    }

    // Score based on required capabilities match
    const matchedCapabilities = task.requiredCapabilities.filter((cap) => {
      return capabilities.domains.includes(cap) ||
        capabilities.actions.includes(cap) ||
        capabilities.resourceTypes.includes(cap);
    });
    score += matchedCapabilities.length * 3;

    return score;
  }

  /**
   * Extract domain from task for capability matching
   */
  private extractDomainFromTask(task: EnhancedTask): string {
    // Try to extract domain from required capabilities
    for (const capability of task.requiredCapabilities) {
      if (capability.includes(".")) {
        return capability.split(".")[0];
      }
    }

    // Fallback to target type
    return task.action.target.type;
  }

  /**
   * Select agent by capabilities only (fallback method)
   */
  private selectByCapabilities(task: EnhancedTask, agents: AgentInfo[]): AgentInfo | null {
    const scoredAgents = this.scoreAgents(task, agents);

    if (scoredAgents.length === 0) {
      return null;
    }

    const bestAgent = scoredAgents[0];

    logger.info("Agent selected by capabilities", {
      selectedAgent: bestAgent.agent.id,
      score: bestAgent.score,
      taskDescription: task.description,
      selectionMethod: "capabilities",
    });

    return bestAgent.agent;
  }

  /**
   * Get agent selection statistics
   */
  getSelectionStats(): {
    totalRules: number;
    registeredAgents: number;
    capabilityDomains: string[];
  } {
    const allDomains = new Set<string>();

    for (const capabilities of this.agentCapabilities.values()) {
      capabilities.domains.forEach((domain) => allDomains.add(domain));
    }

    return {
      totalRules: this.routingRules.length,
      registeredAgents: this.agentCapabilities.size,
      capabilityDomains: Array.from(allDomains),
    };
  }
}

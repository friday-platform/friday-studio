import type { AgentMetadata, AtlasAgent } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { BundledAgentAdapter } from "./adapters/bundled-adapter.ts";
import { SDKAgentAdapter } from "./adapters/sdk-adapter.ts";
import { SystemAgentAdapter } from "./adapters/system-adapter.ts";
import type { AgentSourceType, AgentSummary } from "./adapters/types.ts";
import { UserAdapter } from "./adapters/user-adapter.ts";
import { AgentLoader, type LoaderOptions } from "./loader.ts";

/** Options for configuring the agent registry */
interface RegistryOptions extends LoaderOptions {
  /** Whether to include system agents (only for system workspaces) */
  includeSystemAgents?: boolean;
  /** Custom paths to search for YAML agents */
  agentPaths?: string[];
  /** Whether to watch for YAML file changes */
  watchForChanges?: boolean;
  /** Directory containing user-built agent artifacts (e.g. ~/.friday/local/agents) */
  userAgentsDir?: string;
}

/**
 * High-level registry that manages agent discovery and access.
 * Controls agent visibility based on workspace type and handles initialization.
 */
export class AgentRegistry {
  private loader: AgentLoader;
  private registeredAgents = new Map<string, AtlasAgent>();
  private agentSourceTypes = new Map<string, AgentSourceType>();
  /** User agents can't be converted to AtlasAgent — store summaries separately */
  private userAgentSummaries = new Map<string, AgentSummary>();
  private includeSystemAgents: boolean;
  private userAgentsDir?: string;
  private sdkAdapter?: SDKAgentAdapter;
  private logger = createLogger({ component: "AgentRegistry" });
  private initialized = false;

  constructor(options: RegistryOptions = {}) {
    this.includeSystemAgents = options.includeSystemAgents ?? false;
    this.userAgentsDir = options.userAgentsDir;
    this.loader = new AgentLoader(options);
    this.setupDefaultAdapters();
  }

  /** Set up default adapters based on configuration */
  private setupDefaultAdapters(): void {
    if (this.includeSystemAgents) {
      this.loader.addAdapter(new SystemAgentAdapter());
      this.logger.debug("Added system agent adapter");
    }

    this.loader.addAdapter(new BundledAgentAdapter());
    this.logger.debug("Added bundled agent adapter");

    if (this.userAgentsDir) {
      this.loader.addAdapter(new UserAdapter(this.userAgentsDir));
      this.logger.debug("Added user agent adapter", { dir: this.userAgentsDir });
    }

    this.sdkAdapter = new SDKAgentAdapter();
    this.loader.addAdapter(this.sdkAdapter);
    this.logger.debug("Added SDK agent adapter");
  }

  /** Initialize the registry by loading all available agents */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this.logger.debug("Registry already initialized");
      return;
    }

    this.logger.info("Initializing agent registry...");

    const agentList = await this.loader.listAgents();
    this.logger.info("Found agents", { count: agentList.length });

    let successCount = 0;
    let failureCount = 0;

    for (const agentSummary of agentList) {
      // User agents are subprocess agents — they don't produce AtlasAgent instances.
      // Store their summaries; ProcessAgentExecutor handles execution at runtime via NATS.
      if (agentSummary.type === "user") {
        this.userAgentSummaries.set(agentSummary.id, agentSummary);
        this.agentSourceTypes.set(agentSummary.id, "user");
        successCount++;
        this.logger.debug("Registered user agent", { id: agentSummary.id });
        continue;
      }

      try {
        const agent = await this.loader.loadAgent(agentSummary.id);
        this.registeredAgents.set(agentSummary.id, agent);
        this.agentSourceTypes.set(agentSummary.id, agentSummary.type);
        successCount++;
        this.logger.debug("Loaded agent", { id: agentSummary.id, sourceType: agentSummary.type });
      } catch (error) {
        failureCount++;
        this.logger.error("Failed to load agent", { id: agentSummary.id, error });
      }
    }

    this.logger.info("Registry initialized", { loaded: successCount, failures: failureCount });

    this.initialized = true;
  }

  /** Register an SDK agent programmatically */
  async registerAgent(agent: AtlasAgent): Promise<void> {
    if (!this.sdkAdapter) {
      throw new Error("SDK adapter not initialized");
    }

    const id = agent.metadata.id;
    // Align with SDK interface which expects a Promise-returning method
    await Promise.resolve(this.sdkAdapter.registerAgent(agent));
    this.registeredAgents.set(id, agent);
    this.agentSourceTypes.set(id, "sdk");
    this.logger.debug("Registered SDK agent", { id });
  }

  /** Get a specific agent by ID. Returns undefined for user agents (executed via NATS). */
  async getAgent(id: string): Promise<AtlasAgent | undefined> {
    if (this.registeredAgents.has(id)) {
      return this.registeredAgents.get(id);
    }

    // User agents aren't AtlasAgent instances — they're executed via ProcessAgentExecutor/NATS
    if (this.userAgentSummaries.has(id)) {
      return undefined;
    }

    try {
      const agent = await this.loader.loadAgent(id);
      this.registeredAgents.set(id, agent);
      const agentList = await this.loader.listAgents();
      const agentSummary = agentList.find((a) => a.id === id);
      if (agentSummary) {
        this.agentSourceTypes.set(id, agentSummary.type);
      }
      return agent;
    } catch {
      return undefined;
    }
  }

  /** Get the source type for a registered agent */
  getAgentSourceType(id: string): AgentSourceType | undefined {
    return this.agentSourceTypes.get(id);
  }

  /** Get a user agent summary by ID */
  getUserAgentSummary(id: string): AgentSummary | undefined {
    return this.userAgentSummaries.get(id);
  }

  /**
   * List all agents including user agents.
   * System agents are excluded unless this is a system workspace registry.
   */
  async listAgents(): Promise<AgentMetadata[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const agents: AgentMetadata[] = Array.from(this.registeredAgents.values()).map(
      (agent) => agent.metadata,
    );

    // Include user agents from summaries (they don't have AtlasAgent instances)
    for (const summary of this.userAgentSummaries.values()) {
      agents.push({
        id: summary.id,
        displayName: summary.displayName,
        description: summary.description ?? "",
        version: summary.version ?? "0.0.0",
        expertise: { examples: [] },
      });
    }

    return agents;
  }

  /** Check if an agent exists */
  async exists(id: string): Promise<boolean> {
    if (this.registeredAgents.has(id) || this.userAgentSummaries.has(id)) {
      return true;
    }

    return await this.loader.exists(id);
  }

  /** Reload the registry — re-scans all adapters including user agents on disk */
  async reload(): Promise<void> {
    this.logger.info("Reloading agent registry...");

    this.registeredAgents.clear();
    this.agentSourceTypes.clear();
    this.userAgentSummaries.clear();
    this.loader.clearCache();
    this.initialized = false;

    await this.initialize();
  }

  /** Get registry statistics */
  getStats(): {
    totalAgents: number;
    systemAgents: number;
    bundledAgents: number;
    userAgents: number;
    sdkAgents: number;
  } {
    const allIds = Array.from(this.agentSourceTypes.keys());

    return {
      totalAgents: allIds.length,
      systemAgents: allIds.filter((id) => this.agentSourceTypes.get(id) === "system").length,
      bundledAgents: allIds.filter((id) => this.agentSourceTypes.get(id) === "bundled").length,
      userAgents: allIds.filter((id) => this.agentSourceTypes.get(id) === "user").length,
      sdkAgents: allIds.filter((id) => this.agentSourceTypes.get(id) === "sdk").length,
    };
  }
}

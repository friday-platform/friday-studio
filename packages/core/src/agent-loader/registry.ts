import type { AgentMetadata, AtlasAgent } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { BundledAgentAdapter } from "./adapters/bundled-adapter.ts";
import { SDKAgentAdapter } from "./adapters/sdk-adapter.ts";
import { SystemAgentAdapter } from "./adapters/system-adapter.ts";
import type { AgentSourceType } from "./adapters/types.ts";
import { AgentLoader, type LoaderOptions } from "./loader.ts";

/** Options for configuring the agent registry */
interface RegistryOptions extends LoaderOptions {
  /** Whether to include system agents (only for system workspaces) */
  includeSystemAgents?: boolean;
  /** Custom paths to search for YAML agents */
  agentPaths?: string[];
  /** Whether to watch for YAML file changes */
  watchForChanges?: boolean;
}

/**
 * High-level registry that manages agent discovery and access.
 * Controls agent visibility based on workspace type and handles initialization.
 */
export class AgentRegistry {
  private loader: AgentLoader;
  private registeredAgents = new Map<string, AtlasAgent>();
  private agentSourceTypes = new Map<string, AgentSourceType>();
  private includeSystemAgents: boolean;
  private sdkAdapter?: SDKAgentAdapter;
  private logger = createLogger({ component: "AgentRegistry" });
  private initialized = false;

  constructor(options: RegistryOptions = {}) {
    this.includeSystemAgents = options.includeSystemAgents ?? false;
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

  /** Get a specific agent by ID */
  async getAgent(id: string): Promise<AtlasAgent | undefined> {
    if (this.registeredAgents.has(id)) {
      return this.registeredAgents.get(id);
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

  /**
   * List all agents.
   * System agents are excluded unless this is a system workspace registry.
   */
  async listAgents(): Promise<AgentMetadata[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    return Array.from(this.registeredAgents.values()).map((agent) => agent.metadata);
  }

  /** Check if an agent exists */
  async exists(id: string): Promise<boolean> {
    if (this.registeredAgents.has(id)) {
      return true;
    }

    return await this.loader.exists(id);
  }

  /** Reload the registry */
  async reload(): Promise<void> {
    this.logger.info("Reloading agent registry...");

    this.registeredAgents.clear();
    this.agentSourceTypes.clear();
    this.loader.clearCache();
    this.initialized = false;

    await this.initialize();
  }

  /** Get registry statistics */
  getStats(): {
    totalAgents: number;
    systemAgents: number;
    bundledAgents: number;
    sdkAgents: number;
  } {
    const agentIds = Array.from(this.registeredAgents.keys());

    return {
      totalAgents: agentIds.length,
      systemAgents: agentIds.filter((id) => this.agentSourceTypes.get(id) === "system").length,
      bundledAgents: agentIds.filter((id) => this.agentSourceTypes.get(id) === "bundled").length,
      sdkAgents: agentIds.filter((id) => this.agentSourceTypes.get(id) === "sdk").length,
    };
  }
}

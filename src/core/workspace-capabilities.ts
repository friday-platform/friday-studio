/**
 * Built-in Workspace Capabilities Registry
 * Manages ambient workspace capabilities that are available to agents
 */

import type { WorkspaceAgentConfig } from "@atlas/config";

export interface WorkspaceCapability {
  id: string;
  name: string;
  description: string;
  category: "jobs" | "sessions" | "memory" | "signals" | "workspace";
  implementation: (context: AgentExecutionContext, ...args: any[]) => Promise<any>;
}

export interface AgentExecutionContext {
  workspaceId: string;
  sessionId: string;
  agentId: string;
  // Runtime services
  workspaceRuntime?: any;
  sessionSupervisor?: any;
  memoryManager?: any;
}

export interface CapabilityFilter {
  agentId: string;
  agentConfig: WorkspaceAgentConfig;
  grantedTools: string[];
}

export class WorkspaceCapabilityRegistry {
  private static capabilities = new Map<string, WorkspaceCapability>();
  private static initialized = false;

  /**
   * Initialize built-in workspace capabilities
   */
  static initialize(): void {
    if (this.initialized) return;

    // Jobs capabilities
    this.registerCapability({
      id: "workspace_jobs_trigger",
      name: "Trigger Job",
      description: "Trigger a job in the current workspace",
      category: "jobs",
      implementation: async (context, jobName: string, payload?: any) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.triggerJob(jobName, payload);
      },
    });

    this.registerCapability({
      id: "workspace_jobs_list",
      name: "List Jobs",
      description: "List all jobs in the current workspace",
      category: "jobs",
      implementation: async (context) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.listJobs();
      },
    });

    this.registerCapability({
      id: "workspace_jobs_describe",
      name: "Describe Job",
      description: "Get detailed information about a specific job",
      category: "jobs",
      implementation: async (context, jobName: string) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.describeJob(jobName);
      },
    });

    // Sessions capabilities
    this.registerCapability({
      id: "workspace_sessions_list",
      name: "List Sessions",
      description: "List all sessions in the current workspace",
      category: "sessions",
      implementation: async (context) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.listSessions();
      },
    });

    this.registerCapability({
      id: "workspace_sessions_describe",
      name: "Describe Session",
      description: "Get detailed information about a specific session",
      category: "sessions",
      implementation: async (context, sessionId: string) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.describeSession(sessionId);
      },
    });

    this.registerCapability({
      id: "workspace_sessions_cancel",
      name: "Cancel Session",
      description: "Cancel a running session",
      category: "sessions",
      implementation: async (context, sessionId: string) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.cancelSession(sessionId);
      },
    });

    // Memory capabilities
    this.registerCapability({
      id: "workspace_memory_recall",
      name: "Recall Memory",
      description: "Retrieve memories based on query",
      category: "memory",
      implementation: async (context, query: string, options?: any) => {
        if (!context.memoryManager) {
          throw new Error("Memory manager not available");
        }
        return await context.memoryManager.recall(query, options);
      },
    });

    this.registerCapability({
      id: "workspace_memory_store",
      name: "Store Memory",
      description: "Store information in memory",
      category: "memory",
      implementation: async (context, content: any, type?: string) => {
        if (!context.memoryManager) {
          throw new Error("Memory manager not available");
        }
        return await context.memoryManager.store(content, type);
      },
    });

    // Signals capabilities
    this.registerCapability({
      id: "workspace_signals_list",
      name: "List Signals",
      description: "List all signals in the current workspace",
      category: "signals",
      implementation: async (context) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.listSignals();
      },
    });

    this.registerCapability({
      id: "workspace_signals_trigger",
      name: "Trigger Signal",
      description: "Trigger a signal in the current workspace",
      category: "signals",
      implementation: async (context, signalName: string, payload?: any) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.triggerSignal(signalName, payload);
      },
    });

    // Workspace capabilities
    this.registerCapability({
      id: "workspace_describe",
      name: "Describe Workspace",
      description: "Get information about the current workspace",
      category: "workspace",
      implementation: async (context) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.describeWorkspace();
      },
    });

    this.initialized = true;
  }

  /**
   * Register a new workspace capability
   */
  static registerCapability(capability: WorkspaceCapability): void {
    this.capabilities.set(capability.id, capability);
  }

  /**
   * Get all available capabilities
   */
  static getAllCapabilities(): WorkspaceCapability[] {
    this.initialize();
    return Array.from(this.capabilities.values());
  }

  /**
   * Get capability by ID
   */
  static getCapability(id: string): WorkspaceCapability | undefined {
    this.initialize();
    return this.capabilities.get(id);
  }

  /**
   * Filter capabilities for a specific agent based on granted tools
   */
  static filterCapabilitiesForAgent(filter: CapabilityFilter): WorkspaceCapability[] {
    this.initialize();

    const grantedCapabilities: WorkspaceCapability[] = [];
    const allTools = [
      ...(filter.agentConfig.default_tools || []),
      ...(Array.isArray(filter.agentConfig.tools) ? filter.agentConfig.tools : []),
      ...filter.grantedTools,
    ];

    for (const tool of allTools) {
      const capability = this.capabilities.get(tool);
      if (capability) {
        grantedCapabilities.push(capability);
      } else if (tool.endsWith("_*")) {
        // Handle wildcard patterns
        const prefix = tool.slice(0, -2);
        for (const [id, cap] of this.capabilities) {
          if (id.startsWith(prefix + "_")) {
            grantedCapabilities.push(cap);
          }
        }
      } else if (tool.endsWith(".*")) {
        // Handle legacy dot wildcard patterns (convert to underscore)
        const prefix = tool.slice(0, -2).replace(/\./g, "_");
        for (const [id, cap] of this.capabilities) {
          if (id.startsWith(prefix + "_")) {
            grantedCapabilities.push(cap);
          }
        }
      }
    }

    // Remove duplicates
    const unique = new Map<string, WorkspaceCapability>();
    for (const cap of grantedCapabilities) {
      unique.set(cap.id, cap);
    }

    return Array.from(unique.values());
  }

  /**
   * Create agent execution context with filtered capabilities
   */
  static createAgentContext(
    workspaceId: string,
    sessionId: string,
    agentId: string,
    agentConfig: WorkspaceAgentConfig,
    grantedTools: string[],
    runtimeServices: {
      workspaceRuntime?: any;
      sessionSupervisor?: any;
      memoryManager?: any;
    } = {},
  ): { context: AgentExecutionContext; capabilities: WorkspaceCapability[] } {
    const context: AgentExecutionContext = {
      workspaceId,
      sessionId,
      agentId,
      ...runtimeServices,
    };

    const capabilities = this.filterCapabilitiesForAgent({
      agentId,
      agentConfig,
      grantedTools,
    });

    return { context, capabilities };
  }

  /**
   * Execute a capability
   */
  static async executeCapability(
    capabilityId: string,
    context: AgentExecutionContext,
    ...args: any[]
  ): Promise<any> {
    this.initialize();

    const capability = this.capabilities.get(capabilityId);
    if (!capability) {
      throw new Error(`Unknown capability: ${capabilityId}`);
    }

    return await capability.implementation(context, ...args);
  }

  /**
   * Get capability documentation
   */
  static getDocumentation(): string {
    this.initialize();

    const categories = new Map<string, WorkspaceCapability[]>();
    for (const capability of this.capabilities.values()) {
      if (!categories.has(capability.category)) {
        categories.set(capability.category, []);
      }
      categories.get(capability.category)!.push(capability);
    }

    let doc = "# Atlas Workspace Capabilities\n\n";
    doc += "Built-in capabilities available to agents in Atlas workspaces.\n\n";

    for (const [category, caps] of categories) {
      doc += `## ${category.charAt(0).toUpperCase() + category.slice(1)} Capabilities\n\n`;

      for (const cap of caps) {
        doc += `### ${cap.name} (\`${cap.id}\`)\n`;
        doc += `${cap.description}\n\n`;
      }
    }

    doc += `## Usage in Agent Configuration\n\n`;
    doc += `\`\`\`yaml\n`;
    doc += `agents:\n`;
    doc += `  my-agent:\n`;
    doc += `    type: "llm"\n`;
    doc += `    tools:\n`;
    doc += `      - "workspace_jobs_trigger"\n`;
    doc += `      - "workspace_memory_recall"\n`;
    doc += `      - "workspace_sessions_*"  # Wildcard for all session capabilities\n`;
    doc += `\`\`\`\n\n`;

    return doc;
  }

  /**
   * Reset registry (useful for testing)
   */
  static reset(): void {
    this.capabilities.clear();
    this.initialized = false;
  }
}

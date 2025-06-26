/**
 * Federation Integration Module
 * Integrates federation capabilities with existing WorkspaceRuntime
 */

import type { WorkspaceRuntime } from "./workspace-runtime.ts";
import type { AtlasConfig, NewWorkspaceConfig } from "./config-loader.ts";
import { FederationManager } from "./federation-manager.ts";
import { WorkspaceCapabilityRegistry } from "./workspace-capabilities.ts";
import { PlatformMCPServer } from "./mcp/platform-mcp-server.ts";
import { WorkspaceMCPServer } from "./mcp/workspace-mcp-server.ts";
import { MCPProxy } from "./mcp/mcp-proxy.ts";
import { logger } from "../utils/logger.ts";

export interface FederationIntegrationOptions {
  enablePlatformMCPServer?: boolean;
  enableWorkspaceMCPServer?: boolean;
  enableFederation?: boolean;
  enableBuiltinCapabilities?: boolean;
}

export interface FederatedWorkspaceRuntime extends WorkspaceRuntime {
  // New federation methods
  federationManager: FederationManager;
  mcpProxy: MCPProxy;
  platformMCPServer?: PlatformMCPServer;
  workspaceMCPServer?: WorkspaceMCPServer;

  // Enhanced runtime methods
  triggerFederatedJob(targetWorkspace: string, jobName: string, payload?: any): Promise<any>;
  listAccessibleWorkspaces(): Promise<string[]>;
  getGrantedCapabilities(targetWorkspace: string): Promise<string[]>;
}

export class FederationIntegration {
  private atlasConfig: AtlasConfig;
  private workspaceConfig: NewWorkspaceConfig;
  private federationManager: FederationManager;
  private mcpProxy: MCPProxy;
  private platformMCPServer?: PlatformMCPServer;
  private workspaceMCPServer?: WorkspaceMCPServer;
  private workspaceMCPServers = new Map<string, WorkspaceMCPServer>();

  constructor(
    atlasConfig: AtlasConfig,
    workspaceConfig: NewWorkspaceConfig,
    options: FederationIntegrationOptions = {},
  ) {
    this.atlasConfig = atlasConfig;
    this.workspaceConfig = workspaceConfig;

    // Initialize federation manager
    this.federationManager = new FederationManager(atlasConfig);

    // Initialize built-in capabilities registry
    if (options.enableBuiltinCapabilities !== false) {
      WorkspaceCapabilityRegistry.initialize();
    }

    // Initialize MCP proxy
    this.mcpProxy = new MCPProxy({
      atlasConfig,
      federationManager: this.federationManager,
      workspaceMCPServers: this.workspaceMCPServers,
    });

    logger.info("Federation integration initialized", {
      operation: "federation_integration_init",
      workspaceId: workspaceConfig.workspace.id,
      federationEnabled: !!atlasConfig.federation,
      platformMCPEnabled: options.enablePlatformMCPServer,
      workspaceMCPEnabled: options.enableWorkspaceMCPServer,
    });
  }

  /**
   * Enhance an existing WorkspaceRuntime with federation capabilities
   */
  async enhanceRuntime(
    runtime: WorkspaceRuntime,
    options: FederationIntegrationOptions = {},
  ): Promise<FederatedWorkspaceRuntime> {
    const federatedRuntime = runtime as FederatedWorkspaceRuntime;

    // Add federation manager
    federatedRuntime.federationManager = this.federationManager;
    federatedRuntime.mcpProxy = this.mcpProxy;

    // Initialize platform MCP server (if this is the platform workspace)
    if (options.enablePlatformMCPServer && this.isPlatformWorkspace()) {
      federatedRuntime.platformMCPServer = await this.createPlatformMCPServer(runtime);
      logger.info("Platform MCP server initialized", {
        operation: "federation_platform_mcp_init",
        workspaceId: this.workspaceConfig.workspace.id,
      });
    }

    // Initialize workspace MCP server
    if (options.enableWorkspaceMCPServer) {
      federatedRuntime.workspaceMCPServer = await this.createWorkspaceMCPServer(runtime);
      this.workspaceMCPServers.set(
        this.workspaceConfig.workspace.id,
        federatedRuntime.workspaceMCPServer,
      );
      logger.info("Workspace MCP server initialized", {
        operation: "federation_workspace_mcp_init",
        workspaceId: this.workspaceConfig.workspace.id,
      });
    }

    // Add federation methods
    federatedRuntime.triggerFederatedJob = async (
      targetWorkspace: string,
      jobName: string,
      payload?: any,
    ) => {
      return await this.triggerFederatedJob(
        federatedRuntime,
        targetWorkspace,
        jobName,
        payload,
      );
    };

    federatedRuntime.listAccessibleWorkspaces = async () => {
      return this.federationManager.getAccessibleWorkspaces(
        this.workspaceConfig.workspace.id,
      );
    };

    federatedRuntime.getGrantedCapabilities = async (targetWorkspace: string) => {
      return this.federationManager.getGrantedCapabilities(
        this.workspaceConfig.workspace.id,
        targetWorkspace,
      );
    };

    return federatedRuntime;
  }

  /**
   * Create agent execution context with built-in capabilities
   */
  createAgentExecutionContext(
    runtime: WorkspaceRuntime,
    sessionId: string,
    agentId: string,
    agentConfig: any,
    grantedTools: string[] = [],
  ): any {
    const { context, capabilities } = WorkspaceCapabilityRegistry.createAgentContext(
      this.workspaceConfig.workspace.id,
      sessionId,
      agentId,
      agentConfig,
      grantedTools,
      {
        workspaceRuntime: runtime,
        // Add other runtime services as needed
      },
    );

    // Convert capabilities to callable functions
    const capabilityFunctions: Record<string, Function> = {};
    for (const capability of capabilities) {
      capabilityFunctions[capability.id] = async (...args: any[]) => {
        return await WorkspaceCapabilityRegistry.executeCapability(
          capability.id,
          context,
          ...args,
        );
      };
    }

    return {
      context,
      capabilities: capabilityFunctions,
      availableCapabilities: capabilities.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        category: c.category,
      })),
    };
  }

  /**
   * Get federation statistics
   */
  getFederationStats(): any {
    return {
      federationManager: this.federationManager.getStats(),
      workspaceMCPServers: this.workspaceMCPServers.size,
      platformMCPEnabled: !!this.platformMCPServer,
      workspaceMCPEnabled: !!this.workspaceMCPServer,
    };
  }

  // Private helper methods

  private isPlatformWorkspace(): boolean {
    return this.workspaceConfig.workspace.id === "atlas-platform" ||
      this.workspaceConfig.workspace.id === this.atlasConfig.workspace?.id;
  }

  private async createPlatformMCPServer(runtime: WorkspaceRuntime): Promise<PlatformMCPServer> {
    const dependencies = {
      workspaceRegistry: {
        async listWorkspaces() {
          // This would be implemented to list all workspaces
          return [
            { id: "atlas-platform", name: "Atlas Platform" },
            // Add other workspaces from registry
          ];
        },
        async createWorkspace(config: any) {
          // This would be implemented to create new workspaces
          return { id: crypto.randomUUID(), name: config.name };
        },
        async deleteWorkspace(id: string, force?: boolean) {
          // This would be implemented to delete workspaces
        },
        async describeWorkspace(id: string) {
          // This would be implemented to describe workspaces
          return { id, name: "Example Workspace" };
        },
      },
      atlasConfig: this.atlasConfig,
    };

    return new PlatformMCPServer(dependencies);
  }

  private async createWorkspaceMCPServer(runtime: WorkspaceRuntime): Promise<WorkspaceMCPServer> {
    const dependencies = {
      workspaceRuntime: {
        async listJobs() {
          return Object.keys(this.workspaceConfig.jobs || {}).map((name) => ({
            name,
            description: this.workspaceConfig.jobs![name].description,
          }));
        },
        async triggerJob(jobName: string, payload?: any) {
          // This would integrate with the actual runtime job triggering
          return { sessionId: crypto.randomUUID() };
        },
        async describeJob(jobName: string) {
          return this.workspaceConfig.jobs?.[jobName] || null;
        },
        async listSessions() {
          // This would get sessions from the runtime
          return [];
        },
        async describeSession(sessionId: string) {
          // This would get session details from the runtime
          return { id: sessionId, status: "unknown" };
        },
        async cancelSession(sessionId: string) {
          // This would cancel a session in the runtime
        },
        async listSignals() {
          return Object.keys(this.workspaceConfig.signals || {}).map((name) => ({
            name,
            description: this.workspaceConfig.signals![name].description,
          }));
        },
        async triggerSignal(signalName: string, payload?: any) {
          // This would trigger a signal in the runtime
        },
        async listAgents() {
          return Object.keys(this.workspaceConfig.agents || {}).map((id) => ({
            id,
            type: this.workspaceConfig.agents![id].type,
            purpose: this.workspaceConfig.agents![id].purpose,
          }));
        },
        async describeAgent(agentId: string) {
          return this.workspaceConfig.agents?.[agentId] || null;
        },
      },
      workspaceConfig: this.workspaceConfig,
    };

    return new WorkspaceMCPServer(dependencies);
  }

  private async triggerFederatedJob(
    runtime: FederatedWorkspaceRuntime,
    targetWorkspace: string,
    jobName: string,
    payload?: any,
  ): Promise<any> {
    // Use MCP proxy to trigger job in target workspace
    const result = await this.mcpProxy.routeCall(
      {
        type: "atlas-proxy",
        target: targetWorkspace,
      },
      {
        tool: "workspace.jobs.trigger",
        arguments: { jobName, payload },
        sourceWorkspace: this.workspaceConfig.workspace.id,
        targetWorkspace,
      },
    );

    if (!result.success) {
      throw new Error(`Federation job trigger failed: ${result.error}`);
    }

    return result.result;
  }
}

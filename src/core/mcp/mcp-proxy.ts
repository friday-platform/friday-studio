/**
 * MCP Proxy for Atlas
 * Handles atlas-proxy transport type for cross-workspace communication
 */

import { z } from "zod/v4";
import type { AtlasConfig } from "../config-loader.ts";
import { FederationManager } from "../federation-manager.ts";

// Atlas proxy transport configuration
const AtlasProxyTransportSchema = z.object({
  type: z.literal("atlas-proxy"),
  target: z.enum(["platform"]).or(z.string()), // "platform" or workspace ID
  workspace: z.string().optional(), // For workspace targets
  remote: z.string().optional(), // For remote Atlas instances
});

export type AtlasProxyTransport = z.infer<typeof AtlasProxyTransportSchema>;

export interface MCPProxyCall {
  tool: string;
  arguments: Record<string, any>;
  sourceWorkspace: string;
  targetWorkspace?: string;
}

export interface MCPProxyResponse {
  success: boolean;
  result?: any;
  error?: string;
  federationCheck?: {
    allowed: boolean;
    reason: string;
  };
}

export interface MCPProxyDependencies {
  atlasConfig: AtlasConfig;
  federationManager: FederationManager;
  platformMCPServer?: any;
  workspaceMCPServers: Map<string, any>;
  remoteManager?: {
    callRemote(remote: string, workspace: string | undefined, tool: string, args: any): Promise<any>;
  };
}

export class MCPProxy {
  private dependencies: MCPProxyDependencies;

  constructor(dependencies: MCPProxyDependencies) {
    this.dependencies = dependencies;
  }

  /**
   * Route an MCP call through the proxy
   */
  async routeCall(
    transport: AtlasProxyTransport,
    call: MCPProxyCall,
  ): Promise<MCPProxyResponse> {
    try {
      // Handle remote calls
      if (transport.remote) {
        return await this.handleRemoteCall(transport, call);
      }

      // Handle local calls
      if (transport.target === "platform") {
        return await this.handlePlatformCall(call);
      } else {
        // Workspace target
        const targetWorkspace = transport.workspace || transport.target;
        return await this.handleWorkspaceCall(targetWorkspace, call);
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Handle platform MCP calls
   */
  private async handlePlatformCall(call: MCPProxyCall): Promise<MCPProxyResponse> {
    if (!this.dependencies.platformMCPServer) {
      return {
        success: false,
        error: "Platform MCP server not available",
      };
    }

    // Platform calls don't require federation checks (assuming caller has platform access)
    try {
      const result = await this.dependencies.platformMCPServer.callTool(call.tool, call.arguments);
      return {
        success: true,
        result,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Handle workspace MCP calls
   */
  private async handleWorkspaceCall(
    targetWorkspace: string,
    call: MCPProxyCall,
  ): Promise<MCPProxyResponse> {
    // Check federation permissions
    const federationCheck = this.dependencies.federationManager.checkAccess(
      call.sourceWorkspace,
      targetWorkspace,
      call.tool,
    );

    if (!federationCheck.allowed) {
      return {
        success: false,
        error: `Federation access denied: ${federationCheck.reason}`,
        federationCheck,
      };
    }

    // Get target workspace MCP server
    const workspaceMCPServer = this.dependencies.workspaceMCPServers.get(targetWorkspace);
    if (!workspaceMCPServer) {
      return {
        success: false,
        error: `Workspace MCP server for '${targetWorkspace}' not found`,
        federationCheck,
      };
    }

    // Execute the call
    try {
      const result = await workspaceMCPServer.callTool(call.tool, call.arguments);
      return {
        success: true,
        result,
        federationCheck,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        federationCheck,
      };
    }
  }

  /**
   * Handle remote Atlas instance calls
   */
  private async handleRemoteCall(
    transport: AtlasProxyTransport,
    call: MCPProxyCall,
  ): Promise<MCPProxyResponse> {
    if (!this.dependencies.remoteManager) {
      return {
        success: false,
        error: "Remote manager not available",
      };
    }

    if (!transport.remote) {
      return {
        success: false,
        error: "Remote name not specified",
      };
    }

    try {
      const result = await this.dependencies.remoteManager.callRemote(
        transport.remote,
        transport.workspace,
        call.tool,
        call.arguments,
      );

      return {
        success: true,
        result,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Create MCP client configuration that uses the proxy
   */
  static createProxyMCPServerConfig(
    serverId: string,
    transport: AtlasProxyTransport,
    options: {
      timeout_ms?: number;
      env?: Record<string, any>;
    } = {},
  ): any {
    return {
      [serverId]: {
        transport: {
          type: "atlas-proxy",
          ...transport,
        },
        timeout_ms: options.timeout_ms || 30000,
        env: options.env || {},
      },
    };
  }

  /**
   * Validate atlas-proxy transport configuration
   */
  static validateTransport(transport: any): AtlasProxyTransport {
    return AtlasProxyTransportSchema.parse(transport);
  }

  /**
   * Get federation requirements for a proxy call
   */
  getFederationRequirements(
    transport: AtlasProxyTransport,
    call: MCPProxyCall,
  ): {
    required: boolean;
    sourceWorkspace: string;
    targetWorkspace?: string;
    capability: string;
  } {
    // Platform calls don't require federation (assuming platform access)
    if (transport.target === "platform") {
      return {
        required: false,
        sourceWorkspace: call.sourceWorkspace,
        capability: call.tool,
      };
    }

    // Remote calls handled by remote Atlas instance
    if (transport.remote) {
      return {
        required: false,
        sourceWorkspace: call.sourceWorkspace,
        capability: call.tool,
      };
    }

    // Workspace calls require federation
    const targetWorkspace = transport.workspace || transport.target;
    return {
      required: true,
      sourceWorkspace: call.sourceWorkspace,
      targetWorkspace,
      capability: call.tool,
    };
  }

  /**
   * Test federation access for debugging
   */
  testFederationAccess(
    sourceWorkspace: string,
    targetWorkspace: string,
    capability: string,
  ): MCPProxyResponse {
    const federationCheck = this.dependencies.federationManager.checkAccess(
      sourceWorkspace,
      targetWorkspace,
      capability,
    );

    return {
      success: federationCheck.allowed,
      result: federationCheck.allowed ? "Access granted" : "Access denied",
      error: federationCheck.allowed ? undefined : federationCheck.reason,
      federationCheck,
    };
  }
}
/**
 * Context Provisioner
 *
 * Orchestrates EMCP providers to provision context for agents
 * Replaces hardcoded context loading in SessionSupervisor
 */

import { EMCPRegistry } from "../emcp/emcp-registry.ts";
import { FilesystemProvider } from "../emcp/providers/filesystem-provider.ts";
import type { CodebaseContextSpec, ContextSpec, EMCPContext } from "../emcp/emcp-provider.ts";
import type { JobSpecification } from "../session-supervisor.ts";

export interface ContextProvisionerConfig {
  readonly workspaceId: string;
  readonly sources?: Map<string, SourceConfig>;
}

export interface SourceConfig {
  readonly name: string;
  readonly provider: string;
  readonly config: Record<string, unknown>;
}

export interface ProvisioningResult {
  readonly success: boolean;
  readonly context?: string;
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Context Provisioner orchestrates EMCP providers to load context for agents
 */
export class ContextProvisioner {
  private registry = new EMCPRegistry();
  private isInitialized = false;
  private workspaceId: string;

  constructor(config: ContextProvisionerConfig) {
    this.workspaceId = config.workspaceId;
  }

  /**
   * Initialize the provisioner with workspace sources
   */
  async initialize(sources: Map<string, SourceConfig> = new Map()): Promise<void> {
    // Register built-in providers
    await this.registerBuiltinProviders(sources);

    this.isInitialized = true;
    console.log(`ContextProvisioner initialized for workspace: ${this.workspaceId}`);
  }

  /**
   * Provision filesystem context via EMCP
   */
  async provisionFilesystemContext(
    agentId: string,
    jobSpec: JobSpecification,
    sessionId: string,
  ): Promise<string> {
    this.ensureInitialized();

    // Extract filesystem context from job spec
    const filesystemContext = jobSpec?.execution?.context?.filesystem;

    if (!filesystemContext || !filesystemContext.patterns) {
      return "";
    }

    // Create EMCP context spec for filesystem provider
    const contextSpec: CodebaseContextSpec = {
      type: "codebase",
      filePatterns: filesystemContext.patterns,
      maxSize: filesystemContext.max_file_size ? `${filesystemContext.max_file_size}b` : "50kb",
      basePath: filesystemContext.base_path, // Pass base_path through context spec
    };

    const context: EMCPContext = {
      workspaceId: this.workspaceId,
      sessionId,
      agentId,
      reasoning: `Loading filesystem context for ${agentId}`,
    };

    const result = await this.provisionContext(contextSpec, context);

    if (result.success && result.context) {
      return result.context;
    }

    if (result.error) {
      console.error(`Failed to provision filesystem context: ${result.error}`);
    }

    return "";
  }

  /**
   * Provision context based on specification
   */
  async provisionContext(spec: ContextSpec, context: EMCPContext): Promise<ProvisioningResult> {
    this.ensureInitialized();

    try {
      // Use registry to provision context
      const result = await this.registry.provisionContext(spec.type, spec, context);

      if (result.success && result.content) {
        return {
          success: true,
          context: typeof result.content.content === "string"
            ? result.content.content
            : new TextDecoder().decode(result.content.content),
          metadata: {
            cost: result.cost,
            providerMetadata: result.metadata,
          },
        };
      }

      return {
        success: false,
        error: result.error || "Unknown provisioning error",
        metadata: {
          cost: result.cost,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Context provisioning failed: ${error}`,
      };
    }
  }

  /**
   * Discover available context types
   */
  getAvailableContextTypes(): string[] {
    this.ensureInitialized();

    const providers = this.registry.listProviders();
    const contextTypes = new Set<string>();

    for (const { provider } of providers) {
      for (const capability of provider.config.capabilities) {
        contextTypes.add(capability.type);
      }
    }

    return Array.from(contextTypes);
  }

  /**
   * Check if a context type is available
   */
  canProvideContext(contextType: string): boolean {
    this.ensureInitialized();

    const discoveries = this.registry.discoverProviders(contextType);
    return discoveries.length > 0;
  }

  /**
   * Shutdown the provisioner
   */
  async shutdown(): Promise<void> {
    await this.registry.shutdown();
    this.isInitialized = false;
    console.log(`ContextProvisioner shutdown for workspace: ${this.workspaceId}`);
  }

  // Private methods

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error("ContextProvisioner is not initialized");
    }
  }

  private async registerBuiltinProviders(sources: Map<string, SourceConfig>): Promise<void> {
    // Register filesystem provider with configured sources
    const filesystemSources = new Map<string, Record<string, unknown>>();

    // Find filesystem sources
    for (const [sourceName, sourceConfig] of sources.entries()) {
      if (sourceConfig.provider === "filesystem") {
        filesystemSources.set(sourceName, sourceConfig.config);
      }
    }

    // If no filesystem sources configured, add default
    if (filesystemSources.size === 0) {
      filesystemSources.set("default", {
        basePath: ".",
        allowedExtensions: [".ts", ".js", ".md", ".json", ".yaml", ".yml"],
        maxFileSize: "4kb",
        maxTotalSize: "50kb",
      });
    }

    const filesystemProvider = new FilesystemProvider();
    await this.registry.registerProvider("filesystem", filesystemProvider, filesystemSources);

    console.log(`Registered filesystem provider with ${filesystemSources.size} source(s)`);
  }
}

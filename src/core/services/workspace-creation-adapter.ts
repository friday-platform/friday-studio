import type { WorkspaceConfig } from "@atlas/config";
import { join } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { getAtlasDaemonUrl } from "@atlas/tools";

/**
 * Interface for creating workspace files from draft configurations
 */
export interface WorkspaceCreationAdapter {
  /**
   * Create a workspace directory with configuration files
   */
  createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult>;

  /**
   * Validate that a workspace can be created at the specified path
   */
  validateWorkspacePath(
    path: string,
    name: string,
    overwrite?: boolean,
  ): Promise<PathValidationResult>;

  /**
   * Generate YAML content from workspace configuration
   */
  generateWorkspaceYaml(config: Partial<WorkspaceConfig>): string;
}

export interface WorkspaceCreationParams {
  name: string;
  config: Partial<WorkspaceConfig>;
  targetPath?: string; // Directory where to create the workspace
  overwrite?: boolean;
}

export interface WorkspaceCreationResult {
  success: boolean;
  workspacePath: string;
  filesCreated: string[];
  error?: string;
}

export interface PathValidationResult {
  valid: boolean;
  finalPath: string; // The actual path that will be used (with collision resolution)
  warnings: string[];
  errors: string[];
}

/**
 * Default implementation of WorkspaceCreationAdapter using filesystem operations
 */
export class FilesystemWorkspaceCreationAdapter implements WorkspaceCreationAdapter {
  constructor(private basePath: string = Deno.cwd()) {}

  async createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    try {
      // 1. Validate and resolve target path
      const pathValidation = await this.validateWorkspacePath(
        params.targetPath || this.basePath,
        params.name,
        params.overwrite,
      );

      if (!pathValidation.valid) {
        return {
          success: false,
          workspacePath: pathValidation.finalPath,
          filesCreated: [],
          error: pathValidation.errors.join(", "),
        };
      }

      const workspacePath = pathValidation.finalPath;
      const filesCreated: string[] = [];

      // 2. Create workspace directory
      await ensureDir(workspacePath);

      // 3. Generate and write workspace.yml
      const workspaceYaml = this.generateWorkspaceYaml(params.config);
      const workspaceYmlPath = join(workspacePath, "workspace.yml");
      await Deno.writeTextFile(workspaceYmlPath, workspaceYaml);
      filesCreated.push("workspace.yml");

      // 4. Create .env file with template
      const envContent = this.generateEnvTemplate();
      const envPath = join(workspacePath, ".env");
      await Deno.writeTextFile(envPath, envContent);
      filesCreated.push(".env");

      // 5. Create README.md with setup instructions
      const readmeContent = this.generateReadmeTemplate(params.name, params.config);
      const readmePath = join(workspacePath, "README.md");
      await Deno.writeTextFile(readmePath, readmeContent);
      filesCreated.push("README.md");

      // 6. Create .gitignore
      const gitignoreContent = this.generateGitignoreTemplate();
      const gitignorePath = join(workspacePath, ".gitignore");
      await Deno.writeTextFile(gitignorePath, gitignoreContent);
      filesCreated.push(".gitignore");

      return {
        success: true,
        workspacePath,
        filesCreated,
      };
    } catch (error) {
      return {
        success: false,
        workspacePath: params.targetPath || this.basePath,
        filesCreated: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async validateWorkspacePath(
    basePath: string,
    name: string,
    overwrite?: boolean,
  ): Promise<PathValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Sanitize workspace name for filesystem
    const sanitizedName = this.sanitizeWorkspaceName(name);
    if (sanitizedName !== name) {
      warnings.push(`Workspace name sanitized from '${name}' to '${sanitizedName}'`);
    }

    // Check if base path exists and is writable
    try {
      const baseStat = await Deno.stat(basePath);
      if (!baseStat.isDirectory) {
        errors.push(`Base path ${basePath} is not a directory`);
      }
    } catch {
      errors.push(`Base path ${basePath} does not exist or is not accessible`);
    }

    if (errors.length > 0) {
      return {
        valid: false,
        finalPath: join(basePath, sanitizedName),
        warnings,
        errors,
      };
    }

    // Find available workspace path (handle collisions)
    const finalPath = await this.resolveWorkspacePath(basePath, sanitizedName, overwrite);

    // Check if we're overwriting
    if (finalPath !== join(basePath, sanitizedName) && !overwrite) {
      warnings.push(
        `Directory '${sanitizedName}' exists, using '${finalPath.split("/").pop()}' instead`,
      );
    }

    return {
      valid: true,
      finalPath,
      warnings,
      errors,
    };
  }

  generateWorkspaceYaml(config: Partial<WorkspaceConfig>): string {
    // Use configuration directly
    const atlasConfig = config;
    const yamlParts: string[] = [];

    // Version
    yamlParts.push(`version: "${atlasConfig.version || "1.0"}"`);
    yamlParts.push("");

    // Workspace section
    if (atlasConfig.workspace) {
      yamlParts.push("workspace:");
      yamlParts.push(`  name: "${atlasConfig.workspace.name || "unnamed-workspace"}"`);
      if (atlasConfig.workspace.description) {
        yamlParts.push(`  description: "${atlasConfig.workspace.description}"`);
      }
      yamlParts.push("");
    }

    // Signals section
    if (atlasConfig.signals && Object.keys(atlasConfig.signals).length > 0) {
      yamlParts.push("signals:");
      for (const [signalName, signal] of Object.entries(atlasConfig.signals)) {
        yamlParts.push(`  ${signalName}:`);
        yamlParts.push(`    description: "${signal.description || "Signal description"}"`);
        yamlParts.push(`    provider: "${signal.provider}"`);

        if (signal.config) {
          yamlParts.push("    config:");
          this.addYamlObject(yamlParts, signal.config, 6);
        }

        if (signal.schema) {
          yamlParts.push("    schema:");
          this.addYamlObject(yamlParts, signal.schema, 6);
        }
      }
      yamlParts.push("");
    }

    // Jobs section
    if (atlasConfig.jobs && Object.keys(atlasConfig.jobs).length > 0) {
      yamlParts.push("jobs:");
      for (const [jobName, job] of Object.entries(atlasConfig.jobs)) {
        yamlParts.push(`  ${jobName}:`);
        yamlParts.push(`    name: "${job.name || jobName}"`);
        yamlParts.push(`    description: "${job.description || "Job description"}"`);

        if (job.triggers && job.triggers.length > 0) {
          yamlParts.push("    triggers:");
          for (const trigger of job.triggers) {
            yamlParts.push(`      - signal: "${trigger.signal}"`);
            if (trigger.condition?.prompt) {
              yamlParts.push(`        condition:`);
              yamlParts.push(`          prompt: "${trigger.condition.prompt}"`);
            }
          }
        }

        if (job.execution) {
          yamlParts.push("    execution:");
          yamlParts.push(`      strategy: "${job.execution.strategy || "sequential"}"`);
          if (job.execution.agents && job.execution.agents.length > 0) {
            yamlParts.push("      agents:");
            for (const agent of job.execution.agents) {
              if (typeof agent === "string") {
                yamlParts.push(`        - "${agent}"`);
              } else {
                yamlParts.push(`        - id: "${agent.id}"`);
                if (agent.nickname) {
                  yamlParts.push(`          nickname: "${agent.nickname}"`);
                }
                if (agent.context) {
                  yamlParts.push("          context:");
                  this.addYamlObject(yamlParts, agent.context, 12);
                }
              }
            }
          }
        }
      }
      yamlParts.push("");
    }

    // Agents section
    if (atlasConfig.agents && Object.keys(atlasConfig.agents).length > 0) {
      yamlParts.push("agents:");
      for (const [agentName, agent] of Object.entries(atlasConfig.agents)) {
        yamlParts.push(`  ${agentName}:`);
        yamlParts.push(`    type: "${agent.type}"`);
        yamlParts.push(`    description: "${agent.description || "Agent description"}"`);

        if (agent.config) {
          yamlParts.push("    config:");
          this.addYamlObject(yamlParts, agent.config, 6);
        }
      }
      yamlParts.push("");
    }

    // Tools section
    if (atlasConfig.tools) {
      yamlParts.push("tools:");
      this.addYamlObject(yamlParts, atlasConfig.tools, 2);
      yamlParts.push("");
    }

    // Memory section
    if (atlasConfig.memory) {
      yamlParts.push("memory:");
      this.addYamlObject(yamlParts, atlasConfig.memory, 2);
      yamlParts.push("");
    }

    return yamlParts.join("\n").trim() + "\n";
  }

  private addYamlObject(yamlParts: string[], obj: any, indent: number): void {
    const spaces = " ".repeat(indent);

    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === "object" && item !== null) {
          yamlParts.push(`${spaces}-`);
          this.addYamlObject(yamlParts, item, indent + 2);
        } else {
          yamlParts.push(`${spaces}- "${item}"`);
        }
      }
    } else if (typeof obj === "object" && obj !== null) {
      for (const [key, value] of Object.entries(obj)) {
        if (Array.isArray(value)) {
          yamlParts.push(`${spaces}${key}:`);
          this.addYamlObject(yamlParts, value, indent + 2);
        } else if (typeof value === "object" && value !== null) {
          yamlParts.push(`${spaces}${key}:`);
          this.addYamlObject(yamlParts, value, indent + 2);
        } else {
          yamlParts.push(`${spaces}${key}: "${value}"`);
        }
      }
    }
  }

  private sanitizeWorkspaceName(name: string): string {
    // Remove or replace characters that are problematic for filesystem paths
    return name
      .replace(/[^a-zA-Z0-9\-_\s]/g, "") // Remove special chars except hyphens, underscores, spaces
      .replace(/\s+/g, "-") // Replace spaces with hyphens
      .toLowerCase() // Lowercase for consistency
      .replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
      .substring(0, 50) || // Limit length
      "workspace"; // Fallback if name becomes empty
  }

  private async resolveWorkspacePath(
    basePath: string,
    name: string,
    overwrite?: boolean,
  ): Promise<string> {
    const originalPath = join(basePath, name);

    if (overwrite) {
      return originalPath;
    }

    // Check if directory exists
    if (!(await exists(originalPath))) {
      return originalPath;
    }

    // Find next available name
    let counter = 2;
    while (true) {
      const candidatePath = join(basePath, `${name}-${counter}`);
      if (!(await exists(candidatePath))) {
        return candidatePath;
      }
      counter++;
    }
  }

  private generateEnvTemplate(): string {
    return `# Atlas Workspace Environment Variables
# Add your API keys and configuration here

# Required: Anthropic API key for Claude models
ANTHROPIC_API_KEY=your-anthropic-api-key-here

# Optional: OpenAI API key if using OpenAI models
# OPENAI_API_KEY=your-openai-api-key-here

# Optional: Google API key if using Google models
# GOOGLE_API_KEY=your-google-api-key-here

# Atlas daemon URL (usually localhost during development)
ATLAS_DAEMON_URL=${getAtlasDaemonUrl()}

# Workspace-specific configuration
WORKSPACE_LOG_LEVEL=info
`;
  }

  private generateReadmeTemplate(name: string, config: Partial<WorkspaceConfig>): string {
    const agentCount = config.agents ? Object.keys(config.agents).length : 0;
    const jobCount = config.jobs ? Object.keys(config.jobs).length : 0;
    const signalCount = config.signals ? Object.keys(config.signals).length : 0;

    return `# ${name}

${config.workspace?.description || "An Atlas workspace for AI agent orchestration."}

## Workspace Overview

This workspace contains:
- **${agentCount} agent${agentCount === 1 ? "" : "s"}** - AI agents that perform specific tasks
- **${jobCount} job${jobCount === 1 ? "" : "s"}** - Workflows that coordinate agent execution  
- **${signalCount} signal${signalCount === 1 ? "" : "s"}** - Triggers that initiate workflows

## Quick Start

1. **Add your API keys** to the \`.env\` file:
   \`\`\`bash
   ANTHROPIC_API_KEY=your-key-here
   \`\`\`

2. **Start the Atlas daemon** (in another terminal):
   \`\`\`bash
   atlas daemon start
   \`\`\`

3. **Initialize and run** your workspace:
   \`\`\`bash
   atlas init
   atlas signal trigger <signal-name>  # Trigger workflows manually
   \`\`\`

## Configuration

The workspace configuration is defined in \`workspace.yml\`. Key sections:

### Agents
${
      agentCount > 0
        ? Object.keys(config.agents!).map((name) =>
          `- **${name}**: ${config.agents![name].description || "Agent description"}`
        ).join("\n")
        : "No agents configured."
    }

### Jobs
${
      jobCount > 0
        ? Object.keys(config.jobs!).map((name) =>
          `- **${name}**: ${config.jobs![name].description || "Job description"}`
        ).join("\n")
        : "No jobs configured."
    }

### Signals  
${
      signalCount > 0
        ? Object.keys(config.signals!).map((name) =>
          `- **${name}**: ${config.signals![name].description || "Signal description"}`
        ).join("\n")
        : "No signals configured."
    }

## Usage

Monitor your workspace with:
\`\`\`bash
atlas ps                    # Show active sessions
atlas logs                  # View workspace logs
atlas config validate       # Validate configuration
\`\`\`

## Support

For help with Atlas, see:
- [Atlas Documentation](https://docs.atlas.ai)
- [GitHub Issues](https://github.com/atlas-ai/atlas/issues)
- [Community Discord](https://discord.gg/atlas-ai)
`;
  }

  private generateGitignoreTemplate(): string {
    return `# Atlas workspace files
.env
.env.local
*.log

# Atlas runtime files
.atlas/
atlas.lock

# Node modules (if using npm packages)
node_modules/

# Python
__pycache__/
*.pyc
*.pyo
.venv/
venv/

# IDE files
.vscode/
.idea/
*.swp
*.swo

# OS files
.DS_Store
Thumbs.db

# Temporary files
*.tmp
*.temp
`;
  }
}

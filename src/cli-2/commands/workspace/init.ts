import * as p from "@clack/prompts";
import { ensureDir, exists } from "@std/fs";
import { join, resolve } from "@std/path";
import * as yaml from "@std/yaml";
import { YargsInstance } from "../../utils/yargs.ts";

interface InitArgs {
  name?: string;
  path?: string;
}

export const command = "init [name] [path]";
export const desc = "Initialize a new Atlas workspace";

export function builder(y: YargsInstance) {
  return y
    .positional("name", {
      type: "string",
      describe: "Workspace name",
    })
    .positional("path", {
      type: "string",
      describe: "Directory path for the workspace",
      default: ".",
    })
    .example("$0 workspace init", "Initialize workspace interactively in current directory")
    .example("$0 workspace init my-agent", "Create workspace named 'my-agent'")
    .example("$0 workspace init my-agent ~/projects", "Create workspace in specific directory")
    .example("$0 work init", "Short alias for workspace init")
    .help()
    .alias("help", "h");
}

export const handler = async (argv: InitArgs): Promise<void> => {
  try {
    // Start the interactive flow
    p.intro(`Atlas Workspace Setup`);

    // Get workspace name - either from args or prompt
    const workspaceName = argv.name || await p.text({
      message: "What is your workspace name?",
      placeholder: "my-workspace",
      validate: (value) => {
        if (!value) return "Workspace name is required";
        if (!/^[a-z0-9-]+$/.test(value)) {
          return "Use lowercase letters, numbers, and hyphens only";
        }
      },
    }) as string;

    // Check for cancellation
    if (p.isCancel(workspaceName)) {
      p.cancel("Workspace initialization cancelled");
      Deno.exit(0);
    }

    // Get workspace path
    const targetPath = resolve(argv.path || ".");
    const workspacePath = join(targetPath, workspaceName);

    // Check if directory already exists
    if (await exists(workspacePath)) {
      const overwrite = await p.confirm({
        message: `Directory "${workspaceName}" already exists. Continue anyway?`,
        initialValue: false,
      });

      if (p.isCancel(overwrite) || !overwrite) {
        p.cancel("Workspace initialization cancelled");
        Deno.exit(0);
      }
    }

    // Workspace configuration options
    const config = await p.group({
      description: () =>
        p.text({
          message: "Describe your workspace (optional)",
          placeholder: "AI-powered workspace for...",
        }),

      agents: () =>
        p.multiselect({
          message: "Select agents to include:",
          options: [
            {
              value: "llm",
              label: "LLM Agent",
              hint: "For AI-powered tasks with Anthropic Claude",
            },
            {
              value: "tempest",
              label: "Tempest Agent",
              hint: "Built-in agent for system operations",
            },
            {
              value: "remote",
              label: "Remote Agent",
              hint: "Connect to external HTTP agents",
            },
          ],
          required: false,
        }),

      signals: () =>
        p.multiselect({
          message: "Configure signal triggers:",
          options: [
            {
              value: "cli",
              label: "CLI Trigger",
              hint: "Manual triggering from command line",
            },
            {
              value: "http",
              label: "HTTP Webhook",
              hint: "Trigger via HTTP POST requests",
            },
            {
              value: "schedule",
              label: "Scheduled",
              hint: "Time-based automatic triggers",
            },
          ],
          initialValues: ["cli"],
          required: false,
        }),

      confirm: ({ results }) => {
        const agentCount = (results.agents as string[] || []).length;
        const signalCount = (results.signals as string[] || []).length;
        return p.confirm({
          message:
            `Create workspace "${workspaceName}" with ${agentCount} agent(s) and ${signalCount} signal(s)?`,
          initialValue: true,
        });
      },
    }, {
      onCancel: () => {
        p.cancel("Workspace initialization cancelled");
        Deno.exit(0);
      },
    });

    if (!config.confirm) {
      p.cancel("Workspace initialization cancelled");
      Deno.exit(0);
    }

    // Create the workspace
    const s = p.spinner();
    s.start("Creating workspace directory...");

    await ensureDir(workspacePath);

    // Create workspace.yml
    const workspaceConfig = {
      workspace: {
        name: workspaceName,
        description: config.description || `Atlas workspace: ${workspaceName}`,
      },
      signals: {} as Record<string, unknown>,
      jobs: {} as Record<string, unknown>,
    };

    // Add configured signals
    if (config.signals && (config.signals as string[]).length > 0) {
      for (const signal of config.signals as string[]) {
        if (signal === "cli") {
          workspaceConfig.signals["manual-trigger"] = {
            provider: "cli",
            description: "Manual signal trigger from CLI",
          };
        } else if (signal === "http") {
          workspaceConfig.signals["webhook"] = {
            provider: "http",
            description: "HTTP webhook trigger",
            config: {
              port: 8080,
              path: "/webhook",
            },
          };
        } else if (signal === "schedule") {
          workspaceConfig.signals["scheduled"] = {
            provider: "schedule",
            description: "Scheduled trigger",
            config: {
              cron: "0 0 * * *",
            },
          };
        }
      }
    }

    // Add sample job based on selected agents
    if (config.agents && (config.agents as string[]).length > 0) {
      workspaceConfig.jobs["example-job"] = {
        description: "Example job for workspace initialization",
        agents: config.agents,
        mappings: [
          {
            signal: Object.keys(workspaceConfig.signals)[0] || "manual-trigger",
            conditions: [],
          },
        ],
      };
    }

    // Write workspace.yml
    const yamlContent = yaml.stringify(workspaceConfig);
    await Deno.writeTextFile(join(workspacePath, "workspace.yml"), yamlContent);

    // Create .env file if LLM agent selected
    if (config.agents && (config.agents as string[]).includes("llm")) {
      const envContent = "# Add your Anthropic API key here\nANTHROPIC_API_KEY=\n";
      await Deno.writeTextFile(join(workspacePath, ".env"), envContent);
    }

    // Create jobs directory
    await ensureDir(join(workspacePath, "jobs"));

    s.stop(`Workspace created successfully!`);

    // Final instructions
    p.outro(`
Next steps:
  1. cd ${workspaceName}
  2. ${
      (config.agents as string[] || []).includes("llm")
        ? "Add your ANTHROPIC_API_KEY to .env"
        : "Configure your agents"
    }
  3. Run 'atlas workspace serve' to start
`);
  } catch (error) {
    p.cancel(`Error: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
};

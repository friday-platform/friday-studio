import React, { useState } from "react";
import { Box, render, Text, useApp } from "ink";
import { ConfirmInput, MultiSelect, Spinner, TextInput } from "@inkjs/ui";
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

interface WorkspaceConfig {
  name: string;
  description: string;
  agents: string[];
  signals: string[];
}

const WorkspaceInitFlow = (
  { initialName, targetPath }: { initialName?: string; targetPath: string },
) => {
  const { exit } = useApp();
  const [step, setStep] = useState(initialName ? "description" : "name");
  const [config, setConfig] = useState<Partial<WorkspaceConfig>>({
    name: initialName,
    agents: [],
    signals: ["cli"],
  });
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const handleNameSubmit = (name: string) => {
    if (!name) {
      setError("Workspace name is required");
      return;
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
      setError("Use lowercase letters, numbers, and hyphens only");
      return;
    }
    setConfig({ ...config, name });
    setError(null);
    setStep("checkExists");
  };

  const handleExistsCheck = async () => {
    const workspacePath = join(targetPath, config.name!);
    if (await exists(workspacePath)) {
      setStep("overwrite");
    } else {
      setStep("description");
    }
  };

  const handleOverwrite = (confirmed: boolean) => {
    if (!confirmed) {
      console.error("Workspace initialization cancelled");
      exit();
      return;
    }
    setStep("description");
  };

  const handleDescription = (description: string) => {
    setConfig({ ...config, description });
    setStep("agents");
  };

  const handleAgents = (agents: string[]) => {
    setConfig({ ...config, agents });
    setStep("signals");
  };

  const handleSignals = (signals: string[]) => {
    setConfig({ ...config, signals });
    setStep("confirm");
  };

  const handleConfirm = async (confirmed: boolean) => {
    if (!confirmed) {
      console.error("Workspace initialization cancelled");
      exit();
      return;
    }

    setCreating(true);

    try {
      const workspacePath = join(targetPath, config.name!);
      await ensureDir(workspacePath);

      // Create workspace.yml
      const workspaceConfig = {
        workspace: {
          name: config.name,
          description: config.description || `Atlas workspace: ${config.name}`,
        },
        signals: {} as Record<string, unknown>,
        jobs: {} as Record<string, unknown>,
      };

      // Add configured signals
      if (config.signals && config.signals.length > 0) {
        for (const signal of config.signals) {
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
      if (config.agents && config.agents.length > 0) {
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
      if (config.agents && config.agents.includes("llm")) {
        const envContent = "# Add your Anthropic API key here\nANTHROPIC_API_KEY=\n";
        await Deno.writeTextFile(join(workspacePath, ".env"), envContent);
      }

      // Create jobs directory
      await ensureDir(join(workspacePath, "jobs"));

      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  // Check exists step
  React.useEffect(() => {
    if (step === "checkExists") {
      handleExistsCheck();
    }
  }, [step]);

  if (creating) {
    return (
      <Box flexDirection="column" gap={1}>
        <Spinner label="Creating workspace directory..." />
      </Box>
    );
  }

  if (step === "success") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="green">✔ Workspace created successfully!</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Next steps:</Text>
          <Text>1. cd {config.name}</Text>
          <Text>
            2. {config.agents?.includes("llm")
              ? "Add your ANTHROPIC_API_KEY to .env"
              : "Configure your agents"}
          </Text>
          <Text>3. Run 'atlas workspace serve' to start</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box paddingY={1}>
        <Text bold color="cyan">┌ Atlas Workspace Setup</Text>
      </Box>

      {error && (
        <Box marginBottom={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      {step === "name" && (
        <Box flexDirection="column" gap={1}>
          <Text>What is your workspace name?</Text>
          <TextInput
            placeholder="my-workspace"
            onSubmit={handleNameSubmit}
          />
        </Box>
      )}

      {step === "overwrite" && (
        <Box flexDirection="column" gap={1}>
          <Text>Directory "{config.name}" already exists. Continue anyway?</Text>
          <ConfirmInput
            defaultChoice="cancel"
            onConfirm={() => handleOverwrite(true)}
            onCancel={() => handleOverwrite(false)}
          />
        </Box>
      )}

      {step === "description" && (
        <Box flexDirection="column" gap={1}>
          <Text>Describe your workspace (optional)</Text>
          <TextInput
            placeholder="AI-powered workspace for..."
            onSubmit={handleDescription}
          />
        </Box>
      )}

      {step === "agents" && (
        <Box flexDirection="column" gap={1}>
          <Text>Select agents to include:</Text>
          <MultiSelect
            options={[
              {
                label: "LLM Agent (For AI-powered tasks with Anthropic Claude)",
                value: "llm",
              },
              {
                label: "Tempest Agent (Built-in agent for system operations)",
                value: "tempest",
              },
              {
                label: "Remote Agent (Connect to external HTTP agents)",
                value: "remote",
              },
            ]}
            onSubmit={handleAgents}
          />
        </Box>
      )}

      {step === "signals" && (
        <Box flexDirection="column" gap={1}>
          <Text>Configure signal triggers:</Text>
          <MultiSelect
            defaultValue={["cli"]}
            options={[
              {
                label: "CLI Trigger (Manual triggering from command line)",
                value: "cli",
              },
              {
                label: "HTTP Webhook (Trigger via HTTP POST requests)",
                value: "http",
              },
              {
                label: "Scheduled (Time-based automatic triggers)",
                value: "schedule",
              },
            ]}
            onSubmit={handleSignals}
          />
        </Box>
      )}

      {step === "confirm" && (
        <Box flexDirection="column" gap={1}>
          <Text>
            Create workspace "{config.name}" with {config.agents?.length || 0} agent(s) and{" "}
            {config.signals?.length || 0} signal(s)?
          </Text>
          <ConfirmInput
            defaultChoice="confirm"
            onConfirm={() => handleConfirm(true)}
            onCancel={() => handleConfirm(false)}
          />
        </Box>
      )}
    </Box>
  );
};

export const handler = async (argv: InitArgs): Promise<void> => {
  const targetPath = resolve(argv.path || ".");

  render(<WorkspaceInitFlow initialName={argv.name} targetPath={targetPath} />);
};

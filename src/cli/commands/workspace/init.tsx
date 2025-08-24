import { AtlasClient } from "@atlas/client";
import { Spinner, TextInput } from "@inkjs/ui";
import { join, resolve } from "@std/path";
import { Box, render, Text, useApp } from "ink";
import React, { useState } from "react";
import { Select } from "../../components/select/index.ts";
import { checkDaemonRunning } from "../../utils/daemon-client.ts";
import type { YargsInstance } from "../../utils/yargs.ts";

interface InitArgs {
  path?: string;
}

export const command = "init [path]";
export const desc = "Initialize a new Atlas workspace from a template";

export function builder(y: YargsInstance) {
  return y
    .positional("path", {
      type: "string",
      describe: "Directory path for the workspace (defaults to ./<workspace-name>)",
    })
    .example("$0 workspace init", "Initialize workspace interactively in current directory")
    .example("$0 workspace init ~/projects/my-workspace", "Create workspace at specific path")
    .example("$0 work init", "Short alias for workspace init")
    .help()
    .alias("help", "h");
}

interface Template {
  value: string;
  label: string;
  hint?: string;
}

const WorkspaceInitFlow = ({ targetPath }: { targetPath?: string }) => {
  const { exit } = useApp();
  const [step, setStep] = useState("checkDaemon");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Check daemon status
  React.useEffect(() => {
    if (step === "checkDaemon") {
      checkDaemonRunning()
        .then((running) => {
          if (running) {
            setStep("loadTemplates");
          } else {
            setError("Atlas daemon is not running. Please run 'atlas daemon start' first.");
            setStep("error");
          }
        })
        .catch(() => {
          setError("Failed to check daemon status");
          setStep("error");
        });
    }
  }, [step]);

  // Load templates
  React.useEffect(() => {
    if (step === "loadTemplates") {
      const loadTemplates = async () => {
        try {
          const client = new AtlasClient();
          const templateList = await client.listWorkspaceTemplates();

          const formattedTemplates = templateList.map((t) => ({
            value: t.id,
            label: t.name,
            hint: t.description,
          }));

          setTemplates(formattedTemplates);
          setStep("selectTemplate");
        } catch (error) {
          setError(
            `Failed to load templates: ${error instanceof Error ? error.message : String(error)}`,
          );
          setStep("error");
        }
      };

      loadTemplates();
    }
  }, [step]);

  const handleTemplateSelect = (value: string) => {
    setSelectedTemplate(value);
    setStep("enterName");
  };

  const handleNameSubmit = (name: string) => {
    if (!name) {
      setError("Workspace name is required");
      return;
    }

    const kebabName = toKebabCase(name);
    if (!/^[a-z0-9-]+$/.test(kebabName)) {
      setError("Use letters, numbers, and hyphens only (will be converted to kebab-case)");
      return;
    }

    setWorkspaceName(kebabName);
    setError(null);
    setStep("createWorkspace");
  };

  // Create workspace
  React.useEffect(() => {
    if (step === "createWorkspace") {
      const createWorkspace = async () => {
        setCreating(true);

        try {
          // Resolve target path
          const resolvedPath = resolveWorkspacePath(workspaceName, targetPath);

          // Create workspace from template
          const client = new AtlasClient();
          const result = await client.createWorkspaceFromTemplate({
            templateId: selectedTemplate,
            name: workspaceName,
            path: resolvedPath,
          });

          // Success!
          console.log("\n✔ Workspace created successfully!\n");
          console.log(`📁 Created at: ${result.path}`);
          console.log(`📄 Template: ${templates.find((t) => t.value === selectedTemplate)?.label}`);
          console.log("\nNext steps:");
          console.log(`1. cd ${result.path}`);
          console.log("2. Configure your API keys in .env");
          console.log("3. atlas daemon start");
          console.log(`4. atlas signal trigger <signal-name> --data '{"message": "Hello world"}'`);

          exit();
        } catch (error) {
          setError(
            `Failed to create workspace: ${error instanceof Error ? error.message : String(error)}`,
          );
          setStep("error");
        }
      };

      createWorkspace();
    }
  }, [step, workspaceName, selectedTemplate, targetPath, templates, exit]);

  if (step === "checkDaemon" || step === "loadTemplates") {
    return (
      <Box flexDirection="column">
        <Box>
          <Spinner
            label={step === "checkDaemon" ? "Checking daemon status..." : "Loading templates..."}
          />
        </Box>
      </Box>
    );
  }

  if (step === "error") {
    return (
      <Box flexDirection="column">
        <Text color="red">✖ {error}</Text>
      </Box>
    );
  }

  if (step === "selectTemplate") {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text>Select a template:</Text>
        </Box>
        <Select options={templates} onChange={handleTemplateSelect} visibleOptionCount={8} />
      </Box>
    );
  }

  if (step === "enterName") {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text>Workspace name:</Text>
        </Box>
        <TextInput placeholder="my-workspace" onSubmit={handleNameSubmit} />
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (step === "createWorkspace" && creating) {
    return (
      <Box flexDirection="column">
        <Box>
          <Spinner label="Creating workspace..." />
        </Box>
      </Box>
    );
  }

  return null;
};

export function handler(args: InitArgs) {
  // Check if we have a TTY
  if (!Deno.stdin.isTerminal()) {
    console.error("✖ Error: This command requires an interactive terminal.");
    console.error(
      "Please run this command directly in your terminal, not through pipes or scripts.",
    );
    Deno.exit(1);
  }

  const { unmount } = render(<WorkspaceInitFlow targetPath={args.path} />);

  // Handle process termination gracefully
  const cleanup = () => {
    unmount();
    Deno.exit(0);
  };

  // Register cleanup handlers
  Deno.addSignalListener("SIGINT", cleanup);
  Deno.addSignalListener("SIGTERM", cleanup);
}

/**
 * Convert a string to kebab-case
 */
function toKebabCase(str: string): string {
  return str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve the workspace path, handling duplicates with counters
 */
function resolveWorkspacePath(name: string, providedPath?: string): string {
  if (providedPath) {
    return resolve(providedPath);
  }

  const baseName = name;
  let finalPath = join(Deno.cwd(), baseName);
  let counter = 2;

  while (existsSync(finalPath)) {
    finalPath = join(Deno.cwd(), `${baseName}-${counter}`);
    counter++;
  }

  return finalPath;
}

/**
 * Check if a path exists synchronously
 */
function existsSync(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

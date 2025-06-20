import { ensureDir, exists } from "@std/fs";
import { join, resolve } from "@std/path";
import * as yaml from "@std/yaml";
import { Box, Newline, Text } from "ink";
import { useEffect, useState } from "react";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceCommandProps } from "./utils.ts";

interface WorkspaceData {
  type: "created" | "exists";
  workspace: { name: string; id?: string; description?: string };
  workspaceId?: string;
  registryId?: string;
  path: string;
  message?: string;
}

export function WorkspaceInitCommand({ args }: WorkspaceCommandProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [data, setData] = useState<WorkspaceData | null>(null);

  useEffect(() => {
    const execute = async () => {
      try {
        // Parse arguments: atlas workspace init <name> <path>
        const name = args[0];
        const path = args[1] || ".";

        if (!name) {
          throw new Error("Workspace name is required. Usage: atlas workspace init <name> [path]");
        }

        await handleInit(name, path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    };

    execute();
  }, []);

  async function handleInit(name: string, path: string) {
    // Resolve the target path
    const targetPath = resolve(path);
    const originalCwd = Deno.cwd();

    try {
      // Ensure target directory exists
      await ensureDir(targetPath);

      // Change to target directory
      Deno.chdir(targetPath);

      // Check if workspace.yml already exists
      if (await exists("workspace.yml")) {
        const config = yaml.parse(
          await Deno.readTextFile("workspace.yml"),
        ) as { workspace: { name: string; description: string } };

        // Register existing workspace if not already registered
        const registry = getWorkspaceRegistry();
        const existingEntry = await registry.getCurrentWorkspace();
        if (!existingEntry) {
          await registry.register(targetPath, {
            name: config.workspace.name,
            description: config.workspace.description,
          });
        }

        setData({
          type: "exists",
          workspace: config.workspace,
          message: "workspace.yml already exists",
          path: targetPath,
        });
        setStatus("ready");
        return;
      }

      // Generate workspace ID
      const workspaceId = crypto.randomUUID();

      // Load template
      const moduleDir = new URL(".", import.meta.url).pathname;
      const templatePath = join(
        moduleDir,
        "../../../config/workspace_template.yml",
      );
      let templateContent = await Deno.readTextFile(templatePath);

      // Replace placeholders
      templateContent = templateContent
        .replace("{{WORKSPACE_ID}}", workspaceId)
        .replace("{{WORKSPACE_NAME}}", name);

      // Write workspace.yml
      await Deno.writeTextFile("workspace.yml", templateContent);

      // Create .atlas directory
      await ensureDir(".atlas");
      await ensureDir(".atlas/sessions");
      await ensureDir(".atlas/logs");

      // Save workspace metadata
      await Deno.writeTextFile(
        ".atlas/workspace.json",
        JSON.stringify(
          {
            id: workspaceId,
            name,
            createdAt: new Date().toISOString(),
            version: "1.0.0",
          },
          null,
          2,
        ),
      );

      // Create .env if it doesn't exist
      if (!(await exists(".env"))) {
        await Deno.writeTextFile(
          ".env",
          `# Atlas Environment Variables

# Anthropic Claude API Key
# Get from: https://console.anthropic.com/
ANTHROPIC_API_KEY=your_api_key_here

# OpenAI API Key (optional)
# Get from: https://platform.openai.com/api-keys
OPENAI_API_KEY=your_api_key_here
`,
        );
      }

      // Update .gitignore
      if (await exists(".gitignore")) {
        const gitignore = await Deno.readTextFile(".gitignore");
        if (!gitignore.includes(".env")) {
          await Deno.writeTextFile(
            ".gitignore",
            gitignore + "\n.env\n.atlas/\n*.log\n",
          );
        }
      } else {
        await Deno.writeTextFile(".gitignore", ".env\n.atlas/\n*.log\n");
      }

      // Register workspace in the registry
      const registry = getWorkspaceRegistry();
      const registryEntry = await registry.register(targetPath, {
        name,
        description: "An Atlas AI agent workspace",
      });

      setData({
        type: "created",
        workspace: { name, id: workspaceId },
        workspaceId,
        registryId: registryEntry.id,
        path: targetPath,
      });
      setStatus("ready");
    } finally {
      // Always restore original directory
      Deno.chdir(originalCwd);
    }
  }

  if (status === "loading") {
    return <Text>Loading...</Text>;
  }

  if (status === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  switch (data?.type) {
    case "created":
      return (
        <Box flexDirection="column">
          <Text color="green">✓ Workspace initialized successfully!</Text>
          <Text>Name: {data.workspace.name}</Text>
          <Text>Path: {data.path}</Text>
          <Text>Workspace ID: {data.workspaceId}</Text>
          <Text>Registry ID: {data.registryId}</Text>
          <Text>Configuration: workspace.yml</Text>
          <Newline />
          <Text>Next steps:</Text>
          <Text color="cyan">1. cd {data.path}</Text>
          <Text color="cyan">2. Update .env with your Anthropic API key</Text>
          <Text color="cyan">3. Review and customize workspace.yml</Text>
          <Text color="cyan">
            4. Run 'atlas workspace serve' to start the workspace
          </Text>
        </Box>
      );

    case "exists":
      return (
        <Box flexDirection="column">
          <Text color="yellow">Workspace already initialized</Text>
          <Text>Name: {data.workspace.name}</Text>
          <Text>Path: {data.path}</Text>
          <Text>Config: workspace.yml</Text>
          <Newline />
          <Text color="gray">
            To reinitialize, delete workspace.yml and .atlas/ directory
          </Text>
        </Box>
      );

    default:
      return null;
  }
}

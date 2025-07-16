interface WorkspaceOptions {
  name: string;
  path: string;
  description?: string;
}

export async function createWorkspace(options: WorkspaceOptions): Promise<void> {
  const { name, path, description = "A new Atlas workspace" } = options;

  const id = crypto.randomUUID();
  const workspaceYml = `version: "1.0"

workspace:
  id: "${id}"
  name: "${name}"
  description: "${description}"

# Signal definitions
signals:
  example-signal:
    description: "Example signal"
    provider: "http"
    path: "/example"
    method: "POST"

# Job definitions
jobs:
  example-job:
    name: "example-job"
    description: "Example job"
    triggers:
      - signal: "example-signal"
    execution:
      strategy: "sequential"
      agents:
        - id: "example-agent"

# Agent definitions
agents:
  example-agent:
    type: "llm"
    model: "gemini-2.5-flash"
    purpose: "Example agent"
`;

  // Ensure directory exists before writing file
  await Deno.mkdir(path, { recursive: true });

  const workspacePath = `${path}/workspace.yml`;
  await Deno.writeTextFile(workspacePath, workspaceYml);
}

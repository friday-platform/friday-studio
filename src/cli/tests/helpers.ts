export interface CLIResult {
  stdout: string;
  stderr: string;
  success: boolean;
  code: number;
}

export interface CLIOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

/**
 * Run the Atlas CLI with given arguments
 */
export async function runCLI(
  args: string[],
  options: CLIOptions = {},
): Promise<CLIResult> {
  const cliPath = new URL("../../cli.tsx", import.meta.url).pathname;
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-all",
      "--unstable-broadcast-channel",
      "--unstable-worker-options",
      cliPath,
      ...args,
    ],
    cwd: options.cwd || Deno.cwd(),
    env: { ...Deno.env.toObject(), ...options.env },
    stdout: "piped",
    stderr: "piped",
    stdin: options.stdin ? "piped" : undefined,
  });

  const child = cmd.spawn();

  if (options.stdin && child.stdin) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    writer.close();
  }

  const output = await child.output();

  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    success: output.success,
    code: output.code,
  };
}

/**
 * Create a temporary test directory
 */
export async function createTestDir(): Promise<string> {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas-test-" });
  return tempDir;
}

/**
 * Set up a test workspace with basic configuration
 */
export async function setupTestWorkspace(dir?: string): Promise<string> {
  const workspaceDir = dir || (await createTestDir());

  // Create workspace.yml
  const workspaceConfig = `
version: "1.0"
workspace:
  id: "test-workspace-id"
  name: "Test Workspace"
  description: "Test workspace for CLI tests"

supervisor:
  model: "claude-4-sonnet-20250514"
  prompts:
    system: "You are a test supervisor"

agents:
  test-agent:
    type: "local"
    path: "./agents/test-agent.ts"
    purpose: "Test agent for CLI tests"

signals:
  test-signal:
    provider: "cli"
    description: "Test signal"
    mappings:
      - agents: ["test-agent"]
        strategy: "sequential"

runtime:
  server:
    port: 8888
    host: "localhost"
`;

  await Deno.writeTextFile(`${workspaceDir}/workspace.yml`, workspaceConfig);

  // Create .atlas directory
  await Deno.mkdir(`${workspaceDir}/.atlas`, { recursive: true });
  await Deno.mkdir(`${workspaceDir}/.atlas/sessions`, { recursive: true });
  await Deno.mkdir(`${workspaceDir}/.atlas/logs`, { recursive: true });

  // Create workspace metadata
  await Deno.writeTextFile(
    `${workspaceDir}/.atlas/workspace.json`,
    JSON.stringify(
      {
        id: "test-workspace-id",
        name: "Test Workspace",
        createdAt: new Date().toISOString(),
        version: "1.0.0",
      },
      null,
      2,
    ),
  );

  // Create .env
  await Deno.writeTextFile(
    `${workspaceDir}/.env`,
    `ANTHROPIC_API_KEY=test-key`,
  );

  // Create test agent
  await Deno.mkdir(`${workspaceDir}/agents`, { recursive: true });
  await Deno.writeTextFile(
    `${workspaceDir}/agents/test-agent.ts`,
    `
import { BaseAgent } from "../../../core/agents/base-agent.ts";

export class TestAgent extends BaseAgent {
  constructor() {
    // Call super with default memory config since we're just a test agent
    super();
  }

  name() { return "TestAgent"; }
  nickname() { return "Test"; }
  version() { return "1.0.0"; }
  provider() { return "test"; }
  purpose() { return "Test agent for CLI tests"; }
  controls() { return { test: true }; }
}
`,
  );

  return workspaceDir;
}

/**
 * Wait for a port to be available
 */
export async function waitForPort(
  port: number,
  timeout: number = 10000,
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const conn = await Deno.connect({ port });
      conn.close();
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return false;
}

/**
 * Extract session ID from CLI output
 */
export function extractSessionId(output: string): string | null {
  const match = output.match(/Session ID:\s*([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Clean up test directory
 */
export async function cleanupTestDir(dir: string) {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Ignore errors
  }
}

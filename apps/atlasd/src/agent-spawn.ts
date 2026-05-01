/**
 * Resolves the command + args used to spawn a user agent subprocess.
 *
 * Three tiers, in priority order:
 *
 *   1. FRIDAY_UV_PATH + FRIDAY_AGENT_SDK_VERSION → uv run --with
 *      friday-agent-sdk==<ver>. The production path: launcher emits both
 *      vars on startup (see tools/friday-launcher/project.go), so the SDK
 *      is pinned and uv handles Python + venv provisioning. Same shape
 *      as how the daemon already spawns MCP servers via uvx.
 *
 *   2. FRIDAY_AGENT_PYTHON → run that interpreter directly. Manual
 *      override for debugging against a hand-built venv. The dev-setup
 *      script and tests use this.
 *
 *   3. Bare `python3` from PATH. Dev fallback for in-tree work where the
 *      launcher isn't running. Assumes the dev has friday_agent_sdk
 *      importable in their environment.
 *
 * The .ts branch is unrelated to this resolution — TypeScript user agents
 * spawn through `deno run` and don't need uv or the SDK install path.
 */
import process from "node:process";
export function buildAgentSpawnArgs(agentPath: string): [string, string[]] {
  if (agentPath.endsWith(".py")) {
    const uvPath = process.env.FRIDAY_UV_PATH;
    const sdkVersion = process.env.FRIDAY_AGENT_SDK_VERSION;
    if (uvPath && sdkVersion) {
      return [
        uvPath,
        ["run", "--python", "3.12", "--with", `friday-agent-sdk==${sdkVersion}`, agentPath],
      ];
    }
    const py = process.env.FRIDAY_AGENT_PYTHON ?? "python3";
    return [py, [agentPath]];
  }
  if (agentPath.endsWith(".ts")) {
    return ["deno", ["run", "--allow-net", "--allow-env", "--allow-read", agentPath]];
  }
  return [agentPath, []];
}

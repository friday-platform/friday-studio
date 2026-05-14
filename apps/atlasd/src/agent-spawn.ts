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
 *      If the agent directory contains a pyproject.toml, additionally
 *      passes `--directory <agent_dir>` so the project's declared
 *      dependencies (fireworks-ai, groq, etc.) are installed from the
 *      lockfile. The `--with friday-agent-sdk==<ver>` pin stays on
 *      both branches so the launcher's bundledAgentSDKVersion invariant
 *      holds regardless of what (if anything) the agent's own
 *      pyproject pins for friday-agent-sdk.
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
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

export function buildAgentSpawnArgs(agentPath: string): [string, string[]] {
  if (agentPath.endsWith(".py")) {
    const uvPath = process.env.FRIDAY_UV_PATH;
    const sdkVersion = process.env.FRIDAY_AGENT_SDK_VERSION;
    if (uvPath && sdkVersion) {
      const agentDir = dirname(agentPath);
      const hasPyproject = existsSync(join(agentDir, "pyproject.toml"));
      // `--with friday-agent-sdk==<ver>` is the launcher's reproducibility
      // pin — it forces every Python user agent onto the bundled SDK
      // version regardless of what the agent's own pyproject.toml might
      // (or might not) declare. Keep it on both branches; uv accepts
      // `--directory` and `--with` together.
      const sdkPin = ["--with", `friday-agent-sdk==${sdkVersion}`];
      if (hasPyproject) {
        // Project-style agent: --directory makes uv install the project's
        // declared dependencies (fireworks-ai, sqlite-vec, groq, etc.)
        // from its lockfile in addition to the SDK pin above.
        return [
          uvPath,
          ["run", "--directory", agentDir, "--python", "3.12", ...sdkPin, "python", agentPath],
        ];
      }
      // Single-file agent: SDK pin is the only dep injected.
      return [uvPath, ["run", "--python", "3.12", ...sdkPin, agentPath]];
    }
    const py = process.env.FRIDAY_AGENT_PYTHON ?? "python3";
    return [py, [agentPath]];
  }
  if (agentPath.endsWith(".ts")) {
    return ["deno", ["run", "--allow-net", "--allow-env", "--allow-read", agentPath]];
  }
  return [agentPath, []];
}

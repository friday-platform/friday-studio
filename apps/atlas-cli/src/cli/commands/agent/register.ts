import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { createLogger } from "@atlas/logger";
import { define } from "gunshi";
import { infoOutput, successOutput } from "../../../utils/output.ts";

const logger = createLogger({ name: "agent-register" });

export const registerCommand = define({
  name: "register",
  description: "Register a NATS-protocol agent",
  args: {
    dir: { type: "positional", description: "Path to the agent directory", required: true },
    entry: {
      type: "string",
      description: "Entrypoint filename inside the agent directory (default: agent.py)",
      default: "agent.py",
    },
  },
  rendering: { header: null },
  run: async (ctx) => {
    const dir = ctx.values.dir;
    if (!dir) {
      logger.error("Agent directory path is required");
      process.exit(1);
    }

    const agentDir = resolve(dir);
    const entrypointFile = ctx.values["entry"] ?? "agent.py";
    const entrypointPath = join(agentDir, entrypointFile);

    try {
      await access(entrypointPath);
    } catch {
      logger.error(`Entrypoint not found: ${entrypointPath}`);
      process.exit(1);
    }

    // FRIDAYD_URL is the canonical name (set by friday-launcher's .env load
    // — see tools/friday-launcher/project.go). FRIDAY_DAEMON_URL kept as a
    // legacy alias to match the resolution chain in
    // packages/openapi-client/src/utils.ts:50.
    const daemonUrl =
      process.env.FRIDAYD_URL ?? process.env.FRIDAY_DAEMON_URL ?? "http://localhost:8080";

    let response: Response;
    try {
      response = await fetch(`${daemonUrl}/api/agents/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entrypoint: entrypointPath }),
      });
    } catch (err) {
      logger.error(
        `Could not reach daemon at ${daemonUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }

    const result = (await response.json()) as {
      ok: boolean;
      agent?: { id: string; version: string; path: string };
      error?: string;
    };

    if (!result.ok) {
      logger.error(`Registration failed: ${result.error ?? "unknown error"}`);
      process.exit(1);
    }

    const agent = result.agent;
    if (!agent) {
      logger.error("Unexpected response: missing agent data");
      process.exit(1);
    }

    successOutput(`Registered agent: ${agent.id}@${agent.version}`);
    infoOutput(`  Path: ${agent.path}`);
  },
});

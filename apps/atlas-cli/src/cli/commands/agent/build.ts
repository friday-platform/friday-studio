import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { createLogger } from "@atlas/logger";
import { buildAgent, resolveSdkPath } from "@atlas/workspace/agent-builder";
import { define } from "gunshi";
import { infoOutput, successOutput } from "../../../utils/output.ts";

const logger = createLogger({ name: "agent-build" });

export const buildCommand = define({
  name: "build",
  description: "Build a Python WASM agent",
  args: {
    dir: {
      type: "positional",
      description: "Path to the agent directory containing agent.py",
      required: true,
    },
    "sdk-path": {
      type: "string",
      description:
        "Path to the friday-agent-sdk Python package root (contains wit/ and friday_agent_sdk/)",
    },
    "wit-dir": {
      type: "string",
      description: "Path to the WIT directory (defaults to <sdk-path>/wit)",
    },
    "entry-point": {
      type: "string",
      description: "Python entry module name (default: agent)",
      default: "agent",
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
    const sdkPathArg = ctx.values["sdk-path"];
    const sdkPath = sdkPathArg ? resolve(sdkPathArg) : resolveSdkPath(agentDir);

    if (!sdkPath) {
      logger.error(
        "Could not find friday-agent-sdk package. Use --sdk-path to specify the path to the sdk-python package root.",
      );
      process.exit(1);
    }

    const tmpDir = await mkdtemp(join(tmpdir(), "atlas-build-"));
    try {
      const tempAgentDir = join(tmpDir, basename(agentDir));
      await cp(agentDir, tempAgentDir, { recursive: true });

      const result = await buildAgent({
        agentDir: tempAgentDir,
        sdkPath,
        witDir: ctx.values["wit-dir"],
        entryPoint: ctx.values["entry-point"],
        logger,
      });

      successOutput(`Built agent: ${result.id}@${result.version}`);
      infoOutput(`  Output: ${result.outputPath}`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
});

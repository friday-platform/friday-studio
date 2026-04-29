/**
 * POST /api/agents/register — Register a NATS-protocol agent via validate handshake.
 *
 * Accepts JSON { entrypoint: string } where entrypoint is the absolute path to the
 * agent's entry file (e.g. /home/user/my-agent/agent.py). Spawns the agent with
 * FRIDAY_VALIDATE_ID so it publishes its metadata over NATS, then installs the agent
 * to ~/.friday/local/agents/{id}@{version}/.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { AgentLLMConfigSchema, MCPServerConfigSchema } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { getFridayHome } from "@atlas/utils/paths.server";
import { StringCodec } from "nats";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";

const logger = createLogger({ name: "agent-register-api" });
const sc = StringCodec();

const VALIDATE_TIMEOUT_MS = 15_000;

/** Shape the agent SDK publishes to agents.validate.{id} */
const AgentValidateResponseSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string(),
  displayName: z.string().optional(),
  llm: AgentLLMConfigSchema.optional(),
  mcp: z.record(z.string(), MCPServerConfigSchema).optional(),
  useWorkspaceSkills: z.boolean().optional(),
});

const RegisterRequestSchema = z.object({ entrypoint: z.string().min(1) });

function buildSpawnArgs(entrypointPath: string): [string, string[]] {
  if (entrypointPath.endsWith(".py")) return ["python3", [entrypointPath]];
  if (entrypointPath.endsWith(".ts"))
    return ["deno", ["run", "--allow-net", "--allow-env", "--allow-read", entrypointPath]];
  return [entrypointPath, []];
}

async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

const registerAgentRoute = daemonFactory.createApp();

registerAgentRoute.post("/register", async (c) => {
  const registerId = crypto.randomUUID();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Request body must be JSON", phase: "prereqs" }, 400);
  }

  const parsed = RegisterRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: "entrypoint path is required", phase: "prereqs" }, 400);
  }

  const entrypointPath = parsed.data.entrypoint;
  const entrypointFile = basename(entrypointPath);
  const sourceDir = dirname(entrypointPath);

  const nc = c.get("app").daemon.getNatsConnection();

  // Subscribe BEFORE spawning to avoid race (agent may publish and exit fast)
  const sub = nc.subscribe(`agents.validate.${registerId}`, { max: 1 });

  const [cmd, args] = buildSpawnArgs(entrypointPath);
  const proc = spawn(cmd, args, {
    env: { ...process.env, FRIDAY_VALIDATE_ID: registerId, NATS_URL: "nats://localhost:4222" },
    stdio: "pipe",
  });

  const stderrLines: string[] = [];
  proc.stderr?.on("data", (chunk: Uint8Array) => {
    stderrLines.push(...chunk.toString().split("\n").filter(Boolean));
  });

  let metadata: z.infer<typeof AgentValidateResponseSchema>;
  try {
    const msg = await Promise.race([
      (async () => {
        for await (const m of sub) return m;
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("validate timeout")), VALIDATE_TIMEOUT_MS),
      ),
    ]);

    if (!msg) throw new Error("No metadata received from agent");
    const raw: unknown = JSON.parse(sc.decode(msg.data));
    const result = AgentValidateResponseSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
      return c.json(
        { ok: false, error: `Invalid agent metadata: ${issues}`, phase: "validate" },
        400,
      );
    }
    metadata = result.data;
  } catch (error: unknown) {
    const stderr = stderrLines.join("\n");
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn("Agent validation failed", { registerId, error: msg, stderr });
    return c.json(
      { ok: false, error: `${msg}${stderr ? `\n${stderr}` : ""}`, phase: "validate" },
      400,
    );
  } finally {
    sub.unsubscribe();
    proc.kill("SIGTERM");
  }

  // Install: copy source files + write metadata.json
  const agentsDir = join(getFridayHome(), "agents");
  const artifactName = `${metadata.id}@${metadata.version}`;
  const tmpDir = join(agentsDir, `${artifactName}.tmp`);
  const finalDir = join(agentsDir, artifactName);

  try {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    await cp(sourceDir, tmpDir, {
      recursive: true,
      filter: (src) => {
        const name = basename(src);
        return (
          !["__pycache__", ".git", "venv", "node_modules", ".venv"].includes(name) &&
          !name.endsWith(".pyc")
        );
      },
    });

    const hash = await sha256File(entrypointPath).catch(() => undefined);

    const metadataObj: Record<string, unknown> = {
      id: metadata.id,
      version: metadata.version,
      description: metadata.description,
      entrypoint: entrypointFile,
    };
    if (metadata.displayName !== undefined) metadataObj.displayName = metadata.displayName;
    if (metadata.llm !== undefined) metadataObj.llm = metadata.llm;
    if (metadata.mcp !== undefined) metadataObj.mcp = metadata.mcp;
    if (metadata.useWorkspaceSkills !== undefined)
      metadataObj.useWorkspaceSkills = metadata.useWorkspaceSkills;
    if (hash !== undefined) metadataObj.hash = hash;

    await writeFile(join(tmpDir, "metadata.json"), JSON.stringify(metadataObj, null, 2));

    await rm(finalDir, { recursive: true, force: true });
    await rename(tmpDir, finalDir);

    logger.info("Agent registered", {
      registerId,
      agentId: metadata.id,
      version: metadata.version,
      outputPath: finalDir,
    });
  } catch (error: unknown) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to write agent artifacts", { registerId, error: msg });
    return c.json({ ok: false, error: msg, phase: "write" }, 500);
  }

  const registry = c.get("app").getAgentRegistry();
  await registry.reload();

  return c.json({
    ok: true,
    agent: {
      id: metadata.id,
      version: metadata.version,
      description: metadata.description,
      path: finalDir,
    },
  });
});

export { registerAgentRoute };

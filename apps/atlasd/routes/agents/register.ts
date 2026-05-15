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
import { buildAgentSpawnArgs } from "../../src/agent-spawn.ts";
import { daemonFactory } from "../../src/factory.ts";

const logger = createLogger({ name: "agent-register-api" });
const sc = StringCodec();

// First-spawn uv-run cold-cache: 5-30s for the CPython 3.12 download +
// friday-agent-sdk wheel fetch. Warm-cache spawn is 50-100ms. 60s gives
// the first-ever register on a machine that bypassed the installer
// pre-warm (apps/studio-installer/.../prewarm_agent_sdk.rs) and the
// dev script (scripts/setup-dev-env.sh) enough room to materialize the
// runtime, while still failing fast for actually-broken agents.
const VALIDATE_TIMEOUT_MS = 60_000;

/** Shape the agent SDK publishes to agents.validate.{id} */
const AgentValidateResponseSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string(),
  displayName: z.string().optional(),
  llm: AgentLLMConfigSchema.optional(),
  mcp: z.record(z.string(), MCPServerConfigSchema).optional(),
  useWorkspaceSkills: z.boolean().optional(),
  // Authoring metadata added in friday-agent-sdk 0.1.0+. The SDK publishes
  // these on validate; the read path in routes/agents/get.ts surfaces them
  // back. Keeping all six optional so older SDKs still register cleanly.
  summary: z.string().optional(),
  constraints: z.string().optional(),
  expertise: z.object({ examples: z.array(z.string()) }).optional(),
  environment: z.record(z.string(), z.unknown()).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

const RegisterRequestSchema = z.object({ entrypoint: z.string().min(1) });

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
  const natsUrl = c.get("app").daemon.getNatsUrl();

  // Subscribe BEFORE spawning to avoid race (agent may publish and exit fast).
  // The flush() is load-bearing: without it, the SUB protocol message can sit
  // in the client buffer while a warm-cached uv spawn (~50–100ms) lets the
  // child connect, publish validate, drain, and exit before the broker
  // registers our subscription. The metadata message is then lost; this
  // route times out at VALIDATE_TIMEOUT_MS with no useful diagnostic.
  // Mirrors the readiness flush the SDK side does post-subscribe in
  // friday_agent_sdk/_bridge.py.
  const sub = nc.subscribe(`agents.validate.${registerId}`, { max: 1 });
  await nc.flush();

  const [cmd, args] = buildAgentSpawnArgs(entrypointPath);
  // stdio shape: stdout is "ignore" because the validate handshake travels
  // over NATS, never over stdout — leaving stdout piped would (a) consume an
  // FD per spawn for no reason and (b) let an agent that prints to stdout
  // (sdk debug output, accidental print) block on `write()` once the 64 KiB
  // pipe buffer fills, since nobody on the parent side is reading it.
  // stderr stays piped so we can attribute crash output to the agent.
  const proc = spawn(cmd, args, {
    env: { ...process.env, FRIDAY_VALIDATE_ID: registerId, NATS_URL: natsUrl },
    stdio: ["ignore", "ignore", "pipe"],
  });

  const stderrLines: string[] = [];
  proc.stderr?.on("data", (chunk: Uint8Array) => {
    stderrLines.push(...chunk.toString().split("\n").filter(Boolean));
  });

  // Resolves when the child exits — used in `finally` to wait for the
  // SIGTERM'd child to actually terminate before we release the pid file
  // listener. Without this, the ChildProcess (and its stderr pipe FD) stays
  // in Node's table until GC visits it, which under daemon-level memory
  // pressure can be minutes after the route handler returns.
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
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
    // Send TERM, wait up to 2s for graceful exit, then escalate to KILL —
    // a hung user agent (deadlock, ignored SIGTERM) must not leak its
    // stderr pipe + ChildProcess ref for the rest of the daemon's life.
    // Mirrors the SIGTERM-then-SIGKILL grace pattern in ProcessAgentExecutor.
    proc.kill("SIGTERM");
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already dead — ignore.
      }
      await exited;
    }
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
    if (metadata.summary !== undefined) metadataObj.summary = metadata.summary;
    if (metadata.constraints !== undefined) metadataObj.constraints = metadata.constraints;
    if (metadata.expertise !== undefined) metadataObj.expertise = metadata.expertise;
    if (metadata.environment !== undefined) metadataObj.environment = metadata.environment;
    if (metadata.inputSchema !== undefined) metadataObj.inputSchema = metadata.inputSchema;
    if (metadata.outputSchema !== undefined) metadataObj.outputSchema = metadata.outputSchema;
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

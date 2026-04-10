/**
 * POST /api/agents/build — Build a Python WASM agent from uploaded source files.
 *
 * Accepts multipart/form-data with Python source files, runs the full build
 * pipeline (componentize-py → jco transpile → metadata validation), and writes
 * the built agent to the agents directory where it is immediately discoverable.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@atlas/logger";
import { AgentBuildError, buildAgent } from "@atlas/workspace/agent-builder";
import { daemonFactory } from "../../src/factory.ts";

const logger = createLogger({ name: "agent-build-api" });

/** Well-known SDK path inside the Docker container */
const CONTAINER_SDK_PATH = "/opt/friday-agent-sdk";

const buildAgentRoute = daemonFactory.createApp();

buildAgentRoute.post("/build", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json(
      { ok: false, error: "Content-Type must be multipart/form-data", phase: "prereqs" },
      400,
    );
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json(
      {
        ok: false,
        error: "At least one Python source file is required (field: files)",
        phase: "prereqs",
      },
      400,
    );
  }

  // Extract uploaded files
  const files: File[] = [];
  for (const [key, value] of formData.entries()) {
    if (key === "files" || key === "files[]") {
      if (value instanceof File) {
        files.push(value);
      }
    }
  }

  if (files.length === 0) {
    return c.json(
      {
        ok: false,
        error: "At least one Python source file is required (field: files)",
        phase: "prereqs",
      },
      400,
    );
  }

  // Validate all files are .py
  for (const file of files) {
    if (!file.name.endsWith(".py")) {
      return c.json(
        { ok: false, error: `Only .py files are accepted, got: ${file.name}`, phase: "prereqs" },
        400,
      );
    }
  }

  const entryPoint = formData.get("entry_point")?.toString() ?? undefined;
  const sdkPath = formData.get("sdk_path")?.toString() ?? CONTAINER_SDK_PATH;

  // Write files to a temp directory
  const buildId = crypto.randomUUID();
  const tempDir = join(tmpdir(), `agent-build-${buildId}`);

  try {
    await mkdir(tempDir, { recursive: true });

    // Write all uploaded files to temp dir
    for (const file of files) {
      const content = new Uint8Array(await file.arrayBuffer());
      await writeFile(join(tempDir, file.name), content);
    }

    // Derive entry point from first file if not specified
    const firstFile = files[0];
    if (!firstFile) {
      return c.json(
        { ok: false, error: "No files available after validation", phase: "prereqs" },
        400,
      );
    }
    const resolvedEntryPoint = entryPoint ?? firstFile.name.replace(/\.py$/, "");

    logger.info("Starting agent build", {
      buildId,
      fileCount: files.length,
      entryPoint: resolvedEntryPoint,
      sdkPath,
    });

    const result = await buildAgent({
      agentDir: tempDir,
      sdkPath,
      entryPoint: resolvedEntryPoint,
      logger,
    });

    // Reload registry so the newly built agent is immediately discoverable
    const registry = c.get("app").getAgentRegistry();
    await registry.reload();

    return c.json({
      ok: true,
      agent: {
        id: result.id,
        version: result.version,
        description: result.description,
        path: result.outputPath,
      },
    });
  } catch (error: unknown) {
    if (error instanceof AgentBuildError) {
      // Classify status code by phase
      const status = error.phase === "compile" || error.phase === "validate" ? 400 : 500;
      logger.warn("Agent build failed", { buildId, phase: error.phase, error: error.message });
      return c.json({ ok: false, error: error.message, phase: error.phase }, status);
    }

    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Unexpected agent build error", { buildId, error: msg });
    return c.json({ ok: false, error: msg, phase: "compile" }, 500);
  } finally {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

export { buildAgentRoute };

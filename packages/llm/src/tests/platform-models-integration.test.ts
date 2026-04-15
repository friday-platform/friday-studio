/**
 * Integration test composing the full Tracer Bullet pipeline:
 *   FilesystemAtlasConfigSource → createPlatformModels
 *
 * Proves that a real friday.yml on disk flows through Zod validation and lands
 * in a usable `PlatformModels` resolver. Exercises the happy path, the
 * no-config path, invalid YAML, and the LITELLM-only credential path.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { FilesystemAtlasConfigSource } from "@atlas/config/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlatformModels, PlatformModelsConfigError } from "../platform-models.ts";

const TOUCHED_ENV = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "LITELLM_API_KEY",
] as const;

const originalEnv: Partial<Record<string, string>> = {};

beforeEach(() => {
  for (const key of TOUCHED_ENV) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TOUCHED_ENV) {
    delete process.env[key];
    if (originalEnv[key] !== undefined) process.env[key] = originalEnv[key];
  }
});

async function makeWorkspaceDir(yaml: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atlas-platform-models-"));
  if (yaml !== null) {
    await writeFile(join(dir, "friday.yml"), yaml, "utf-8");
  }
  return dir;
}

describe("FilesystemAtlasConfigSource → createPlatformModels pipeline", () => {
  let workspaceDir: string | null = null;

  afterEach(async () => {
    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
    }
  });

  it("loads friday.yml with models block and resolves all four roles", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    workspaceDir = await makeWorkspaceDir(`
version: "1.0"
workspace:
  name: test-ws
models:
  classifier: anthropic:claude-haiku-4-5
  planner: anthropic:claude-sonnet-4-6
`);

    const source = new FilesystemAtlasConfigSource(workspaceDir);
    const config = await source.load();
    expect(config).not.toBeNull();
    expect(config?.models?.classifier).toBe("anthropic:claude-haiku-4-5");

    const models = createPlatformModels(config);
    expect(models.get("classifier")).toBeDefined();
    expect(models.get("planner")).toBeDefined();
    expect(models.get("labels")).toBeDefined();
    expect(models.get("conversational")).toBeDefined();
  });

  it("returns null from source when friday.yml is missing; factory still works on defaults", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    workspaceDir = await makeWorkspaceDir(null);

    const source = new FilesystemAtlasConfigSource(workspaceDir);
    const config = await source.load();
    expect(config).toBeNull();

    const models = createPlatformModels(config);
    expect(models.get("classifier")).toBeDefined();
  });

  it("throws ConfigValidationError from source on invalid models block", async () => {
    workspaceDir = await makeWorkspaceDir(`
version: "1.0"
workspace:
  name: test-ws
models:
  planner: "not-a-valid-format"
`);

    const source = new FilesystemAtlasConfigSource(workspaceDir);
    await expect(source.load()).rejects.toThrow();
  });

  it("composes LITELLM-only credentials end-to-end", async () => {
    process.env.LITELLM_API_KEY = "sk-litellm-test";
    workspaceDir = await makeWorkspaceDir(`
version: "1.0"
workspace:
  name: test-ws
models:
  planner: openai:gpt-4o
`);

    const source = new FilesystemAtlasConfigSource(workspaceDir);
    const config = await source.load();
    const models = createPlatformModels(config);
    expect(models.get("planner")).toBeDefined();
  });

  it("throws PlatformModelsConfigError when friday.yml references provider without credentials", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    workspaceDir = await makeWorkspaceDir(`
version: "1.0"
workspace:
  name: test-ws
models:
  planner: openai:gpt-4o
`);

    const source = new FilesystemAtlasConfigSource(workspaceDir);
    const config = await source.load();
    expect(() => createPlatformModels(config)).toThrow(PlatformModelsConfigError);
  });
});

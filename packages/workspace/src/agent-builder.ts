/**
 * @module agent-builder
 *
 * Shared build pipeline for Python WASM agents. Compiles Python source to WASM
 * via componentize-py, transpiles to JS via jco, validates metadata, and writes
 * the final artifact to the agents directory.
 *
 * Used by both the CLI (`atlas agent build`) and the daemon API (`POST /api/agents/build`).
 */

import { execFile } from "node:child_process";
import { accessSync } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CreateAgentConfigValidationSchema } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { getAtlasHome } from "@atlas/utils/paths.server";

const execFileAsync = promisify(execFile);

/** Build phase identifiers for error classification */
export type BuildPhase = "prereqs" | "compile" | "transpile" | "validate" | "write";

/** Error thrown during agent build with phase information */
export class AgentBuildError extends Error {
  constructor(
    message: string,
    readonly phase: BuildPhase,
  ) {
    super(message);
    this.name = "AgentBuildError";
  }
}

export interface AgentBuildOptions {
  /** Directory containing the Python source files */
  agentDir: string;
  /** Path to the friday-agent-sdk Python package root */
  sdkPath: string;
  /** Path to WIT directory (defaults to {sdkPath}/wit) */
  witDir?: string;
  /** Python entry module name without .py extension (defaults to "agent") */
  entryPoint?: string;
  logger: Logger;
}

export interface AgentBuildResult {
  id: string;
  version: string;
  description: string;
  outputPath: string;
}

/** Check that a CLI tool exists and return its version string */
async function checkPrerequisite(
  tool: string,
  versionFlag: string,
  installHint: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(tool, [versionFlag]);
    return stdout.trim();
  } catch {
    throw new AgentBuildError(
      `"${tool}" not found on PATH.\n\nInstall it:\n  ${installHint}`,
      "prereqs",
    );
  }
}

/** Resolve the SDK package path by walking up from agent dir looking for sdk-python */
export function resolveSdkPath(agentDir: string): string | undefined {
  let dir = resolve(agentDir);
  for (let i = 0; i < 10; i++) {
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;

    const candidates = [join(dir, "packages", "sdk-python"), join(dir, "sdk-python")];

    for (const candidate of candidates) {
      try {
        accessSync(join(candidate, "wit", "agent.wit"));
        return candidate;
      } catch {
        /* accessSync throws if path doesn't exist — expected */
      }
    }
  }

  // Fallback: check the well-known container path used in Docker images
  const containerSdkPath = "/opt/friday-agent-sdk";
  try {
    accessSync(join(containerSdkPath, "wit", "agent.wit"));
    return containerSdkPath;
  } catch {
    /* not in a container — expected */
  }

  return undefined;
}

/** Capabilities stub content for build-time validation */
const CAPABILITIES_STUB = [
  "export function callTool(_name, _args) { return '{}'; }",
  "export function listTools() { return []; }",
  "export function log(_level, _message) {}",
  "export function streamEmit(_eventType, _data) {}",
  "export function llmGenerate(_request) { return '{}'; }",
  "export function httpFetch(_request) { return '{}'; }",
  "",
].join("\n");

/**
 * Build a Python WASM agent.
 *
 * Runs the full pipeline: prereq check, componentize-py, jco transpile,
 * metadata validation, and artifact write. Throws AgentBuildError with
 * phase information on failure.
 */
export async function buildAgent(options: AgentBuildOptions): Promise<AgentBuildResult> {
  const { logger } = options;
  const agentDir = resolve(options.agentDir);
  const entryPoint = options.entryPoint ?? "agent";

  // 1. Check prerequisites
  logger.info("Checking prerequisites...");

  const [componentizePyVersion, jcoVersion] = await Promise.all([
    checkPrerequisite("componentize-py", "--version", "pip install componentize-py"),
    checkPrerequisite("jco", "--version", "npm install -g @bytecodealliance/jco"),
  ]);

  logger.info("Prerequisites found", { componentizePyVersion, jcoVersion });

  // 2. Detect entry point
  const entryFile = join(agentDir, `${entryPoint}.py`);
  try {
    await access(entryFile);
  } catch {
    throw new AgentBuildError(
      `Entry point "${entryPoint}.py" not found in ${agentDir}\n\nExpected: ${entryFile}`,
      "compile",
    );
  }

  // 3. Resolve SDK and WIT paths
  const sdkPath = resolve(options.sdkPath);
  const witDir = options.witDir ? resolve(options.witDir) : join(sdkPath, "wit");

  try {
    await access(join(witDir, "agent.wit"));
  } catch {
    throw new AgentBuildError(
      `WIT directory missing or invalid: ${witDir}\n\nExpected agent.wit in: ${witDir}`,
      "prereqs",
    );
  }

  // 4. Run componentize-py
  logger.info("Compiling Python agent to WASM...");

  const wasmOutput = join(agentDir, "agent.wasm");

  try {
    await execFileAsync("componentize-py", [
      "-d",
      witDir,
      "-w",
      "friday:agent/friday-agent",
      "componentize",
      entryPoint,
      "-p",
      agentDir,
      "-p",
      sdkPath,
      "-o",
      wasmOutput,
    ]);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new AgentBuildError(`componentize-py failed:\n${msg}`, "compile");
  }

  // 5. Run jco transpile with JSPI flags
  logger.info("Transpiling WASM to JavaScript...");

  const jsOutputDir = join(agentDir, "agent-js");

  try {
    await execFileAsync("jco", [
      "transpile",
      wasmOutput,
      "-o",
      jsOutputDir,
      "--async-mode",
      "jspi",
      "--async-imports",
      "friday:agent/capabilities#call-tool",
      "--async-imports",
      "friday:agent/capabilities#llm-generate",
      "--async-imports",
      "friday:agent/capabilities#http-fetch",
      "--async-exports",
      "friday:agent/agent#execute",
      "--map",
      "friday:agent/capabilities=./capabilities.js",
    ]);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new AgentBuildError(`jco transpile failed:\n${msg}`, "transpile");
  }

  // Write capabilities stub after transpile so it's available for validation import
  await writeFile(join(jsOutputDir, "capabilities.js"), CAPABILITIES_STUB);

  // Vendor preview2-shim into source dir and rewrite bare specifiers so the
  // dynamic import below resolves — agents built outside the monorepo can't
  // reach node_modules/@bytecodealliance/preview2-shim via bare specifiers.
  const srcShimDir = join(agentDir, "node_modules", "@bytecodealliance", "preview2-shim");
  await vendorPreview2Shim(srcShimDir);
  await rewriteShimImports(join(jsOutputDir, "agent.js"));

  // 6. Instantiate module and validate metadata
  logger.info("Validating agent metadata...");

  const agentModulePath = join(jsOutputDir, "agent.js");
  let metadata: unknown;

  try {
    const agentModule = await import(agentModulePath);
    const rawMetadata = agentModule.agent.getMetadata();
    metadata = JSON.parse(rawMetadata);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new AgentBuildError(`Failed to load agent module and read metadata:\n${msg}`, "validate");
  }

  const validationResult = CreateAgentConfigValidationSchema.safeParse(metadata);
  if (!validationResult.success) {
    const issues = validationResult.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new AgentBuildError(
      `Agent metadata validation failed:\n${issues}\n\nRaw metadata: ${JSON.stringify(metadata, null, 2)}`,
      "validate",
    );
  }

  const validatedMetadata = validationResult.data;
  const agentId = validatedMetadata.id;
  const agentVersion = validatedMetadata.version;

  // 7. Write to atlas home with atomic rename
  const agentsDir = join(getAtlasHome(), "agents");
  const artifactName = `${agentId}@${agentVersion}`;
  const tmpDir = join(agentsDir, `${artifactName}.tmp`);
  const finalDir = join(agentsDir, artifactName);

  try {
    // Clean up any leftover tmp dir
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    // Copy transpiled output to tmp dir, preserving agent-js/ subdirectory
    const agentJsDir = join(tmpDir, "agent-js");
    await mkdir(agentJsDir, { recursive: true });
    await copyDir(jsOutputDir, agentJsDir);

    // Vendor preview2-shim and rewrite bare specifiers to relative paths.
    // Dynamic imports from ~/.atlas/agents/ can't resolve bare specifiers
    // in either Node (no node_modules/ in ancestor) or Deno (not in import map).
    const shimDestDir = join(tmpDir, "node_modules", "@bytecodealliance", "preview2-shim");
    await vendorPreview2Shim(shimDestDir);
    await rewriteShimImports(join(agentJsDir, "agent.js"));

    // Write metadata sidecar
    await writeFile(join(tmpDir, "metadata.json"), JSON.stringify(validatedMetadata, null, 2));

    // Atomic rename
    await rm(finalDir, { recursive: true, force: true });
    await rename(tmpDir, finalDir);

    logger.info("Agent built successfully", { agentId, agentVersion, outputPath: finalDir });
  } catch (error: unknown) {
    // Clean up tmp on failure
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof AgentBuildError) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    throw new AgentBuildError(`Failed to write build artifacts:\n${msg}`, "write");
  }

  return {
    id: agentId,
    version: agentVersion,
    description: validatedMetadata.description,
    outputPath: finalDir,
  };
}

/** Rewrite bare @bytecodealliance/preview2-shim imports to relative paths */
async function rewriteShimImports(agentJsPath: string): Promise<void> {
  const content = await readFile(agentJsPath, "utf-8");
  const rewritten = content.replace(
    /from\s+['"]@bytecodealliance\/preview2-shim\/([^'"]+)['"]/g,
    (_match, subpath) =>
      `from '../node_modules/@bytecodealliance/preview2-shim/lib/nodejs/${subpath}.js'`,
  );
  await writeFile(agentJsPath, rewritten);
}

/** Vendor the @bytecodealliance/preview2-shim package into the agent output directory */
async function vendorPreview2Shim(destDir: string): Promise<void> {
  const require = createRequire(import.meta.url);
  const shimEntry = require.resolve("@bytecodealliance/preview2-shim");
  // Walk up from the resolved entry until we find the package root (contains package.json)
  let shimSrcDir = dirname(shimEntry);
  for (let i = 0; i < 10; i++) {
    try {
      await access(join(shimSrcDir, "package.json"));
      break;
    } catch {
      shimSrcDir = dirname(shimSrcDir);
    }
  }
  await copyDir(shimSrcDir, destDir);
}

/** Recursively copy a directory */
async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

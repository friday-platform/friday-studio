#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write

/**
 * Integration tests for validating all workspace configurations
 * Ensures all example workspaces, system workspaces, and reference configurations are valid
 */

import { expect } from "@std/expect";
import { join, resolve } from "@std/path";
import { walk } from "@std/fs";
import { ConfigLoader, formatZodError } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { z } from "zod/v4";

interface WorkspaceValidationResult {
  path: string;
  valid: boolean;
  error?: string;
  details?: {
    workspaceName?: string;
    hasAtlasConfig?: boolean;
    agentCount?: number;
    signalCount?: number;
    jobCount?: number;
  };
}

/**
 * Get all workspace directories that contain workspace.yml files
 */
async function findWorkspaceDirectories(): Promise<string[]> {
  const workspaceDirs: string[] = [];
  const projectRoot = resolve(Deno.cwd());

  // Find all workspace.yml files in examples
  const examplesDir = join(projectRoot, "examples");
  for await (
    const entry of walk(examplesDir, {
      match: [/workspace\.yml$/],
      maxDepth: 3,
    })
  ) {
    if (entry.isFile) {
      workspaceDirs.push(entry.path.replace("/workspace.yml", ""));
    }
  }

  return workspaceDirs;
}

/**
 * Validate a single workspace configuration
 */
async function validateWorkspaceConfig(workspacePath: string): Promise<WorkspaceValidationResult> {
  const result: WorkspaceValidationResult = {
    path: workspacePath,
    valid: false,
  };

  try {
    const adapter = new FilesystemConfigAdapter(workspacePath);
    const loader = new ConfigLoader(adapter, workspacePath);

    // Load and validate the configuration
    const config = await loader.load();

    // Extract details for reporting
    result.details = {
      workspaceName: config.workspace.workspace.name,
      hasAtlasConfig: config.atlas !== null,
      agentCount: Object.keys(config.workspace.agents || {}).length,
      signalCount: Object.keys(config.workspace.signals || {}).length,
      jobCount: Object.keys(config.workspace.jobs || {}).length,
    };

    result.valid = true;
  } catch (error) {
    if (error instanceof Error) {
      result.error = error.message;

      // If it's a ConfigValidationError with Zod details, format them nicely
      if (error.name === "ConfigValidationError" && "zodError" in error) {
        result.error += `\n\nValidation Details:\n${
          formatZodError(error.zodError as z.ZodError<unknown>)
        }`;
      }
    } else {
      result.error = String(error);
    }
  }

  return result;
}

/**
 * Validate a standalone workspace.yml file (for system workspaces)
 */
async function validateStandaloneWorkspace(filePath: string): Promise<WorkspaceValidationResult> {
  const result: WorkspaceValidationResult = {
    path: filePath,
    valid: false,
  };

  try {
    // Create a temporary directory and copy the file there
    const tempDir = await Deno.makeTempDir();
    const tempWorkspacePath = join(tempDir, "workspace.yml");

    try {
      const content = await Deno.readTextFile(filePath);
      await Deno.writeTextFile(tempWorkspacePath, content);

      const adapter = new FilesystemConfigAdapter(tempDir);
      const loader = new ConfigLoader(adapter, tempDir);

      // Only load workspace config since we don't have atlas.yml
      const workspaceConfig = await loader.loadWorkspace();

      result.details = {
        workspaceName: workspaceConfig.workspace.name,
        hasAtlasConfig: false,
        agentCount: Object.keys(workspaceConfig.agents || {}).length,
        signalCount: Object.keys(workspaceConfig.signals || {}).length,
        jobCount: Object.keys(workspaceConfig.jobs || {}).length,
      };

      result.valid = true;
    } finally {
      // Clean up temp directory
      await Deno.remove(tempDir, { recursive: true });
    }
  } catch (error) {
    if (error instanceof Error) {
      result.error = error.message;

      // If it's a ConfigValidationError with Zod details, format them nicely
      if (error.name === "ConfigValidationError" && "zodError" in error) {
        result.error += `\n\nValidation Details:\n${
          formatZodError(error.zodError as z.ZodError<unknown>)
        }`;
      }
    } else {
      result.error = String(error);
    }
  }

  return result;
}

Deno.test("Workspace Configurations: Validate all example workspaces", async () => {
  const workspaceDirs = await findWorkspaceDirectories();

  expect(workspaceDirs.length).toBeGreaterThan(0);
  console.log(`\nFound ${workspaceDirs.length} example workspaces to validate:`);

  const results: WorkspaceValidationResult[] = [];

  for (const workspaceDir of workspaceDirs) {
    console.log(`  Validating: ${workspaceDir.split("/").slice(-2).join("/")}`);
    const result = await validateWorkspaceConfig(workspaceDir);
    results.push(result);

    if (result.valid) {
      console.log(
        `    ✅ Valid - ${result.details?.workspaceName} (${result.details?.agentCount} agents, ${result.details?.signalCount} signals, ${result.details?.jobCount} jobs)`,
      );
    } else {
      console.log(`    ❌ Invalid - ${result.error?.split("\n")[0]}`);
    }
  }

  // Report summary
  const validCount = results.filter((r) => r.valid).length;
  const invalidCount = results.filter((r) => !r.valid).length;

  console.log(`\nExample Workspaces Summary:`);
  console.log(`  ✅ Valid: ${validCount}`);
  console.log(`  ❌ Invalid: ${invalidCount}`);

  // If there are invalid configurations, show detailed errors
  const invalidResults = results.filter((r) => !r.valid);
  if (invalidResults.length > 0) {
    console.log(`\nDetailed validation errors:`);
    for (const result of invalidResults) {
      console.log(`\n${result.path}:`);
      console.log(result.error);
    }
  }

  // All example workspaces should be valid
  expect(invalidCount).toBe(0);
});

Deno.test("Workspace Configurations: Validate system workspace", async () => {
  const projectRoot = resolve(Deno.cwd());
  const systemWorkspacePath = join(
    projectRoot,
    "packages",
    "system",
    "workspaces",
    "conversation.yml",
  );

  console.log(`\nValidating system workspace: ${systemWorkspacePath}`);

  const result = await validateStandaloneWorkspace(systemWorkspacePath);

  if (result.valid) {
    console.log(`✅ Valid - ${result.details?.workspaceName}`);
    console.log(`   Agents: ${result.details?.agentCount}`);
    console.log(`   Signals: ${result.details?.signalCount}`);
    console.log(`   Jobs: ${result.details?.jobCount}`);
  } else {
    console.log(`❌ Invalid system workspace`);
    console.log(result.error);
  }

  expect(result.valid).toBe(true);
});

Deno.test("Workspace Configurations: Validate workspace reference", async () => {
  const projectRoot = resolve(Deno.cwd());
  const referenceWorkspacePath = join(
    projectRoot,
    "packages",
    "mcp-server",
    "src",
    "resources",
    "workspace-reference.yml",
  );

  console.log(`\nValidating workspace reference: ${referenceWorkspacePath}`);

  const result = await validateStandaloneWorkspace(referenceWorkspacePath);

  if (result.valid) {
    console.log(`✅ Valid - ${result.details?.workspaceName}`);
    console.log(`   Agents: ${result.details?.agentCount}`);
    console.log(`   Signals: ${result.details?.signalCount}`);
    console.log(`   Jobs: ${result.details?.jobCount}`);
  } else {
    console.log(`❌ Invalid workspace reference`);
    console.log(result.error);
  }

  expect(result.valid).toBe(true);
});

Deno.test("Workspace Configurations: Comprehensive validation report", async () => {
  console.log(`\n${"=".repeat(80)}`);
  console.log("COMPREHENSIVE WORKSPACE VALIDATION REPORT");
  console.log(`${"=".repeat(80)}`);

  const projectRoot = resolve(Deno.cwd());
  const allResults: WorkspaceValidationResult[] = [];

  // Validate all example workspaces
  const workspaceDirs = await findWorkspaceDirectories();
  console.log(`\n📁 Example Workspaces (${workspaceDirs.length} found):`);

  for (const workspaceDir of workspaceDirs) {
    const result = await validateWorkspaceConfig(workspaceDir);
    allResults.push(result);

    const shortPath = workspaceDir.split("/").slice(-2).join("/");
    const status = result.valid ? "✅" : "❌";
    const name = result.details?.workspaceName || "Unknown";
    const hasAtlas = result.details?.hasAtlasConfig ? " (+atlas)" : "";

    console.log(`  ${status} ${shortPath} - ${name}${hasAtlas}`);
    if (result.details && result.valid) {
      console.log(
        `      📊 ${result.details.agentCount} agents, ${result.details.signalCount} signals, ${result.details.jobCount} jobs`,
      );
    }
  }

  // Validate system workspace
  console.log(`\n🔧 System Workspaces:`);
  const systemWorkspacePath = join(
    projectRoot,
    "packages",
    "system",
    "workspaces",
    "conversation.yml",
  );
  const systemResult = await validateStandaloneWorkspace(systemWorkspacePath);
  allResults.push(systemResult);

  const systemStatus = systemResult.valid ? "✅" : "❌";
  const systemName = systemResult.details?.workspaceName || "Unknown";
  console.log(`  ${systemStatus} system/conversation.yml - ${systemName}`);
  if (systemResult.details && systemResult.valid) {
    console.log(
      `      📊 ${systemResult.details.agentCount} agents, ${systemResult.details.signalCount} signals, ${systemResult.details.jobCount} jobs`,
    );
  }

  // Validate reference workspace
  console.log(`\n📖 Reference Workspaces:`);
  const referenceWorkspacePath = join(
    projectRoot,
    "packages",
    "mcp-server",
    "src",
    "resources",
    "workspace-reference.yml",
  );
  const referenceResult = await validateStandaloneWorkspace(referenceWorkspacePath);
  allResults.push(referenceResult);

  const refStatus = referenceResult.valid ? "✅" : "❌";
  const refName = referenceResult.details?.workspaceName || "Unknown";
  console.log(`  ${refStatus} mcp-server/workspace-reference.yml - ${refName}`);
  if (referenceResult.details && referenceResult.valid) {
    console.log(
      `      📊 ${referenceResult.details.agentCount} agents, ${referenceResult.details.signalCount} signals, ${referenceResult.details.jobCount} jobs`,
    );
  }

  // Summary statistics
  const totalValidated = allResults.length;
  const totalValid = allResults.filter((r) => r.valid).length;
  const totalInvalid = allResults.filter((r) => !r.valid).length;

  console.log(`\n📈 Summary:`);
  console.log(`  Total workspaces validated: ${totalValidated}`);
  console.log(`  Valid configurations: ${totalValid}`);
  console.log(`  Invalid configurations: ${totalInvalid}`);
  console.log(`  Success rate: ${Math.round((totalValid / totalValidated) * 100)}%`);

  // Show errors if any
  const invalidResults = allResults.filter((r) => !r.valid);
  if (invalidResults.length > 0) {
    console.log(`\n❌ Validation Errors:`);
    for (const result of invalidResults) {
      const shortPath = result.path.split("/").slice(-3).join("/");
      console.log(`\n  ${shortPath}:`);
      console.log(`    ${result.error?.split("\n")[0]}`);
    }
  }

  console.log(`\n${"=".repeat(80)}`);

  // The test passes if all configurations are valid
  expect(totalInvalid).toBe(0);
});

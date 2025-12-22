#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

// This script generates build information at compile time
// It should be run before building the application in CI/CD

import { dirname, fromFileUrl, join } from "jsr:@std/path@^1.0.0";
import { readFile } from "node:fs/promises";
import process, { env } from "node:process";

const __dirname = dirname(fromFileUrl(import.meta.url));

// Determine build type based on environment variables or Git branch
let buildType = "development";
const envBuildType = env.BUILD_TYPE;
if (envBuildType) {
  buildType = envBuildType;
} else {
  const githubRef = env.GITHUB_REF;
  if (githubRef) {
    if (githubRef.includes("edge")) {
      buildType = "edge";
    } else if (githubRef.includes("nightly")) {
      buildType = "nightly";
    }
  }
}

// Get commit hash from environment variables
// For local development, this should be passed via environment variable:
// GIT_COMMIT_HASH=$(git rev-parse --short HEAD) deno run --allow-all scripts/generate-build-info.ts
const githubSha = env.GITHUB_SHA;
const commitHash = env.GIT_COMMIT_HASH || (githubSha ? githubSha.substring(0, 8) : "unknown");

// Get version from package.json or environment
let version = env.APP_VERSION || "0.1.0";
if (!env.APP_VERSION) {
  try {
    const packageJsonText = await readFile(join(__dirname, "..", "package.json"), "utf-8");
    const packageJson = JSON.parse(packageJsonText);
    if (
      typeof packageJson === "object" &&
      packageJson !== null &&
      "version" in packageJson &&
      typeof packageJson.version === "string"
    ) {
      version = packageJson.version;
    }
  } catch {
    // Keep default version
  }
}

// Get build information
interface BuildInfo {
  commitHash: string;
  buildType: string;
  buildDate: string;
  version: string;
}

const buildInfo: BuildInfo = {
  commitHash,
  buildType,
  buildDate: new Date().toISOString(),
  version,
};

// Generate TypeScript module that will be imported at build time
const content = `// Auto-generated file - DO NOT EDIT
// Generated at: ${buildInfo.buildDate}

export const BUILD_INFO = ${JSON.stringify(buildInfo, null, 2)} as const;
`;

const outputPath = join(__dirname, "..", "src", "lib", "build-info.ts");

try {
  await Deno.writeTextFile(outputPath, content);
  console.log("Build info generated successfully:", buildInfo);
} catch (error) {
  console.error("Failed to generate build info:", error);
  process.exit(1);
}

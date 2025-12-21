#!/usr/bin/env -S deno run --allow-env --allow-run
/**
 * Cross-platform script to run Tauri build with TAURI_BUILD environment variable
 * Works on Windows, macOS, and Linux
 */

import process from "node:process";

// Set environment variable
process.env.TAURI_BUILD = "true";

// Run the build command
const command = new Deno.Command("deno", {
  args: ["task", "dev"],
  stdout: "inherit",
  stderr: "inherit",
  env: Deno.env.toObject(),
});

const { code } = await command.output();
process.exit(code);

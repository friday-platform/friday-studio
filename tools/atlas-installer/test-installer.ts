#!/usr/bin/env -S deno test --allow-read

/**
 * Tests to prevent installer JavaScript module system issues
 *
 * These tests prevent the issue where ES6 imports were mixed with CommonJS requires,
 * causing "require is not defined in ES module scope" errors.
 *
 * Related: https://github.com/tempestteam/atlas/pull/81
 * Fixed in commit: eb167e4794f24a337d95b1505f72d88d2b2d588a
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";

const INSTALLER_DIR = "/Users/lcf/code/github.com/tempestteam/atlas/tools/atlas-installer";

/**
 * List of JavaScript files that should be validated for consistent module usage
 */
const JS_FILES_TO_VALIDATE = [
  "main.js",
  "optimize-electron.js",
  "preload.js",
  "renderer.js",
];

/**
 * Prohibited patterns that caused the original issue
 */
const PROHIBITED_PATTERNS = [
  /^import\s+.*\s+from\s+['"']node:.*['"];?\s*$/gm, // import from node: modules
  /^import\s+process\s+from\s+['"']node:process['"];?\s*$/gm, // specific pattern that broke
];

/**
 * Required patterns for CommonJS files (if they use require, they should be consistent)
 */
const COMMONJS_PATTERNS = [
  /require\s*\(\s*['"'][^'"]+['"]s*\)/, // require statements
];

Deno.test("installer JavaScript files exist", () => {
  for (const filename of JS_FILES_TO_VALIDATE) {
    const filePath = join(INSTALLER_DIR, filename);
    assertEquals(existsSync(filePath), true, `${filename} should exist in installer directory`);
  }
});

Deno.test("installer JavaScript files do not contain prohibited ES6 import patterns", () => {
  for (const filename of JS_FILES_TO_VALIDATE) {
    const filePath = join(INSTALLER_DIR, filename);

    if (!existsSync(filePath)) {
      continue; // Skip if file doesn't exist (covered by previous test)
    }

    const content = Deno.readTextFileSync(filePath);

    for (const pattern of PROHIBITED_PATTERNS) {
      const matches = content.match(pattern);
      assertEquals(
        matches,
        null,
        `${filename} contains prohibited import pattern: ${pattern}. Found: ${
          matches?.join(", ")
        }\n` +
          `This pattern caused "require is not defined in ES module scope" errors.\n` +
          `Use require() for CommonJS or convert entire file to ES modules.`,
      );
    }
  }
});

Deno.test("installer JavaScript files use consistent module system", () => {
  for (const filename of JS_FILES_TO_VALIDATE) {
    const filePath = join(INSTALLER_DIR, filename);

    if (!existsSync(filePath)) {
      continue; // Skip if file doesn't exist
    }

    const content = Deno.readTextFileSync(filePath);

    // Check if file uses require (indicating CommonJS)
    const hasRequire = COMMONJS_PATTERNS.some((pattern) => pattern.test(content));

    // Check if file uses ES6 imports
    const hasES6Imports = /^import\s+.*\s+from\s+['"][^'"]+['"];?\s*$/gm.test(content);

    // If it uses require, it should not mix with ES6 imports
    if (hasRequire && hasES6Imports) {
      assertEquals(
        false,
        true,
        `${filename} mixes CommonJS require() with ES6 imports, which causes module system conflicts.\n` +
          `Either use only require() statements or convert to pure ES6 modules.\n` +
          `This mixing pattern was the root cause of the installer failure.`,
      );
    }
  }
});

Deno.test("main.js follows expected CommonJS pattern", () => {
  const mainJsPath = join(INSTALLER_DIR, "main.js");

  if (!existsSync(mainJsPath)) {
    return; // Skip if file doesn't exist
  }

  const content = Deno.readTextFileSync(mainJsPath);

  // main.js should start with Electron imports using require
  assertStringIncludes(
    content,
    'const { app, BrowserWindow, ipcMain, dialog } = require("electron");',
    "main.js should use require() for Electron imports (CommonJS pattern)",
  );

  // Should not contain any node: imports
  assertEquals(
    /import.*from\s+['"]node:/.test(content),
    false,
    "main.js should not contain any node: imports (use CommonJS require instead)",
  );
});

Deno.test("optimize-electron.js follows expected CommonJS pattern", () => {
  const filePath = join(INSTALLER_DIR, "optimize-electron.js");

  if (!existsSync(filePath)) {
    return; // Skip if file doesn't exist
  }

  const content = Deno.readTextFileSync(filePath);

  // Should use require for core Node.js modules
  assertStringIncludes(
    content,
    'const fs = require("fs");',
    "optimize-electron.js should use require() for fs module",
  );

  assertStringIncludes(
    content,
    'const path = require("path");',
    "optimize-electron.js should use require() for path module",
  );

  // Should not contain any node: imports
  assertEquals(
    /import.*from\s+['"]node:/.test(content),
    false,
    "optimize-electron.js should not contain any node: imports",
  );
});

Deno.test("installer binary path resolution works correctly", () => {
  const mainJsPath = join(INSTALLER_DIR, "main.js");

  if (!existsSync(mainJsPath)) {
    return; // Skip if file doesn't exist
  }

  const content = Deno.readTextFileSync(mainJsPath);

  // Verify the fixed binary path resolution logic exists
  assertStringIncludes(
    content,
    "const resourcesPath = process.resourcesPath || path.dirname(path.dirname(__dirname));",
    "Binary path resolution should handle both packaged and dev environments",
  );

  assertStringIncludes(
    content,
    'path.join(\n      resourcesPath,\n      "app.asar.unpacked",\n      "atlas-binary",\n      binaryName,\n    );',
    "Should correctly construct path to binary in packaged app",
  );

  assertStringIncludes(
    content,
    'binarySource = path.join(__dirname, "atlas-binary", binaryName);',
    "Should have fallback to development binary location",
  );
});

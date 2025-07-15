/**
 * Unit tests for filesystem tools
 * Tests the core logic without MCP protocol overhead
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import * as path from "@std/path";
import { expandGlob } from "@std/fs";
import { createSuccessResponse } from "../../src/tools/types.ts";
import { IGNORE_PATTERNS } from "../../src/tools/fs/ls.ts";

// Extract the core logic from the ls tool for testing
async function lsToolLogic(params: { path?: string; ignore?: string[] }) {
  const searchPath = path.resolve(Deno.cwd(), params.path || ".");
  const files = [];
  const LIMIT = 100;

  // Directory scanning with glob pattern
  for await (
    const entry of expandGlob("**/*", {
      root: searchPath,
      includeDirs: true,
      globstar: true,
    })
  ) {
    // Get relative path from search path
    const file = path.relative(searchPath, entry.path);

    if (IGNORE_PATTERNS.some((p) => file.includes(p) || file.startsWith(p.replace("/", "")))) {
      continue;
    }

    // Check against ignore patterns using globToRegExp
    if (
      params.ignore?.some((pattern) => {
        const regexp = path.globToRegExp(pattern);
        return regexp.test(file);
      })
    ) continue;

    files.push(file);
    if (files.length >= LIMIT) break;
  }

  // Build directory structure
  const dirs = new Set<string>();
  const filesByDir = new Map<string, string[]>();

  for (const file of files) {
    const dir = path.dirname(file);
    const parts = dir === "." ? [] : dir.split("/");

    // Add all parent directories
    for (let i = 0; i <= parts.length; i++) {
      const dirPath = i === 0 ? "." : parts.slice(0, i).join("/");
      dirs.add(dirPath);
    }

    // Add file to its directory
    if (!filesByDir.has(dir)) filesByDir.set(dir, []);
    filesByDir.get(dir)!.push(path.basename(file));
  }

  function renderDir(dirPath: string, depth: number): string {
    const indent = "  ".repeat(depth);
    let output = "";

    if (depth > 0) {
      output += `${indent}${path.basename(dirPath)}/\n`;
    }

    const childIndent = "  ".repeat(depth + 1);
    const children = Array.from(dirs)
      .filter((d) => path.dirname(d) === dirPath && d !== dirPath)
      .sort();

    // Render subdirectories first
    for (const child of children) {
      output += renderDir(child, depth + 1);
    }

    // Render files
    const files = filesByDir.get(dirPath) || [];
    for (const file of files.sort()) {
      output += `${childIndent}${file}\n`;
    }

    return output;
  }

  const output = `${searchPath}/\n` + renderDir(".", 0);

  return createSuccessResponse({
    title: path.relative(Deno.cwd(), searchPath),
    metadata: {
      count: files.length,
      truncated: files.length >= LIMIT,
    },
    output,
  });
}

Deno.test("ls tool - lists current directory", async () => {
  const result = await lsToolLogic({});

  // Check response structure
  assertExists(result.content);
  assertEquals(Array.isArray(result.content), true);
  assertEquals(result.content.length, 1);
  assertEquals(result.content[0].type, "text");

  // Parse the response
  const response = JSON.parse(result.content[0].text);
  assertExists(response.title);
  assertExists(response.metadata);
  assertExists(response.output);

  // Check metadata
  assertEquals(typeof response.metadata.count, "number");
  assertEquals(typeof response.metadata.truncated, "boolean");

  // Check output contains current directory
  assert(response.output.includes("/"));
  assert(response.metadata.count >= 0);
});

Deno.test("ls tool - lists specific directory", async () => {
  // Create a test directory
  const testDir = await Deno.makeTempDir({ prefix: "atlas_ls_test_" });

  try {
    // Create test files
    await Deno.writeTextFile(`${testDir}/file1.txt`, "test content");
    await Deno.writeTextFile(`${testDir}/file2.js`, "console.log('test')");
    await Deno.mkdir(`${testDir}/subdir`);
    await Deno.writeTextFile(`${testDir}/subdir/nested.txt`, "nested content");

    const result = await lsToolLogic({ path: testDir });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check that files are listed
    assert(response.output.includes("file1.txt"));
    assert(response.output.includes("file2.js"));
    assert(response.output.includes("subdir/"));
    assert(response.output.includes("nested.txt"));

    // Check metadata
    assert(response.metadata.count >= 3); // At least 3 files/dirs
  } finally {
    // Clean up
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("ls tool - respects ignore patterns", async () => {
  // Create a test directory
  const testDir = await Deno.makeTempDir({ prefix: "atlas_ls_ignore_test_" });

  try {
    // Create test files
    await Deno.writeTextFile(`${testDir}/keep.txt`, "keep this");
    await Deno.writeTextFile(`${testDir}/ignore.log`, "ignore this");
    await Deno.writeTextFile(`${testDir}/also_ignore.tmp`, "ignore this too");

    const result = await lsToolLogic({
      path: testDir,
      ignore: ["*.log", "*.tmp"],
    });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check that only non-ignored files are listed
    assert(response.output.includes("keep.txt"));
    assert(!response.output.includes("ignore.log"));
    assert(!response.output.includes("also_ignore.tmp"));
  } finally {
    // Clean up
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("ls tool - ignores default patterns", async () => {
  // Create a test directory
  const testDir = await Deno.makeTempDir({ prefix: "atlas_ls_default_ignore_test_" });

  try {
    // Create test files including ignored ones
    await Deno.writeTextFile(`${testDir}/keep.txt`, "keep this");
    await Deno.mkdir(`${testDir}/node_modules`);
    await Deno.writeTextFile(`${testDir}/node_modules/package.json`, "ignored");

    const result = await lsToolLogic({ path: testDir });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check that default ignored patterns are not included
    assert(response.output.includes("keep.txt"));
    assert(!response.output.includes("node_modules"));
    assert(!response.output.includes("package.json"));
  } finally {
    // Clean up
    await Deno.remove(testDir, { recursive: true });
  }
});

// Extract the core logic from the glob tool for testing
async function globToolLogic(params: { pattern: string; path?: string }) {
  let searchPath = params.path ?? Deno.cwd();
  searchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(Deno.cwd(), searchPath);

  const limit = 100;
  const files = [];
  let truncated = false;

  // Use expandGlob from @std/fs
  for await (
    const walkEntry of expandGlob(params.pattern, {
      root: searchPath,
      includeDirs: false, // Only files, not directories
      globstar: true,
    })
  ) {
    if (files.length >= limit) {
      truncated = true;
      break;
    }

    let mtime = 0;
    try {
      const stats = await Deno.stat(walkEntry.path);
      mtime = stats.mtime?.getTime() ?? 0;
    } catch {
      mtime = 0;
    }

    files.push({
      path: walkEntry.path,
      mtime: mtime,
    });
  }

  // Sort by modification time, newest first
  files.sort((a, b) => b.mtime - a.mtime);

  const output = [];
  if (files.length === 0) {
    output.push("No files found");
  } else {
    output.push(...files.map((f) => f.path));
    if (truncated) {
      output.push("");
      output.push("(Results are truncated. Consider using a more specific path or pattern.)");
    }
  }

  return createSuccessResponse({
    title: path.relative(Deno.cwd(), searchPath),
    metadata: {
      count: files.length,
      truncated,
    },
    output: output.join("\n"),
  });
}

Deno.test("glob tool - finds files by pattern", async () => {
  // Create a test directory
  const testDir = await Deno.makeTempDir({ prefix: "atlas_glob_test_" });

  try {
    // Create test files
    await Deno.writeTextFile(`${testDir}/file1.js`, "console.log('test1')");
    await Deno.writeTextFile(`${testDir}/file2.ts`, "const x: string = 'test'");
    await Deno.writeTextFile(`${testDir}/file3.txt`, "plain text");
    await Deno.mkdir(`${testDir}/subdir`);
    await Deno.writeTextFile(`${testDir}/subdir/nested.js`, "// nested js");

    const result = await globToolLogic({ pattern: "**/*.js", path: testDir });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check that JS files are found
    assert(response.output.includes("file1.js"));
    assert(response.output.includes("nested.js"));
    assert(!response.output.includes("file2.ts"));
    assert(!response.output.includes("file3.txt"));

    // Check metadata
    assertEquals(response.metadata.count, 2);
    assertEquals(response.metadata.truncated, false);
  } finally {
    // Clean up
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("glob tool - handles no matches", async () => {
  // Create a test directory
  const testDir = await Deno.makeTempDir({ prefix: "atlas_glob_empty_test_" });

  try {
    // Create non-matching files
    await Deno.writeTextFile(`${testDir}/file1.txt`, "text content");
    await Deno.writeTextFile(`${testDir}/file2.md`, "markdown content");

    const result = await globToolLogic({ pattern: "**/*.js", path: testDir });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check that no files are found
    assertEquals(response.output, "No files found");
    assertEquals(response.metadata.count, 0);
    assertEquals(response.metadata.truncated, false);
  } finally {
    // Clean up
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("glob tool - sorts by modification time", async () => {
  // Create a test directory
  const testDir = await Deno.makeTempDir({ prefix: "atlas_glob_sort_test_" });

  try {
    // Create test files with delays to ensure different mtimes
    await Deno.writeTextFile(`${testDir}/old.js`, "// old file");
    await new Promise((resolve) => setTimeout(resolve, 10)); // Small delay
    await Deno.writeTextFile(`${testDir}/new.js`, "// new file");

    const result = await globToolLogic({ pattern: "**/*.js", path: testDir });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check that files are sorted by modification time (newest first)
    const lines = response.output.split("\n");
    const newFileIndex = lines.findIndex((line) => line.includes("new.js"));
    const oldFileIndex = lines.findIndex((line) => line.includes("old.js"));

    assert(newFileIndex < oldFileIndex, "New file should appear before old file");
  } finally {
    // Clean up
    await Deno.remove(testDir, { recursive: true });
  }
});

// TODO: Extract core logic from src/tools/fs/read.ts
// async function readToolLogic(params: { path: string; limit?: number; offset?: number }) {
//   // Extract the actual logic from the registerReadTool function
//   // This should:
//   // 1. Resolve the file path
//   // 2. Read file content with optional limit and offset
//   // 3. Handle binary files appropriately
//   // 4. Return createSuccessResponse with file content
// }

// TODO: Extract core logic from src/tools/fs/write.ts
// async function writeToolLogic(params: { path: string; content: string; mode?: string }) {
//   // Extract the actual logic from the registerWriteTool function
//   // This should:
//   // 1. Resolve the file path
//   // 2. Write content to file with specified mode (create, append, overwrite)
//   // 3. Handle directory creation if needed
//   // 4. Return createSuccessResponse with write confirmation
// }

// TODO: Extract core logic from src/tools/fs/grep.ts
// async function grepToolLogic(params: {
//   pattern: string;
//   path?: string;
//   ignoreCase?: boolean;
//   context?: number;
//   limit?: number;
// }) {
//   // Extract the actual logic from the registerGrepTool function
//   // This should:
//   // 1. Compile regex pattern with appropriate flags
//   // 2. Search through files in specified path
//   // 3. Return matching lines with context
//   // 4. Handle limit and pagination
// }

// TODO: Test Cases for Read Tool:
// Deno.test("read tool - reads file successfully", async () => {
//   // Create test file with content
//   // Test that file content is returned correctly
//   // Verify file metadata is included
// });

// Deno.test("read tool - handles file not found", async () => {
//   // Test reading non-existent file
//   // Verify appropriate error is thrown
// });

// Deno.test("read tool - handles binary files", async () => {
//   // Create binary test file
//   // Test that binary files are handled appropriately
// });

// Deno.test("read tool - handles large files with limit", async () => {
//   // Create large test file
//   // Test reading with limit parameter
//   // Verify only specified number of lines are returned
// });

// Deno.test("read tool - handles offset parameter", async () => {
//   // Create test file with multiple lines
//   // Test reading with offset parameter
//   // Verify correct lines are returned
// });

// TODO: Test Cases for Write Tool:
// Deno.test("write tool - writes file successfully", async () => {
//   // Test writing content to new file
//   // Verify file is created with correct content
// });

// Deno.test("write tool - handles directory creation", async () => {
//   // Test writing to file in non-existent directory
//   // Verify directory is created automatically
// });

// Deno.test("write tool - handles append mode", async () => {
//   // Create file with initial content
//   // Test appending content to existing file
//   // Verify content is appended correctly
// });

// Deno.test("write tool - handles overwrite mode", async () => {
//   // Create file with initial content
//   // Test overwriting existing file
//   // Verify content is replaced correctly
// });

// Deno.test("write tool - handles permission errors", async () => {
//   // Test writing to read-only location
//   // Verify appropriate error is thrown
// });

// TODO: Test Cases for Grep Tool:
// Deno.test("grep tool - searches files successfully", async () => {
//   // Create test files with searchable content
//   // Test that matching lines are found
//   // Verify line numbers and context are included
// });

// Deno.test("grep tool - handles case insensitive search", async () => {
//   // Create test files with mixed case content
//   // Test case insensitive search
//   // Verify matches are found regardless of case
// });

// Deno.test("grep tool - handles context lines", async () => {
//   // Create test files with multiple lines
//   // Test searching with context parameter
//   // Verify context lines are included in results
// });

// Deno.test("grep tool - handles no matches", async () => {
//   // Create test files without matching content
//   // Test that no matches are handled correctly
// });

// Deno.test("grep tool - handles regex patterns", async () => {
//   // Create test files with content matching regex
//   // Test that regex patterns work correctly
//   // Verify complex patterns are handled
// });

// Deno.test("grep tool - handles limit parameter", async () => {
//   // Create test files with many matches
//   // Test searching with limit parameter
//   // Verify only specified number of matches are returned
// });

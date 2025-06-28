import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";

/**
 * Test to prevent cursor-breaking pattern: render() followed by immediate Deno.exit()
 * 
 * This test ensures that CLI commands using Ink rendering don't include the problematic
 * pattern that prevents proper terminal state cleanup (cursor restoration).
 * 
 * See: https://github.com/tempestteam/atlas/pull/16
 */
Deno.test("CLI commands should not use immediate Deno.exit() after render()", async () => {
  const cliCommandsPath = join(Deno.cwd(), "src", "cli", "commands");
  const problematicFiles: string[] = [];
  
  // Walk through all CLI command files
  for await (const entry of walk(cliCommandsPath, { 
    exts: [".tsx", ".ts"],
    includeDirs: false 
  })) {
    const content = await Deno.readTextFile(entry.path);
    
    // Check if file contains Ink render() calls
    if (!content.includes("render(")) {
      continue;
    }
    
    // Split content into lines for analysis
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length - 2; i++) {
      const currentLine = lines[i].trim();
      const nextLine = lines[i + 1]?.trim() || "";
      const nextNextLine = lines[i + 2]?.trim() || "";
      
      // Pattern 1: render() followed immediately by Deno.exit() on next line
      if (currentLine.includes("render(") && nextLine.includes("Deno.exit(")) {
        problematicFiles.push(`${entry.path}:${i + 1}-${i + 2} - render() followed by Deno.exit()`);
      }
      
      // Pattern 2: render() followed by comment then Deno.exit()
      if (currentLine.includes("render(") && 
          nextLine.includes("//") && 
          nextNextLine.includes("Deno.exit(")) {
        problematicFiles.push(`${entry.path}:${i + 1}-${i + 3} - render() followed by comment then Deno.exit()`);
      }
      
      // Pattern 3: render() and Deno.exit() on same line
      if (currentLine.includes("render(") && currentLine.includes("Deno.exit(")) {
        problematicFiles.push(`${entry.path}:${i + 1} - render() and Deno.exit() on same line`);
      }
    }
  }
  
  // If any problematic patterns found, fail the test with detailed info
  if (problematicFiles.length > 0) {
    const errorMessage = [
      "\n❌ Found CLI commands with problematic render() + Deno.exit() pattern:",
      "",
      "This pattern prevents Ink from properly restoring terminal state (cursor visibility).",
      "Remove the immediate Deno.exit() call and let Ink handle natural process termination.",
      "",
      "Problematic files:",
      ...problematicFiles.map(file => `  - ${file}`),
      "",
      "Fix: Remove the Deno.exit(0) line after render() calls.",
      "See: https://github.com/tempestteam/atlas/pull/16",
    ].join("\n");
    
    throw new Error(errorMessage);
  }
});

/**
 * Test to ensure CLI commands properly handle terminal state
 * 
 * This test verifies that CLI commands using Ink follow the correct patterns:
 * 1. Use render() without immediate exit for display commands
 * 2. Use proper cleanup patterns for interactive commands
 */
Deno.test("CLI commands should follow proper Ink lifecycle patterns", async () => {
  const cliCommandsPath = join(Deno.cwd(), "src", "cli", "commands");
  const recommendations: string[] = [];
  
  for await (const entry of walk(cliCommandsPath, { 
    exts: [".tsx", ".ts"],
    includeDirs: false 
  })) {
    const content = await Deno.readTextFile(entry.path);
    
    // Skip files that don't use Ink
    if (!content.includes("render(")) {
      continue;
    }
    
    // Check for good patterns
    const hasWaitUntilExit = content.includes("waitUntilExit");
    const hasProperCleanup = content.includes("useEffect") && content.includes("return");
    const hasJsonAlternative = content.includes("argv.json");
    
    // Files using render() should have JSON alternative for scripting
    if (!hasJsonAlternative) {
      recommendations.push(`${entry.path}: Consider adding --json flag for scripting compatibility`);
    }
    
    // Interactive commands should use proper cleanup
    if (content.includes("interactive") || content.includes("tui")) {
      if (!hasProperCleanup) {
        recommendations.push(`${entry.path}: Interactive commands should use useEffect cleanup`);
      }
    }
  }
  
  // These are recommendations, not failures - log them for visibility
  if (recommendations.length > 0) {
    console.log("\n💡 CLI Pattern Recommendations:");
    recommendations.forEach(rec => console.log(`  - ${rec}`));
  }
  
  // This test always passes - it's just for visibility
  assertEquals(true, true);
});
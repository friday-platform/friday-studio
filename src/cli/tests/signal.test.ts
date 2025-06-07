import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/testing/asserts.ts";
import { runCLI, setupTestWorkspace, cleanupTestDir } from "./helpers.ts";

Deno.test("signal list shows configured signals", async () => {
  const tempDir = await setupTestWorkspace();
  
  try {
    const result = await runCLI(["signal", "list"], {
      cwd: tempDir
    });
    
    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "SIGNAL");
    assertStringIncludes(result.stdout, "test-signal");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("signal trigger requires signal name", async () => {
  const tempDir = await setupTestWorkspace();
  
  try {
    const result = await runCLI(["signal", "trigger"], {
      cwd: tempDir
    });
    
    // Ink CLI outputs to stdout and exits with 0
    assertStringIncludes(result.stdout, "Signal name required");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("signal trigger requires data", async () => {
  const tempDir = await setupTestWorkspace();
  
  try {
    const result = await runCLI(["signal", "trigger", "test-signal"], {
      cwd: tempDir
    });
    
    assertStringIncludes(result.stdout, "Data required");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("signal trigger validates JSON", async () => {
  const tempDir = await setupTestWorkspace();
  
  try {
    const result = await runCLI([
      "signal", "trigger", "test-signal",
      "--data", "invalid json"
    ], {
      cwd: tempDir
    });
    
    assertStringIncludes(result.stdout, "Invalid JSON");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("signal trigger handles server errors", async () => {
  const tempDir = await setupTestWorkspace();
  
  try {
    const result = await runCLI([
      "signal", "trigger", "test-signal",
      "--data", '{"test": true}'
    ], {
      cwd: tempDir
    });
    
    // Should show an error (either connection refused or 404)
    assertStringIncludes(result.stdout, "Error:");
  } finally {
    await cleanupTestDir(tempDir);
  }
});
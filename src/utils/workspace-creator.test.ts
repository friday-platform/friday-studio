import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createWorkspace } from "./workspace-creator.ts";

Deno.test("createWorkspace - creates workspace in current directory", async () => {
  const testPath = "./test-workspace-current";
  
  try {
    await createWorkspace({
      name: "Test Workspace Current",
      path: testPath,
    });

    // Check that workspace.yml was created
    const workspaceFile = `${testPath}/workspace.yml`;
    const content = await Deno.readTextFile(workspaceFile);
    
    // Verify content contains expected values
    assertExists(content.match(/name: "Test Workspace Current"/));
    assertExists(content.match(/description: "A new Atlas workspace"/));
    assertExists(content.match(/id: "[0-9a-f-]{36}"/)); // UUID format
    assertExists(content.match(/version: "1.0"/));
    
  } finally {
    // Cleanup
    try {
      await Deno.remove(testPath, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test("createWorkspace - creates workspace in nested directory", async () => {
  const testPath = "./test-workspaces/nested/deep/workspace";
  
  try {
    await createWorkspace({
      name: "Nested Test Workspace",
      path: testPath,
      description: "A test workspace in nested directories",
    });

    // Check that workspace.yml was created
    const workspaceFile = `${testPath}/workspace.yml`;
    const content = await Deno.readTextFile(workspaceFile);
    
    // Verify content contains expected values
    assertExists(content.match(/name: "Nested Test Workspace"/));
    assertExists(content.match(/description: "A test workspace in nested directories"/));
    assertExists(content.match(/id: "[0-9a-f-]{36}"/)); // UUID format
    
  } finally {
    // Cleanup
    try {
      await Deno.remove("./test-workspaces", { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test("createWorkspace - creates workspace with absolute path", async () => {
  const testPath = `${Deno.cwd()}/test-workspace-absolute`;
  
  try {
    await createWorkspace({
      name: "Absolute Path Workspace",
      path: testPath,
    });

    // Check that workspace.yml was created
    const workspaceFile = `${testPath}/workspace.yml`;
    const content = await Deno.readTextFile(workspaceFile);
    
    // Verify content contains expected values
    assertExists(content.match(/name: "Absolute Path Workspace"/));
    assertExists(content.match(/example-signal/)); // Check template content exists
    assertExists(content.match(/example-job/));
    assertExists(content.match(/example-agent/));
    
  } finally {
    // Cleanup
    try {
      await Deno.remove(testPath, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test("createWorkspace - handles special characters in name", async () => {
  const testPath = "./test-workspace-special";
  
  try {
    await createWorkspace({
      name: "My Workspace & Co. (v2.0)",
      path: testPath,
    });

    // Check that workspace.yml was created
    const workspaceFile = `${testPath}/workspace.yml`;
    const content = await Deno.readTextFile(workspaceFile);
    
    // Verify special characters are preserved in YAML
    assertExists(content.match(/name: "My Workspace & Co\. \(v2\.0\)"/));
    
  } finally {
    // Cleanup
    try {
      await Deno.remove(testPath, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});
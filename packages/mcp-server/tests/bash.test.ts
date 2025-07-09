import { assertEquals, assertStringIncludes } from "@std/assert";
import { createMCPClient } from "./fixtures/mcp-client.ts";

Deno.test("Bash Tool - basic command execution", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Test simple echo command
    const result = await client.callTool({
      name: "atlas_bash",
      arguments: {
        command: "echo 'Hello, World!'",
        description: "Print hello world message",
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Verify command execution
    assertEquals(responseData.title, "echo 'Hello, World!'");
    assertEquals(responseData.metadata.exitCode, 0);
    assertEquals(responseData.metadata.description, "Print hello world message");
    assertStringIncludes(responseData.output, "<stdout>");
    assertStringIncludes(responseData.output, "Hello, World!");
    assertStringIncludes(responseData.output, "</stdout>");
  } finally {
    await transport.close();
  }
});

Deno.test("Bash Tool - pwd command", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Test pwd command
    const result = await client.callTool({
      name: "atlas_bash",
      arguments: {
        command: "pwd",
        description: "Shows current working directory",
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Verify command execution
    assertEquals(responseData.title, "pwd");
    assertEquals(responseData.metadata.exitCode, 0);
    assertEquals(responseData.metadata.description, "Shows current working directory");
    assertStringIncludes(responseData.output, "<stdout>");
    assertStringIncludes(responseData.output, "</stdout>");
    // Should contain a valid path
    assertStringIncludes(responseData.metadata.stdout, "/");
  } finally {
    await transport.close();
  }
});

Deno.test("Bash Tool - command with stderr", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Test command that writes to stderr
    const result = await client.callTool({
      name: "atlas_bash",
      arguments: {
        command: "echo 'error message' >&2",
        description: "Write to stderr",
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Verify command execution
    assertEquals(responseData.title, "echo 'error message' >&2");
    assertEquals(responseData.metadata.exitCode, 0);
    assertStringIncludes(responseData.output, "<stderr>");
    assertStringIncludes(responseData.output, "error message");
    assertStringIncludes(responseData.output, "</stderr>");
  } finally {
    await transport.close();
  }
});

Deno.test("Bash Tool - non-zero exit code", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Test command that exits with non-zero code
    const result = await client.callTool({
      name: "atlas_bash",
      arguments: {
        command: "exit 1",
        description: "Exit with code 1",
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Verify command execution
    assertEquals(responseData.title, "exit 1");
    assertEquals(responseData.metadata.exitCode, 1);
    assertEquals(responseData.metadata.description, "Exit with code 1");
  } finally {
    await transport.close();
  }
});

Deno.test("Bash Tool - file operations", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Create a temporary directory for testing
    const testDir = await Deno.makeTempDir({ prefix: "atlas_bash_test_" });

    try {
      // Test creating a file
      const createResult = await client.callTool({
        name: "atlas_bash",
        arguments: {
          command: `echo 'test content' > ${testDir}/test.txt`,
          description: "Create test file",
        },
      });

      const createContent = createResult.content as Array<{ type: string; text: string }>;
      const createTextContent = createContent.find((item) => item.type === "text");
      const createResponseData = JSON.parse(createTextContent!.text);

      assertEquals(createResponseData.metadata.exitCode, 0);

      // Test reading the file
      const readResult = await client.callTool({
        name: "atlas_bash",
        arguments: {
          command: `cat ${testDir}/test.txt`,
          description: "Read test file",
        },
      });

      const readContent = readResult.content as Array<{ type: string; text: string }>;
      const readTextContent = readContent.find((item) => item.type === "text");
      const readResponseData = JSON.parse(readTextContent!.text);

      assertEquals(readResponseData.metadata.exitCode, 0);
      assertStringIncludes(readResponseData.metadata.stdout, "test content");

      // Test listing files
      const listResult = await client.callTool({
        name: "atlas_bash",
        arguments: {
          command: `ls -la ${testDir}`,
          description: "List directory contents",
        },
      });

      const listContent = listResult.content as Array<{ type: string; text: string }>;
      const listTextContent = listContent.find((item) => item.type === "text");
      const listResponseData = JSON.parse(listTextContent!.text);

      assertEquals(listResponseData.metadata.exitCode, 0);
      assertStringIncludes(listResponseData.metadata.stdout, "test.txt");
    } finally {
      await Deno.remove(testDir, { recursive: true });
    }
  } finally {
    await transport.close();
  }
});

Deno.test("Bash Tool - command with spaces in paths", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Create a temporary directory with spaces
    const testDir = await Deno.makeTempDir({ prefix: "atlas_bash_test_with spaces_" });

    try {
      // Test creating a file with spaces in path
      const result = await client.callTool({
        name: "atlas_bash",
        arguments: {
          command: `echo 'content' > "${testDir}/file with spaces.txt"`,
          description: "Create file with spaces in name",
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const responseData = JSON.parse(textContent!.text);

      assertEquals(responseData.metadata.exitCode, 0);

      // Verify file was created
      const fileExists = await Deno.stat(`${testDir}/file with spaces.txt`).then(() => true).catch(
        () => false,
      );
      assertEquals(fileExists, true);
    } finally {
      await Deno.remove(testDir, { recursive: true });
    }
  } finally {
    await transport.close();
  }
});

Deno.test("Bash Tool - multiple commands", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Test multiple commands joined with &&
    const result = await client.callTool({
      name: "atlas_bash",
      arguments: {
        command: "echo 'first' && echo 'second' && echo 'third'",
        description: "Execute multiple commands",
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    assertEquals(responseData.metadata.exitCode, 0);
    assertStringIncludes(responseData.metadata.stdout, "first");
    assertStringIncludes(responseData.metadata.stdout, "second");
    assertStringIncludes(responseData.metadata.stdout, "third");
  } finally {
    await transport.close();
  }
});

Deno.test("Bash Tool - timeout handling", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Test command with very short timeout
    const start = Date.now();

    try {
      await client.callTool({
        name: "atlas_bash",
        arguments: {
          command: "sleep 5",
          description: "Sleep for 5 seconds",
          timeout: 1000, // 1 second timeout
        },
      });

      // Should not reach here
      assertEquals(false, true, "Command should have timed out");
    } catch (error) {
      const elapsed = Date.now() - start;

      // Should timeout within reasonable time (allow some buffer)
      assertEquals(elapsed < 3000, true, `Command should timeout quickly, took ${elapsed}ms`);
      assertStringIncludes(error.message, "timeout");
    }
  } finally {
    await transport.close();
  }
});

Deno.test("Bash Tool - output truncation", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Test command that produces large output
    const result = await client.callTool({
      name: "atlas_bash",
      arguments: {
        command: "yes 'This is a test line that will be repeated many times' | head -n 2000",
        description: "Generate large output",
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    assertEquals(responseData.metadata.exitCode, 0);

    // Check if output was truncated
    if (responseData.metadata.truncated) {
      assertEquals(responseData.metadata.truncated, true);
      assertStringIncludes(responseData.output, "output truncated due to length");
    }

    // Output should not exceed the limit significantly
    assertEquals(responseData.output.length <= 32000, true, "Output should be truncated");
  } finally {
    await transport.close();
  }
});

Deno.test("Bash Tool - invalid command", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Test command that doesn't exist
    const result = await client.callTool({
      name: "atlas_bash",
      arguments: {
        command: "nonexistentcommand12345",
        description: "Run invalid command",
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Should have non-zero exit code
    assertEquals(responseData.metadata.exitCode !== 0, true);
    // Should have error output
    assertStringIncludes(responseData.output, "<stderr>");
  } finally {
    await transport.close();
  }
});

Deno.test("Bash Tool - environment variables", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Test accessing environment variables
    const result = await client.callTool({
      name: "atlas_bash",
      arguments: {
        command: "echo $HOME",
        description: "Print HOME environment variable",
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    assertEquals(responseData.metadata.exitCode, 0);
    // Should contain some path (HOME should be set)
    assertStringIncludes(responseData.metadata.stdout, "/");
  } finally {
    await transport.close();
  }
});

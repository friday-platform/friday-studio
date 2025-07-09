import { assertEquals } from "@std/assert";
import { createMCPClient } from "./fixtures/mcp-client.ts";

Deno.test("Filesystem Tools - glob", async () => {
  // Create a temporary test directory
  const testDir = await Deno.makeTempDir({ prefix: "atlas_glob_test_" });

  try {
    // Create test files with different extensions
    await Deno.writeTextFile(`${testDir}/file1.js`, "console.log('test')");
    await Deno.writeTextFile(`${testDir}/file2.ts`, "const x: string = 'test'");
    await Deno.writeTextFile(`${testDir}/file3.txt`, "plain text");
    await Deno.mkdir(`${testDir}/subdir`);
    await Deno.writeTextFile(`${testDir}/subdir/nested.js`, "// nested js");
    await Deno.writeTextFile(`${testDir}/subdir/nested.py`, "# python file");

    const { client, transport } = await createMCPClient();

    try {
      // Test glob pattern for JavaScript files
      const result = await client.callTool({
        name: "atlas:glob",
        arguments: {
          pattern: "**/*.js",
          path: testDir,
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const output = JSON.parse(textContent!.text).output;

      // Should find JavaScript files
      assertEquals(output.includes("file1.js"), true);
      assertEquals(output.includes("nested.js"), true);
      // Should not find other file types
      assertEquals(output.includes("file2.ts"), false);
      assertEquals(output.includes("file3.txt"), false);
    } finally {
      await transport.close();
    }
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("Filesystem Tools - grep", async () => {
  // Create a temporary test directory
  const testDir = await Deno.makeTempDir({ prefix: "atlas_grep_test_" });

  try {
    // Create test files with different content
    await Deno.writeTextFile(`${testDir}/file1.js`, "console.log('hello world');");
    await Deno.writeTextFile(`${testDir}/file2.ts`, "const message = 'hello universe';");
    await Deno.writeTextFile(`${testDir}/file3.txt`, "goodbye world");
    await Deno.mkdir(`${testDir}/subdir`);
    await Deno.writeTextFile(`${testDir}/subdir/nested.js`, "// hello from nested");

    const { client, transport } = await createMCPClient();

    try {
      // Test grep for "hello" pattern
      const result = await client.callTool({
        name: "atlas:grep",
        arguments: {
          pattern: "hello",
          path: testDir,
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const output = JSON.parse(textContent!.text).output;

      // Should find files containing "hello"
      assertEquals(output.includes("file1.js"), true);
      assertEquals(output.includes("file2.ts"), true);
      assertEquals(output.includes("nested.js"), true);
      // Should not find files without "hello"
      assertEquals(output.includes("file3.txt"), false);

      // Test with file pattern filter
      const filteredResult = await client.callTool({
        name: "atlas:grep",
        arguments: {
          pattern: "hello",
          path: testDir,
          include: "*.js",
        },
      });

      const filteredContent = filteredResult.content as Array<{ type: string; text: string }>;
      const filteredTextContent = filteredContent.find((item) => item.type === "text");
      const filteredOutput = JSON.parse(filteredTextContent!.text).output;

      // Should only find JavaScript files
      assertEquals(filteredOutput.includes("file1.js"), true);
      assertEquals(filteredOutput.includes("nested.js"), true);
      assertEquals(filteredOutput.includes("file2.ts"), false);
    } finally {
      await transport.close();
    }
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("Filesystem Tools - ls", async () => {
  // Create a temporary test directory
  const testDir = await Deno.makeTempDir({ prefix: "atlas_ls_test_" });

  try {
    // Create some test files and directories
    await Deno.writeTextFile(`${testDir}/file1.txt`, "test content");
    await Deno.writeTextFile(`${testDir}/file2.js`, "console.log('test')");
    await Deno.mkdir(`${testDir}/subdir`);
    await Deno.writeTextFile(`${testDir}/subdir/nested.md`, "# Test");

    const { client, transport } = await createMCPClient();

    try {
      // Call the atlas:list tool
      const result = await client.callTool({
        name: "atlas:list",
        arguments: {
          path: testDir,
          ignore: [],
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const output = JSON.parse(textContent!.text).output;

      // Verify the output contains our test directory and files
      assertEquals(output.includes(testDir), true);
      assertEquals(output.includes("file1.txt"), true);
      assertEquals(output.includes("file2.js"), true);
      assertEquals(output.includes("subdir"), true);
      assertEquals(output.includes("nested.md"), true);

      // Test with ignore patterns
      const ignoredResult = await client.callTool({
        name: "atlas:list",
        arguments: {
          path: testDir,
          ignore: ["*.js"],
        },
      });

      const ignoredContent = ignoredResult.content as Array<{ type: string; text: string }>;
      const ignoredTextContent = ignoredContent.find((item) => item.type === "text");
      const ignoredOutput = JSON.parse(ignoredTextContent!.text).output;

      // Should ignore JavaScript files
      assertEquals(ignoredOutput.includes("file2.js"), false);
      assertEquals(ignoredOutput.includes("file1.txt"), true);
    } finally {
      await transport.close();
    }
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("Filesystem Tools - read", async () => {
  // Create a temporary test file
  const testFile = await Deno.makeTempFile({ prefix: "atlas_read_test_", suffix: ".txt" });

  try {
    // Write test content
    const testContent = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    await Deno.writeTextFile(testFile, testContent);

    const { client, transport } = await createMCPClient();

    try {
      // Test reading the entire file
      const result = await client.callTool({
        name: "atlas:read",
        arguments: {
          filePath: testFile,
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const output = JSON.parse(textContent!.text).output;

      // Should contain all lines with line numbers (format: 00001| Line 1)
      assertEquals(output.includes("00001| Line 1"), true);
      assertEquals(output.includes("00002| Line 2"), true);
      assertEquals(output.includes("00003| Line 3"), true);
      assertEquals(output.includes("00004| Line 4"), true);
      assertEquals(output.includes("00005| Line 5"), true);

      // Test reading with limit
      const limitedResult = await client.callTool({
        name: "atlas:read",
        arguments: {
          filePath: testFile,
          limit: 2,
        },
      });

      const limitedContent = limitedResult.content as Array<{ type: string; text: string }>;
      const limitedTextContent = limitedContent.find((item) => item.type === "text");
      const limitedOutput = JSON.parse(limitedTextContent!.text).output;

      // Should only contain first 2 lines
      assertEquals(limitedOutput.includes("00001| Line 1"), true);
      assertEquals(limitedOutput.includes("00002| Line 2"), true);
      assertEquals(limitedOutput.includes("00003| Line 3"), false);
    } finally {
      await transport.close();
    }
  } finally {
    await Deno.remove(testFile);
  }
});

Deno.test("Filesystem Tools - write", async () => {
  // Create a temporary directory for the test
  const testDir = await Deno.makeTempDir({ prefix: "atlas_write_test_" });
  const testFile = `${testDir}/test_file.txt`;

  try {
    const { client, transport } = await createMCPClient();

    try {
      // Test writing a new file
      const result = await client.callTool({
        name: "atlas:write",
        arguments: {
          filePath: testFile,
          content: "Hello, World!\nThis is a test file.",
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const responseData = JSON.parse(textContent!.text);

      // Verify the file was created (check metadata)
      assertEquals(responseData.metadata.action, "created");
      assertEquals(responseData.metadata.size_bytes > 0, true);

      // Verify file content
      const fileContent = await Deno.readTextFile(testFile);
      assertEquals(fileContent, "Hello, World!\nThis is a test file.");

      // Test overwriting the file
      const overwriteResult = await client.callTool({
        name: "atlas:write",
        arguments: {
          filePath: testFile,
          content: "Updated content",
        },
      });

      const overwriteContent = overwriteResult.content as Array<{ type: string; text: string }>;
      const overwriteTextContent = overwriteContent.find((item) => item.type === "text");
      const overwriteData = JSON.parse(overwriteTextContent!.text);

      // Verify the file was overwritten (action should be "overwritten")
      assertEquals(overwriteData.metadata.action, "overwritten");

      // Verify updated content
      const updatedContent = await Deno.readTextFile(testFile);
      assertEquals(updatedContent, "Updated content");
    } finally {
      await transport.close();
    }
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});

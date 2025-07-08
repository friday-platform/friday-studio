# MCP Tool Testing Plan

This document outlines the approach for testing MCP (Model Context Protocol) tools in the Atlas
platform.

## Overview

MCP tools are tested by creating real MCP client connections to the running MCP server and making
actual tool calls. This approach validates the complete MCP protocol implementation rather than just
testing individual functions.

## Testing Architecture

### 1. MCP Client Fixture

**Location**: `packages/mcp-server/tests/fixtures/mcp-client.ts`

A reusable MCP client fixture that handles:

- Client creation with proper configuration
- Transport setup using `StreamableHTTPClientTransport`
- Connection to the MCP server endpoint
- Proper cleanup

```typescript
export async function createMCPClient() {
  const client = new Client({
    name: "atlas-test-client",
    version: "1.0.0",
  });

  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost:8080/mcp"),
  );

  await client.connect(transport);

  return { client, transport };
}
```

### 2. Test Structure

Each MCP tool test follows this pattern:

1. **Setup**: Create temporary test data/directories
2. **Connect**: Use the MCP client fixture to connect to the server
3. **Execute**: Call the tool using `client.callTool()`
4. **Validate**: Assert the response structure and content
5. **Cleanup**: Close transport and remove test data

## Example: Testing `atlas:list` Tool

```typescript
Deno.test("Filesystem Tools - ls", async () => {
  // 1. Setup - Create temporary test directory
  const testDir = await Deno.makeTempDir({ prefix: "atlas_ls_test_" });

  try {
    // Create test files and directories
    await Deno.writeTextFile(`${testDir}/file1.txt`, "test content");
    await Deno.writeTextFile(`${testDir}/file2.js`, "console.log('test')");
    await Deno.mkdir(`${testDir}/subdir`);
    await Deno.writeTextFile(`${testDir}/subdir/nested.md`, "# Test");

    // 2. Connect - Create MCP client
    const { client, transport } = await createMCPClient();

    try {
      // 3. Execute - Call the atlas:list tool
      const result = await client.callTool({
        name: "atlas:list",
        arguments: {
          path: testDir,
          ignore: [],
        },
      });

      // 4. Validate - Check response structure and content
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
    } finally {
      // 5. Cleanup - Close transport
      await transport.close();
    }
  } finally {
    // 5. Cleanup - Remove test directory
    await Deno.remove(testDir, { recursive: true });
  }
});
```

## MCP Protocol Details

### Request Format

Tools are called using the standard MCP protocol:

```json
{
  "method": "tools/call",
  "params": {
    "name": "atlas:list",
    "arguments": {
      "path": "/path/to/directory",
      "ignore": []
    }
  }
}
```

### Response Format

The MCP server returns responses in this structure:

```json
{
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"title\":\"\",\"metadata\":{\"count\":5},\"output\":\"...\"}"
      }
    ]
  }
}
```

## Testing Guidelines

### 1. Use Real Data

- Create temporary directories and files for filesystem operations
- Use realistic test data that mimics actual usage
- Clean up all test data after each test

### 2. Test Complete Workflows

- Test the full MCP protocol flow, not just individual functions
- Validate both request processing and response formatting
- Include edge cases and error conditions

### 3. Validate Response Structure

- Check that responses conform to MCP protocol standards
- Verify content types and data formats
- Parse JSON responses to validate internal structure

### 4. Reuse Common Setup

- Use the MCP client fixture for consistent client creation
- Share common test utilities across tool tests
- Centralize configuration (endpoints, timeouts, etc.)

## Test Organization

```
packages/mcp-server/tests/
├── fixtures/
│   ├── mcp-client.ts          # Reusable MCP client setup
│   └── library-responses.ts   # Test data fixtures
├── fs.test.ts                 # Filesystem tool tests
├── workspace.test.ts          # Workspace tool tests
├── session.test.ts            # Session tool tests
└── ...
```

## Prerequisites

Before running MCP tool tests:

1. **MCP Server Running**: The Atlas MCP server must be running on `http://localhost:8080/mcp`
2. **Proper Permissions**: Tests need `--allow-all` flag for filesystem operations
3. **Test Environment**: Clean environment without interfering processes

## Running Tests

```bash
# Run all MCP tool tests
deno test packages/mcp-server/tests/ --allow-all

# Run specific tool tests
deno test packages/mcp-server/tests/fs.test.ts --allow-all
```

## Benefits of This Approach

1. **Full Protocol Testing**: Validates complete MCP implementation
2. **Realistic Scenarios**: Tests with actual data and server responses
3. **Integration Validation**: Ensures tools work with real MCP clients
4. **Maintainability**: Centralized fixtures and consistent patterns
5. **Debugging**: Easy to reproduce issues with real tool calls

This testing approach ensures that MCP tools work correctly in production environments and maintain
compatibility with the MCP protocol specification.

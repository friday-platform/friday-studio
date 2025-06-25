import { assertEquals, assertExists } from "@std/assert";
import { expect } from "@std/expect";
import { delay, findAvailablePort, withTimeout } from "../utils/test-utils.ts";

/**
 * Integration test for the complete MCP platform serve command flow
 * Tests the actual CLI command with process spawning and JSON-RPC communication
 */

Deno.test("MCP Platform Serve Command - CLI Integration", async (t) => {
  let mcpProcess: Deno.ChildProcess | undefined;
  let processStdout: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let processStderr: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let processStdin: WritableStreamDefaultWriter<Uint8Array> | undefined;

  await t.step("setup", async () => {
    // Ensure clean environment
    const testEnvVars = new Map();
    testEnvVars.set("ATLAS_LOG_LEVEL", "error"); // Reduce noise in tests
    testEnvVars.set("ATLAS_TEST_MODE", "true");
  });

  await t.step("should start MCP server process", async () => {
    // Start the MCP server process
    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-all",
        "--unstable-broadcast-channel",
        "--unstable-worker-options",
        "--env-file",
        "../../../src/cli.tsx",
        "mcp",
        "serve",
      ],
      cwd: Deno.cwd(),
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: {
        ATLAS_LOG_LEVEL: "error",
        ATLAS_TEST_MODE: "true",
      },
    });

    mcpProcess = command.spawn();
    
    // Set up stream readers/writers
    processStdout = mcpProcess.stdout.getReader();
    processStderr = mcpProcess.stderr.getReader();
    processStdin = mcpProcess.stdin.getWriter();

    assertExists(mcpProcess);
    assertExists(processStdout);
    assertExists(processStderr);
    assertExists(processStdin);

    // Give the process time to start
    await delay(2000);
  });

  await t.step("should handle MCP initialize request", async () => {
    if (!processStdin || !processStdout) {
      throw new Error("Process not initialized");
    }

    // Send MCP initialize request
    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        clientInfo: {
          name: "atlas-test-client",
          version: "1.0.0",
        },
      },
    };

    const requestMessage = JSON.stringify(initRequest) + "\n";
    await processStdin.write(new TextEncoder().encode(requestMessage));

    // Read response with timeout
    const response = await withTimeout(
      (async () => {
        const result = await processStdout!.read();
        if (result.done) {
          throw new Error("Process stdout closed unexpectedly");
        }
        return new TextDecoder().decode(result.value);
      })(),
      5000,
      "MCP initialize response timeout",
    );

    assertExists(response);
    
    // Parse JSON-RPC response
    const lines = response.trim().split("\n");
    const responseObj = JSON.parse(lines[0]);
    
    assertEquals(responseObj.jsonrpc, "2.0");
    assertEquals(responseObj.id, 1);
    assertExists(responseObj.result);
    assertExists(responseObj.result.capabilities);
    assertExists(responseObj.result.capabilities.tools);
  });

  await t.step("should list available tools", async () => {
    if (!processStdin || !processStdout) {
      throw new Error("Process not initialized");
    }

    // Send tools/list request
    const toolsRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    };

    const requestMessage = JSON.stringify(toolsRequest) + "\n";
    await processStdin.write(new TextEncoder().encode(requestMessage));

    // Read response
    const response = await withTimeout(
      (async () => {
        const result = await processStdout!.read();
        if (result.done) {
          throw new Error("Process stdout closed unexpectedly");
        }
        return new TextDecoder().decode(result.value);
      })(),
      5000,
      "Tools list response timeout",
    );

    const responseObj = JSON.parse(response.trim().split("\n")[0]);
    
    assertEquals(responseObj.jsonrpc, "2.0");
    assertEquals(responseObj.id, 2);
    assertExists(responseObj.result);
    assertExists(responseObj.result.tools);
    
    const tools = responseObj.result.tools;
    const toolNames = tools.map((tool: any) => tool.name);
    
    expect(toolNames).toContain("workspace_list");
    expect(toolNames).toContain("workspace_describe");
    expect(toolNames).toContain("workspace_trigger_job");
    expect(toolNames).toContain("workspace_process_signal");
    expect(toolNames).toContain("workspace_create");
    expect(toolNames).toContain("workspace_delete");
  });

  await t.step("should execute workspace_list tool", async () => {
    if (!processStdin || !processStdout) {
      throw new Error("Process not initialized");
    }

    // Send workspace_list tool call
    const toolCallRequest = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "workspace_list",
        arguments: {},
      },
    };

    const requestMessage = JSON.stringify(toolCallRequest) + "\n";
    await processStdin.write(new TextEncoder().encode(requestMessage));

    // Read response
    const response = await withTimeout(
      (async () => {
        const result = await processStdout!.read();
        if (result.done) {
          throw new Error("Process stdout closed unexpectedly");
        }
        return new TextDecoder().decode(result.value);
      })(),
      5000,
      "Workspace list tool response timeout",
    );

    const responseObj = JSON.parse(response.trim().split("\n")[0]);
    
    assertEquals(responseObj.jsonrpc, "2.0");
    assertEquals(responseObj.id, 3);
    assertExists(responseObj.result);
    assertExists(responseObj.result.content);
    assertEquals(Array.isArray(responseObj.result.content), true);
    assertEquals(responseObj.result.content.length, 1);
    assertEquals(responseObj.result.content[0].type, "text");
    
    // Parse the workspace list response
    const workspaceData = JSON.parse(responseObj.result.content[0].text);
    assertExists(workspaceData.workspaces);
    assertEquals(Array.isArray(workspaceData.workspaces), true);
    assertEquals(workspaceData.total, workspaceData.workspaces.length);
    assertEquals(workspaceData.source, "active_runtimes");
    assertExists(workspaceData.timestamp);
    
    // Initially should be empty since no workspaces are running
    assertEquals(workspaceData.total, 0);
  });

  await t.step("should handle invalid tool call gracefully", async () => {
    if (!processStdin || !processStdout) {
      throw new Error("Process not initialized");
    }

    // Send call to non-existent workspace
    const toolCallRequest = {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "workspace_describe",
        arguments: {
          workspaceId: "nonexistent-workspace-id",
        },
      },
    };

    const requestMessage = JSON.stringify(toolCallRequest) + "\n";
    await processStdin.write(new TextEncoder().encode(requestMessage));

    // Read response
    const response = await withTimeout(
      (async () => {
        const result = await processStdout!.read();
        if (result.done) {
          throw new Error("Process stdout closed unexpectedly");
        }
        return new TextDecoder().decode(result.value);
      })(),
      5000,
      "Error response timeout",
    );

    const responseObj = JSON.parse(response.trim().split("\n")[0]);
    
    assertEquals(responseObj.jsonrpc, "2.0");
    assertEquals(responseObj.id, 4);
    
    // Should return an error for nonexistent workspace
    assertExists(responseObj.error);
    expect(responseObj.error.message).toContain("not found");
  });

  await t.step("should properly respond to ping", async () => {
    if (!processStdin || !processStdout) {
      throw new Error("Process not initialized");
    }

    // Send ping request
    const pingRequest = {
      jsonrpc: "2.0",
      id: 5,
      method: "ping",
      params: {},
    };

    const requestMessage = JSON.stringify(pingRequest) + "\n";
    await processStdin.write(new TextEncoder().encode(requestMessage));

    // Read response
    const response = await withTimeout(
      (async () => {
        const result = await processStdout!.read();
        if (result.done) {
          throw new Error("Process stdout closed unexpectedly");
        }
        return new TextDecoder().decode(result.value);
      })(),
      5000,
      "Ping response timeout",
    );

    const responseObj = JSON.parse(response.trim().split("\n")[0]);
    
    assertEquals(responseObj.jsonrpc, "2.0");
    assertEquals(responseObj.id, 5);
    assertExists(responseObj.result);
  });

  await t.step("teardown", async () => {
    // Clean up streams
    if (processStdout) {
      await processStdout.cancel();
    }
    if (processStderr) {
      await processStderr.cancel();
    }
    if (processStdin) {
      await processStdin.close();
    }

    // Terminate the MCP server process
    if (mcpProcess) {
      try {
        mcpProcess.kill("SIGTERM");
        await mcpProcess.status;
      } catch (error) {
        // Process might already be dead, that's okay
        console.warn("Error killing MCP process:", error);
      }
    }

    // Give time for cleanup
    await delay(1000);
  });
});
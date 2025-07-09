import { assertEquals, assertExists } from "@std/assert";
import { createMCPClient } from "./fixtures/mcp-client.ts";

Deno.test("Session Tools - describe", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Test with a mock session ID
    const mockSessionId = "test-session-123";

    const result = await client.callTool({
      name: "atlas_session_describe",
      arguments: {
        sessionId: mockSessionId,
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");

    // Session not found is expected for non-existent sessions
    // Just verify we get a text response
    assertExists(textContent);
    assertExists(textContent.text);

    // Response should indicate session not found
    assertEquals(textContent.text.includes("Session not found"), true);
  } finally {
    await transport.close();
  }
});

Deno.test("Session Tools - cancel", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Test with a mock session ID
    const mockSessionId = "test-session-cancel-123";

    const result = await client.callTool({
      name: "atlas_session_cancel",
      arguments: {
        sessionId: mockSessionId,
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");

    // Session not found is expected for non-existent sessions
    // Just verify we get a text response
    assertExists(textContent);
    assertExists(textContent.text);

    // Response should indicate session not found
    assertEquals(textContent.text.includes("Session not found"), true);
  } finally {
    await transport.close();
  }
});

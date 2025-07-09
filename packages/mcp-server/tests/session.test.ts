import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createMCPClient } from "./fixtures/mcp-client.ts";

Deno.test("Session Tools - describe", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Test with a mock session ID
    const mockSessionId = "test-session-123";

    const result = await client.callTool({
      name: "atlas:session_describe",
      arguments: {
        sessionId: mockSessionId,
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Should have session info (even if not found, should have proper structure)
    assertExists(responseData);
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
      name: "atlas:session_cancel",
      arguments: {
        sessionId: mockSessionId,
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Should have cancellation result
    assertExists(responseData);
  } finally {
    await transport.close();
  }
});

import { assertEquals, assertExists } from "@std/assert";
import { createMCPClient } from "./fixtures/mcp-client.ts";

Deno.test("Web Tools - fetch", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Test fetching a simple web page
    const result = await client.callTool({
      name: "atlas:fetch",
      arguments: {
        url: "https://httpbin.org/json",
        format: "text",
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Should have fetched content
    assertExists(responseData.output);
    assertEquals(typeof responseData.output, "string");

    // Should have title
    assertExists(responseData.title);
    assertEquals(responseData.title.includes("https://httpbin.org/json"), true);

    // Should have metadata
    assertExists(responseData.metadata);

    // Test with markdown format
    const markdownResult = await client.callTool({
      name: "atlas:fetch",
      arguments: {
        url: "https://httpbin.org/html",
        format: "markdown",
      },
    });

    const markdownContent = markdownResult.content as Array<{ type: string; text: string }>;
    const markdownTextContent = markdownContent.find((item) => item.type === "text");
    const markdownData = JSON.parse(markdownTextContent!.text);

    // Should have markdown content
    assertExists(markdownData.output);
    assertEquals(typeof markdownData.output, "string");
  } finally {
    await transport.close();
  }
});

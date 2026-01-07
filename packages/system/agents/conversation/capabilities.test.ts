import { assertStringIncludes } from "@std/assert";
import { getCapabilitiesSection } from "./capabilities.ts";

/**
 * Capabilities Section Tests
 *
 * Verifies that the XML output for LLM consumption includes
 * rich metadata for both bundled agents and MCP servers.
 */

Deno.test("getCapabilitiesSection - output includes bundled agents section", () => {
  const output = getCapabilitiesSection();

  assertStringIncludes(output, "<bundled_agents>");
  assertStringIncludes(output, "</bundled_agents>");
  assertStringIncludes(output, '<agent id="email"');
});

Deno.test("getCapabilitiesSection - bundled agents include constraints", () => {
  const output = getCapabilitiesSection();

  // Email agent should have constraints about recipient restrictions
  assertStringIncludes(output, "<constraints>");
  assertStringIncludes(output, "</constraints>");
});

Deno.test("getCapabilitiesSection - output includes MCP servers section", () => {
  const output = getCapabilitiesSection();

  assertStringIncludes(output, "<mcp_servers>");
  assertStringIncludes(output, "</mcp_servers>");
  assertStringIncludes(output, '<server id="google-gmail"');
});

Deno.test("getCapabilitiesSection - MCP servers include description", () => {
  // FAILING TEST BEFORE FIX: MCP servers currently only show name, not description
  const output = getCapabilitiesSection();

  // After fix: google-gmail should have a description mentioning OAuth
  assertStringIncludes(
    output.toLowerCase(),
    "oauth",
    "google-gmail description should mention OAuth requirement",
  );
});

Deno.test("getCapabilitiesSection - MCP servers include constraints when present", () => {
  // FAILING TEST BEFORE FIX: MCP servers currently have no constraints
  const output = getCapabilitiesSection();

  // Check that MCP server section has constraints tags
  const mcpSection = output.split("<mcp_servers>")[1]?.split("</mcp_servers>")[0] ?? "";

  assertStringIncludes(
    mcpSection,
    "<constraints>",
    "MCP servers should include constraints element",
  );
});

Deno.test("getCapabilitiesSection - email vs gmail disambiguation is clear", () => {
  // FAILING TEST BEFORE FIX: Currently no way for LLM to distinguish
  const output = getCapabilitiesSection();

  // The output should make notification vs inbox access distinction clear
  // Bundled email agent: for sending notifications (no OAuth)
  // google-gmail: for inbox access (requires OAuth)

  assertStringIncludes(output, "notification", "Email agent should mention notifications use case");

  // google-gmail should have guidance about inbox access
  const gmailServerMatch = output.match(/<server id="google-gmail"[^>]*>[\s\S]*?<\/server>/);
  if (gmailServerMatch) {
    assertStringIncludes(
      gmailServerMatch[0].toLowerCase(),
      "inbox",
      "google-gmail should mention inbox access",
    );
  }
});

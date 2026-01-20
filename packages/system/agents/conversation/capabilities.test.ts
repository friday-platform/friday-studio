import { describe, expect, it } from "vitest";
import { getCapabilitiesSection } from "./capabilities.ts";

/**
 * Capabilities Section Tests
 *
 * Verifies that the XML output for LLM consumption includes
 * rich metadata for both bundled agents and MCP servers.
 */

describe("getCapabilitiesSection", () => {
  it("output includes bundled agents section", () => {
    const output = getCapabilitiesSection();

    expect(output).toContain("<bundled_agents>");
    expect(output).toContain("</bundled_agents>");
    expect(output).toContain('<agent id="email"');
  });

  it("bundled agents include constraints", () => {
    const output = getCapabilitiesSection();

    // Email agent should have constraints about recipient restrictions
    expect(output).toContain("<constraints>");
    expect(output).toContain("</constraints>");
  });

  it("output includes MCP servers section", () => {
    const output = getCapabilitiesSection();

    expect(output).toContain("<mcp_servers>");
    expect(output).toContain("</mcp_servers>");
    expect(output).toContain('<server id="google-gmail"');
  });

  it("MCP servers include description", () => {
    // FAILING TEST BEFORE FIX: MCP servers currently only show name, not description
    const output = getCapabilitiesSection();

    // After fix: google-gmail should have a description mentioning OAuth
    expect(output.toLowerCase()).toContain("oauth");
  });

  it("MCP servers include constraints when present", () => {
    // FAILING TEST BEFORE FIX: MCP servers currently have no constraints
    const output = getCapabilitiesSection();

    // Check that MCP server section has constraints tags
    const mcpSection = output.split("<mcp_servers>")[1]?.split("</mcp_servers>")[0] ?? "";

    expect(mcpSection).toContain("<constraints>");
  });

  it("email vs gmail disambiguation is clear", () => {
    // FAILING TEST BEFORE FIX: Currently no way for LLM to distinguish
    const output = getCapabilitiesSection();

    // The output should make notification vs inbox access distinction clear
    // Bundled email agent: for sending notifications (no OAuth)
    // google-gmail: for inbox access (requires OAuth)

    expect(output).toContain("notification");

    // google-gmail should have guidance about inbox access
    const gmailServerMatch = output.match(/<server id="google-gmail"[^>]*>[\s\S]*?<\/server>/);
    if (gmailServerMatch) {
      expect(gmailServerMatch[0].toLowerCase()).toContain("inbox");
    }
  });
});

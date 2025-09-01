/**
 * Tests for LLM-driven anti-hallucination approach
 */

import { assertStringIncludes } from "@std/assert";
import WORKSPACE_ARCHITECT_SYSTEM_PROMPT from "../tools/workspace-creation/prompt.txt" with {
  type: "text",
};

Deno.test("LLM-Driven Anti-Hallucination", async (t) => {
  await t.step("system prompt should include anti-hallucination responsibility", () => {
    assertStringIncludes(
      WORKSPACE_ARCHITECT_SYSTEM_PROMPT,
      "ANTI-HALLUCINATION SAFEGUARDS",
      "Should include anti-hallucination section",
    );

    assertStringIncludes(
      WORKSPACE_ARCHITECT_SYSTEM_PROMPT,
      "CRITICAL RESPONSIBILITY",
      "Should emphasize LLM responsibility",
    );

    assertStringIncludes(
      WORKSPACE_ARCHITECT_SYSTEM_PROMPT,
      "Universal Source Attribution Protocol",
      "Should include Universal Source Attribution Protocol",
    );

    assertStringIncludes(
      WORKSPACE_ARCHITECT_SYSTEM_PROMPT,
      "MANDATORY SOURCE ATTRIBUTION PROTOCOL",
      "Should include mandatory source attribution",
    );

    assertStringIncludes(
      WORKSPACE_ARCHITECT_SYSTEM_PROMPT,
      "SOURCE ATTRIBUTION",
      "Should include source attribution instructions",
    );
  });

  await t.step("system prompt should provide clear examples", () => {
    assertStringIncludes(
      WORKSPACE_ARCHITECT_SYSTEM_PROMPT,
      "Monitor Nike for shoe releases",
      "Should provide monitoring examples",
    );

    assertStringIncludes(
      WORKSPACE_ARCHITECT_SYSTEM_PROMPT,
      "Generate report",
      "Should provide content generation examples",
    );

    assertStringIncludes(
      WORKSPACE_ARCHITECT_SYSTEM_PROMPT,
      "[tool:",
      "Should include tool attribution examples",
    );

    assertStringIncludes(
      WORKSPACE_ARCHITECT_SYSTEM_PROMPT,
      "[inference:",
      "Should include inference attribution examples",
    );
  });

  await t.step("system prompt should include tool guidance", () => {
    assertStringIncludes(
      WORKSPACE_ARCHITECT_SYSTEM_PROMPT,
      "targeted_research",
      "Should reference Atlas tools for data fetching",
    );

    assertStringIncludes(
      WORKSPACE_ARCHITECT_SYSTEM_PROMPT,
      "tool call",
      "Should require tool-based data",
    );

    assertStringIncludes(
      WORKSPACE_ARCHITECT_SYSTEM_PROMPT,
      "unable to retrieve data",
      "Should handle data unavailability",
    );
  });
});

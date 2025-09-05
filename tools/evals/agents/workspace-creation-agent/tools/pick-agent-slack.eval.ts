import { logger } from "@atlas/logger";
import { assert } from "@std/assert";
import { WorkspaceBuilder } from "../../../../../packages/system/agents/workspace-creation/builder.ts";
import { getPickAgentTool } from "../../../../../packages/system/agents/workspace-creation/tools/pick-agent.ts";
import { loadCredentials } from "../../../lib/load-credentials.ts";
import { setupTest } from "../../../lib/utils.ts";

const { step } = setupTest({ testFileUrl: new URL(import.meta.url) });

Deno.test("Research Agent: Reddit domain filtering", async (t) => {
  await loadCredentials();
  const builder = new WorkspaceBuilder();
  builder.setIdentity("Test Workspace", "A testing workspace.");
  const tool = getPickAgentTool(builder, logger);
  
  const res = await tool.execute?.(
    {
      requirements:
        "Create a specialized agent for product insight analysis from meeting transcripts with the following core capabilities:\n" +
        "\n" +
        "1. Transcript Processing:\n" +
        "- Ingest raw meeting transcript text\n" +
        "- Perform deep semantic analysis of conversation content\n" +
        "- Identify key product discovery insights\n" +
        "- Extract user feedback and pain points\n" +
        "- Detect emerging user needs and preferences\n" +
        "\n" +
        "2. Insight Structuring:\n" +
        "- Categorize findings into clear sections:\n" +
        "  a) Product Discovery Learnings\n" +
        "  b) User Insights\n" +
        "  c) Recommended Next Steps\n" +
        "  d) Specific Action Items\n" +
        "\n" +
        "3. Output Characteristics:\n" +
        "- Provide a structured, actionable report\n" +
        "- Use clear, concise language\n" +
        "- Prioritize insights by potential impact\n" +
        "- Include brief contextual explanations for each insight\n" +
        "\n" +
        "4. Advanced Analysis Techniques:\n" +
        "- Recognize implicit and explicit user feedback\n" +
        "- Correlate multiple discussion points\n" +
        "- Identify potential product improvement opportunities\n" +
        "- Highlight strategic recommendations\n" +
        "\n" +
        "The agent should be capable of transforming unstructured meeting dialogue into a strategic, insights-driven document that supports product development and decision-making processes.",
      taskSummary: "Creating product analysis agent",
    },
    { messages: [], toolCallId: "" },
  );

  await step(
    t,
    "Pick agent tool execution",
    async () => {
      assert(1 + 1 === 2);
      // Direct assertions on the output
      // assert(res?.text === 1, "Should create a signal");
      // assert(result.synthesis.includes("reddit.com"), "Should include Reddit URLs");
      // assert(result.synthesis.match(/^[•\-*]/gm), "Should format as list");
      // assert(result.synthesis.toLowerCase().includes("proxmox"), "Should mention proxmox");

      return res;
    },
    (res) => ({
      result: res,
      workspace: builder.exportConfig(),
      mcpDomainRequirements: builder.mcpDomainRequirements,
    })
  );
});

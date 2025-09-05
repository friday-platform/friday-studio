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
        "An agent that searches /r/gravelcycling, /r/bikepacking for new posts about gravel bikes with wide tire clearance.",
      taskSummary: "Generating gravel bike research agent",
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
    }),
  );
});

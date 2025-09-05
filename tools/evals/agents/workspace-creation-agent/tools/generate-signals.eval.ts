import { logger } from "@atlas/logger";
import { assert } from "@std/assert";
import { WorkspaceBuilder } from "../../../../../packages/system/agents/workspace-creation/builder.ts";
import { getGenerateSignalsTool } from "../../../../../packages/system/agents/workspace-creation/tools/generate-signals.ts";
import { loadCredentials } from "../../../lib/load-credentials.ts";
import { setupTest, unwrapToolResult } from "../../../lib/utils.ts";

const { step } = setupTest({ testFileUrl: new URL(import.meta.url) });

Deno.test("Workspace Creation Agent: generateSignals", async (t) => {
  await loadCredentials();
  const builder = new WorkspaceBuilder();
  builder.setIdentity("Test Workspace", "A testing workspace.");
  const tool = getGenerateSignalsTool(builder, logger);

  await step(t, "Generating a cron and a webhook", async ({ snapshot }) => {
    const toolResult = await tool.execute?.(
      {
        requirements:
          "Two signals. One that fires every morning at 9am PT and one that runs on a webhook",
      },
      { messages: [], toolCallId: "" },
    );
    assert(toolResult, "Should have a result");
    const res = await unwrapToolResult(toolResult);

    snapshot({ res, config: builder.exportConfig() });

    // Verify that two signals were created.
    assert(res.count === 2, "Should create two signals");
    assert(res.types.includes("http"), "Should create a webhook signal");
    assert(res.types.includes("schedule"), "Should create a cron signal");

    return res;
  });

  builder.reset();
  builder.setIdentity("Test Workspace", "A testing workspace.");

  await step(t, "Generating a Linear signal", async ({ snapshot }) => {
    const toolResult = await tool.execute?.(
      { requirements: "A signal that fires every time there is a new issue in Linear" },
      { messages: [], toolCallId: "" },
    );
    assert(toolResult, "Should have a result");
    const res = await unwrapToolResult(toolResult);

    snapshot({ res, config: builder.exportConfig() });

    // Verify that one signal was created.
    assert(res.count === 1, "Should create one signal");
    assert(res.types.includes("http"), "Should create a webhook signal");

    return res;
  });
});

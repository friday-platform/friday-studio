import { workspaceCreationAgent } from "@atlas/system/agents";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { setupTest } from "../../lib/utils.ts";

const { step } = setupTest({ testFileUrl: new URL(import.meta.url) });

Deno.test("Workspace Creation Agent", async (t) => {
  await loadCredentials();
  const adapter = new AgentContextAdapter();
  adapter.enableTelemetry();
  const context = adapter.createContext({ telemetry: true });

  await step(t, "Meeting Note Analysis", async ({ snapshot }) => {
    const result = await workspaceCreationAgent.execute(
      "I'm a product manager, and I'm conducting discovery for my new product. I want Atlas to take my transcribed meeting notes from a directory on my computer, analyze them for learnings and next steps, and then share out to the rest of the team on Slack.",
      context,
    );

    const metrics = adapter.getMetrics();
    const trace = adapter.getTrace();

    snapshot({ result, metrics, trace });

    // Direct assertions on the output
    // Assert workspace was created successfully
    assert(result.success === true, "Workspace should be created successfully");

    // Assert workspace has correct number of agents
    assert(result.summary.agentCount === 3, "Should have exactly 3 agents");

    // Assert workspace has correct number of signals
    assert(result.summary.signalCount === 1, "Should have exactly 1 signal");

    // Assert workspace has correct number of jobs
    assert(result.summary.jobCount === 1, "Should have exactly 1 job");

    return { result, metrics, trace };
  });
});

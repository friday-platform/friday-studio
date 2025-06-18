import { assertEquals, assertExists } from "@std/assert";
import { load } from "@std/dotenv";

Deno.test("Workspace - Configuration Loading", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  // Load environment variables
  await load({ export: true });

  // Test that we can load the telephone workspace config
  const workspaceYaml = await Deno.readTextFile("./examples/workspaces/telephone/workspace.yml");
  assertExists(workspaceYaml);

  // Basic validation that config contains expected sections
  const hasAgents = workspaceYaml.includes("agents:");
  const hasSignals = workspaceYaml.includes("signals:");
  const hasTelephoneSignal = workspaceYaml.includes("telephone-message");

  assertEquals(hasAgents, true);
  assertEquals(hasSignals, true);
  assertEquals(hasTelephoneSignal, true);
});

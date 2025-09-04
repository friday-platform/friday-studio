import { targetedResearchAgent } from "@atlas/bundled-agents";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

Deno.test("Research Agent: Reddit domain filtering", async (t) => {
  await loadCredentials();
  const adapter = new AgentContextAdapter();
  const context = adapter.createContext();

  const result = await targetedResearchAgent.execute(
    "r/homelab posts about proxmox cluster setup",
    context,
  );

  const pass = await t.step("", () => {
    // Direct assertions on the output
    assert(result.sources.searchResults > 0, "Should find search results");
    assert(result.synthesis.includes("reddit.com"), "Should include Reddit URLs");
    assert(result.synthesis.match(/^[•\-*]/gm), "Should format as list");
    assert(result.synthesis.toLowerCase().includes("proxmox"), "Should mention proxmox");
  });

  await saveSnapshot({ testPath: new URL(import.meta.url), data: result, pass });
});

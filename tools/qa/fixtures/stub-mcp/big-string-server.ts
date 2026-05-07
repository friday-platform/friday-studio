#!/usr/bin/env -S deno run --allow-all
/**
 * Stub MCP server used by the Phase 3 (scrubber) live-daemon scenario.
 *
 * Exposes one tool, `fetch_big_blob`, that returns a deterministic ~6 KB
 * string in its CallToolResult content. The Phase 3 scrubber should
 * detect the >4 KB threshold (`SIZE_THRESHOLD_CHARS` in
 * `packages/core/src/artifacts/scrubber.ts`), lift the body to an
 * artifact, and rewrite the action's message buffer to carry an
 * `<artifact-ref:...>` placeholder rather than the raw bytes.
 *
 * Synthetic / deterministic payload — no PII, no real customer data.
 *
 * Spawned over stdio via the workspace fixture's
 * `tools.mcp.servers.stub_big.transport`.
 */
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.28/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@1.28/server/stdio.js";
import { z } from "npm:zod@4";

const server = new McpServer(
  { name: "stub-big-blob", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// ~12 KB of deterministic, low-entropy text. Sized to clear the
// scrubber's TEXT_THRESHOLD_CHARS (8 KB) — see scrubber.ts. The 50 %
// margin keeps the assertion robust against future threshold tweaks
// without making the test payload unreadable in failure logs.
function makeBlob(): string {
  const line =
    "qa-payload-line: synthetic deterministic body for melodic-strolling-seal H1 phase-3 scrubber scenario; no pii; no real customer data; ";
  // ~140 chars/line × 90 lines ≈ 12.6 KB > 8 KB text threshold.
  return Array.from({ length: 90 }, (_, i) => `${i.toString().padStart(3, "0")} ${line}`).join(
    "\n",
  );
}

server.registerTool(
  "fetch_big_blob",
  {
    description:
      "Returns a deterministic ~6 KB synthetic string. Test fixture for Phase 3 (scrubber) — exercises the auto-lift threshold.",
    inputSchema: { reason: z.string().optional() },
  },
  () => ({ content: [{ type: "text" as const, text: makeBlob() }] }),
);

await server.connect(new StdioServerTransport());

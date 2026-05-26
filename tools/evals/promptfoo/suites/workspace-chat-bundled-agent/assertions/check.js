// Per-constraint assertions for the workspace-chat-bundled-agent suite.
//
// Reads the handler's JSON output (captures) and applies one constraint per
// exported function. Each export returns `{ pass, score, reason }`. tests.yaml
// wires each export as its own `javascript:` assert with a distinct `metric:`
// so promptfoo's per-metric report shows pass rates per rule and a failing
// case names the constraint that broke.
//
// Tests that route through this file may or may not set
// `options.transform: 'JSON.parse(output)'` — promptfoo hands the transformed
// value to file-based assertions too. Accept either a string (untransformed)
// or an already-parsed object so the metric stays portable.
//
// Two distinct trivially-pass patterns to keep separate (mirrors the header
// comment in workspace-chat-agent-type/assertions/check.js):
//   1. Constraint-empty (intentional): N/A here — both metrics in this file
//      apply uniformly to every case.
//   2. Captures empty (handler failure mode, NOT a real pass): if a model
//      emits zero upsert_agent calls — or the handler swallows an error
//      chunk and surfaces empty captures — the negative `!some(...)` filters
//      vacuously match and would silently report pass. Both metrics guard
//      `upsertAgents.length > 0` and fail when it isn't, so a broken run
//      doesn't masquerade as PASS on the per-metric report. Row-level
//      pass-rate is already protected by BundledWebAgentChosen /
//      BundledSlackAgentChosen / AnyAtlasAgent in tests.yaml; this file
//      protects the per-metric signal.

const BROWSER_MCP_IDS = ["playwright-mcp", "puppeteer-mcp", "browser-mcp"];

function parseOutput(output) {
  return typeof output === "string" ? JSON.parse(output) : output;
}

// No workspace-level enable_mcp_server call for a redundant browser MCP when a
// bundled atlas/web agent already covers browsing.
function noRedundantMcpEnable(output) {
  const parsed = parseOutput(output);
  const { captures } = parsed;
  if (captures.upsertAgents.length === 0) {
    return {
      pass: false,
      score: 0,
      reason: "no upsert_agent calls emitted — cannot verify redundant MCP enable",
    };
  }
  const redundant = captures.enabledMcpServers.filter((e) =>
    BROWSER_MCP_IDS.includes(e.serverId),
  );
  if (redundant.length === 0) {
    return {
      pass: true,
      score: 1,
      reason: `no redundant browser-MCP enable_mcp_server call (forbidden: [${BROWSER_MCP_IDS.join(", ")}])`,
    };
  }
  return {
    pass: false,
    score: 0,
    reason: `Redundant browser-MCP enabled: ${redundant.map((e) => e.serverId).join(", ")}`,
  };
}

// No non-atlas upsert_agent wires a redundant browser MCP via its tools[] list
// (the fallback regression where the model emits the bundled atlas/web agent
// AND a second `type:llm` agent that pulls in a browser MCP via tools — the
// workspace-level enabledMcpServers stays clean, so noRedundantMcpEnable
// passes despite real redundancy). Split on '/' to match both bare ids
// (`playwright-mcp`) and namespaced refs (`playwright-mcp/browser_navigate`);
// mirrors the prefix logic in workspace-chat-agent-type#requiredMcpWired.
function noRedundantMcpViaToolList(output) {
  const parsed = parseOutput(output);
  const { captures } = parsed;
  if (captures.upsertAgents.length === 0) {
    return {
      pass: false,
      score: 0,
      reason: "no upsert_agent calls emitted — cannot verify redundant MCP via tool list",
    };
  }
  const redundant = captures.upsertAgents.filter((u) => {
    if (u.config.type === "atlas") return false;
    const tools = u.config?.config?.tools;
    if (!Array.isArray(tools)) return false;
    return tools.some(
      (t) => typeof t === "string" && BROWSER_MCP_IDS.includes(t.split("/")[0]),
    );
  });
  if (redundant.length === 0) {
    return {
      pass: true,
      score: 1,
      reason: `no non-atlas upsert wires a redundant browser MCP via tools[] (forbidden prefixes: [${BROWSER_MCP_IDS.join(", ")}])`,
    };
  }
  return {
    pass: false,
    score: 0,
    reason:
      "Redundant browser-MCP via tools[] on non-atlas upsert(s): " +
      redundant.map((u) => `${u.id}(type=${u.config.type})`).join(", "),
  };
}

module.exports = {
  noRedundantMcpEnable,
  noRedundantMcpViaToolList,
};

// Per-constraint assertions for the workspace-chat-agent-type suite.
//
// Reads the handler's JSON output (captures + known bundled-agent ids) and
// applies one constraint per exported function. Each export returns
// `{ pass, score, reason }`. tests.yaml wires each export as its own
// `javascript:` assert with a distinct `metric:` so promptfoo's per-metric
// report shows pass rates per constraint and a failing case names the rule
// that broke (instead of a single "javascript assertion failed").
//
// Score names mirror the pre-promptfoo `agent-type-default.eval.ts` rubric:
//   correct-type-chosen, no-wrong-type, no-overdelegated-atlas,
//   no-spurious-user-agent, required-mcp-wired, no-phantom-atlas-agent.
//
// Constraints whose per-case vars are empty (e.g. no forbidden atlas agents
// declared) return a trivially-passing result so every case can wire the
// full set of asserts uniformly.

function parseContext(output, context) {
  const parsed = JSON.parse(output);
  const vars = context.vars;
  return {
    captures: parsed.captures,
    knownBundledAgents: new Set(parsed.knownBundledAgents),
    expectedType: vars.expectedType,
    expectedAgent: vars.expectedAgent,
    forbiddenTypes: new Set(JSON.parse(vars.forbiddenTypesJson || "[]")),
    forbiddenAtlasAgents: new Set(JSON.parse(vars.forbiddenAtlasAgentsJson || "[]")),
    requiredMcpServers: JSON.parse(vars.requiredMcpServersJson || "[]"),
    forbidUserAgentRegistration:
      vars.forbidUserAgentRegistration === true || vars.forbidUserAgentRegistration === "true",
  };
}

function summarizeUpserts(upsertAgents) {
  if (upsertAgents.length === 0) return "no upsert_agent calls";
  return upsertAgents
    .map((u) => `${u.id}(type=${u.config.type || "?"}, agent=${u.config.agent || "?"})`)
    .join(", ");
}

// 1. At least one upsert_agent matched the expected type (and agent, if given).
function correctTypeChosen(output, context) {
  const { captures, expectedType, expectedAgent } = parseContext(output, context);
  const matched = captures.upsertAgents.find(
    (u) =>
      u.config.type === expectedType &&
      (expectedAgent === undefined || expectedAgent === "" || u.config.agent === expectedAgent),
  );
  if (matched) {
    return {
      pass: true,
      score: 1,
      reason: `at least one upsert_agent emitted with type="${expectedType}"`,
    };
  }
  return {
    pass: false,
    score: 0,
    reason:
      `Expected upsert_agent with type="${expectedType}"` +
      (expectedAgent ? `, agent="${expectedAgent}"` : "") +
      `. Got: ${summarizeUpserts(captures.upsertAgents)}`,
  };
}

// 2. No upsert_agent used a forbidden type.
function noWrongType(output, context) {
  const { captures, forbiddenTypes } = parseContext(output, context);
  if (forbiddenTypes.size === 0) {
    return { pass: true, score: 1, reason: "no forbidden types declared for this case" };
  }
  const wrongType = captures.upsertAgents.filter((u) => forbiddenTypes.has(u.config.type));
  if (wrongType.length === 0) {
    return {
      pass: true,
      score: 1,
      reason: `no forbidden types in [${[...forbiddenTypes].join(", ")}]`,
    };
  }
  return {
    pass: false,
    score: 0,
    reason:
      "Forbidden type(s) used: " +
      wrongType.map((u) => `${u.id}(type=${u.config.type})`).join(", "),
  };
}

// 3. No type:atlas upsert used a forbidden bundled-agent id.
function noOverdelegatedAtlas(output, context) {
  const { captures, forbiddenAtlasAgents } = parseContext(output, context);
  if (forbiddenAtlasAgents.size === 0) {
    return { pass: true, score: 1, reason: "no forbidden atlas agents declared for this case" };
  }
  const wrongAtlas = captures.upsertAgents.filter(
    (u) => u.config.type === "atlas" && forbiddenAtlasAgents.has(u.config.agent),
  );
  if (wrongAtlas.length === 0) {
    return {
      pass: true,
      score: 1,
      reason: `no forbidden atlas agents in [${[...forbiddenAtlasAgents].join(", ")}]`,
    };
  }
  return {
    pass: false,
    score: 0,
    reason: `Forbidden atlas agent(s) used: ${wrongAtlas.map((u) => u.config.agent).join(", ")}`,
  };
}

// 4. No spurious user-agent registration when the case forbids it.
function noSpuriousUserAgent(output, context) {
  const { captures, forbidUserAgentRegistration } = parseContext(output, context);
  if (!forbidUserAgentRegistration) {
    return { pass: true, score: 1, reason: "user agent registration not forbidden for this case" };
  }
  if (captures.registeredUserAgentEntrypoints.length === 0) {
    return { pass: true, score: 1, reason: "no user agents registered" };
  }
  return {
    pass: false,
    score: 0,
    reason:
      "Registered user agent(s) when none should be needed: " +
      captures.registeredUserAgentEntrypoints.join(", "),
  };
}

// 5. Every required MCP server is wired (via enable_mcp_server OR tools[] ref).
function requiredMcpWired(output, context) {
  const { captures, requiredMcpServers } = parseContext(output, context);
  if (requiredMcpServers.length === 0) {
    return { pass: true, score: 1, reason: "no MCP servers required for this case" };
  }
  const isReferenced = (serverId) =>
    captures.enabledMcpServers.includes(serverId) ||
    captures.upsertAgents.some((u) => {
      const tools = u.config?.config?.tools || null;
      if (!Array.isArray(tools)) return false;
      return tools.some(
        (t) => typeof t === "string" && (t === serverId || t.startsWith(`${serverId}/`)),
      );
    });
  const missing = requiredMcpServers.filter((id) => !isReferenced(id));
  if (missing.length === 0) {
    return {
      pass: true,
      score: 1,
      reason: `all required MCP servers wired: [${requiredMcpServers.join(", ")}]`,
    };
  }
  return {
    pass: false,
    score: 0,
    reason:
      `Required MCP server(s) not wired: ${missing.join(", ")}. ` +
      `Enabled: [${captures.enabledMcpServers.join(", ") || "none"}]`,
  };
}

// 6. Universal: every type:atlas upsert resolves to a real bundled agent.
// (knownBundledAgents comes from @atlas/bundled-agents — surfaced by the
// handler since the assertion runs in promptfoo's Node sandbox where the
// Deno-only @atlas/bundled-agents package isn't importable.)
function noPhantomAtlasAgent(output, context) {
  const { captures, knownBundledAgents } = parseContext(output, context);
  const phantomAtlas = captures.upsertAgents.filter(
    (u) =>
      u.config.type === "atlas" &&
      typeof u.config.agent === "string" &&
      !knownBundledAgents.has(u.config.agent),
  );
  if (phantomAtlas.length === 0) {
    return {
      pass: true,
      score: 1,
      reason: "every type:atlas upsert resolves to a real bundled agent",
    };
  }
  return {
    pass: false,
    score: 0,
    reason:
      "Phantom atlas agent(s) (not in bundledAgentsRegistry): " +
      phantomAtlas.map((u) => `${u.id}(agent=${u.config.agent})`).join(", "),
  };
}

module.exports = {
  correctTypeChosen,
  noWrongType,
  noOverdelegatedAtlas,
  noSpuriousUserAgent,
  requiredMcpWired,
  noPhantomAtlasAgent,
};

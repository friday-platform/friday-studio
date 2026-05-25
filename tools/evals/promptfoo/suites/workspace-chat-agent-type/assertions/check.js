// Shared assertion for the workspace-chat-agent-type suite.
//
// Reads the handler's JSON output (captures + known bundled-agent ids) and
// validates per-case constraints encoded in `context.vars`. Returns a single
// {pass, reason, score} result that aggregates every check — easier to read
// in promptfoo's UI than five separate per-constraint assertions.

module.exports = (output, context) => {
  const parsed = JSON.parse(output);
  const captures = parsed.captures;
  const knownBundledAgents = new Set(parsed.knownBundledAgents);
  const vars = context.vars;

  const expectedType = vars.expectedType;
  const expectedAgent = vars.expectedAgent; // optional
  const forbiddenTypes = new Set(JSON.parse(vars.forbiddenTypesJson || "[]"));
  const forbiddenAtlasAgents = new Set(JSON.parse(vars.forbiddenAtlasAgentsJson || "[]"));
  const requiredMcpServers = JSON.parse(vars.requiredMcpServersJson || "[]");
  const forbidUserAgentRegistration = vars.forbidUserAgentRegistration === true ||
    vars.forbidUserAgentRegistration === "true";

  const failures = [];

  // 1. Required type/agent present
  const matched = captures.upsertAgents.find(
    (u) => u.config.type === expectedType &&
      (expectedAgent === undefined || expectedAgent === "" || u.config.agent === expectedAgent),
  );
  if (!matched) {
    const summary = captures.upsertAgents.length === 0
      ? "no upsert_agent calls"
      : captures.upsertAgents
          .map((u) => `${u.id}(type=${u.config.type || "?"}, agent=${u.config.agent || "?"})`)
          .join(", ");
    failures.push(
      `Expected upsert_agent with type="${expectedType}"` +
        (expectedAgent ? `, agent="${expectedAgent}"` : "") +
        `. Got: ${summary}`,
    );
  }

  // 2. No forbidden types
  const wrongType = captures.upsertAgents.filter((u) => forbiddenTypes.has(u.config.type));
  if (wrongType.length > 0) {
    failures.push(
      "Forbidden type(s) used: " +
        wrongType.map((u) => `${u.id}(type=${u.config.type})`).join(", "),
    );
  }

  // 3. No forbidden atlas agents
  const wrongAtlas = captures.upsertAgents.filter(
    (u) => u.config.type === "atlas" && forbiddenAtlasAgents.has(u.config.agent),
  );
  if (wrongAtlas.length > 0) {
    failures.push("Forbidden atlas agent(s) used: " + wrongAtlas.map((u) => u.config.agent).join(", "));
  }

  // 4. No spurious user-agent registration
  if (forbidUserAgentRegistration && captures.registeredUserAgentEntrypoints.length > 0) {
    failures.push(
      "Registered user agent(s) when none should be needed: " +
        captures.registeredUserAgentEntrypoints.join(", "),
    );
  }

  // 5. Required MCP servers wired (via enable_mcp_server OR tools[] reference)
  if (requiredMcpServers.length > 0) {
    const isReferenced = (serverId) =>
      captures.enabledMcpServers.includes(serverId) ||
      captures.upsertAgents.some((u) => {
        const tools = (u.config && u.config.config && u.config.config.tools) || null;
        if (!Array.isArray(tools)) return false;
        return tools.some(
          (t) => typeof t === "string" && (t === serverId || t.startsWith(serverId + "/")),
        );
      });
    const missing = requiredMcpServers.filter((id) => !isReferenced(id));
    if (missing.length > 0) {
      failures.push(
        `Required MCP server(s) not wired: ${missing.join(", ")}. ` +
          `Enabled: [${captures.enabledMcpServers.join(", ") || "none"}]`,
      );
    }
  }

  // 6. Universal: every type:atlas upsert resolves to a real bundled agent.
  // (knownBundledAgents comes from @atlas/bundled-agents — surfaced by the
  // handler since the assertion runs in promptfoo's Node sandbox where the
  // Deno-only @atlas/bundled-agents package isn't importable.)
  const phantomAtlas = captures.upsertAgents.filter(
    (u) => u.config.type === "atlas" && typeof u.config.agent === "string" &&
      !knownBundledAgents.has(u.config.agent),
  );
  if (phantomAtlas.length > 0) {
    failures.push(
      "Phantom atlas agent(s) (not in bundledAgentsRegistry): " +
        phantomAtlas.map((u) => `${u.id}(agent=${u.config.agent})`).join(", "),
    );
  }

  if (failures.length === 0) {
    return { pass: true, score: 1, reason: "all constraints satisfied" };
  }
  return { pass: false, score: 0, reason: failures.join(" | ") };
};

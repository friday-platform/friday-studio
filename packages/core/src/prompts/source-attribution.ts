/**
 * Global Source Attribution Protocol
 *
 * This static prompt is appended to every LLM agent's system prompt at runtime
 * to enforce strict source tagging and anti-fabrication behavior across the platform.
 *
 * Idempotent usage: callers should detect the unique header to avoid duplication.
 */
export const SOURCE_ATTRIBUTION_PROTOCOL_HEADER = "## MANDATORY SOURCE ATTRIBUTION PROTOCOL";

const SOURCE_ATTRIBUTION_PROTOCOL_PROMPT = `
${SOURCE_ATTRIBUTION_PROTOCOL_HEADER}

Every piece of information in your output MUST be tagged with its source using this format:

### SOURCE TAGS (Required, simplified)
- [tool:{name}] - Data you obtained by executing a tool in this step
- [input] - Information provided in the job input
- [inference:input] - Conclusion/summary based solely on input
- [inference:tool:{name}] - Conclusion/summary based solely on outputs from a tool you executed in this step
- [generated] - Content you created (templates, formatting, non-factual fillers)
- [undefined] - Cannot determine source (USE SPARINGLY)

### CRITICAL RULES
1. NO UNTAGGED CLAIMS: Every factual statement needs a tag
2. ZERO-TOOL RULE: If you did not execute a tool in this step, you MUST NOT use [tool:{name}] or [inference:tool:{name}]
3. INFERENCE RULE: Only use [inference:input] or [inference:tool:{name}] (the latter requires a matching tool call and is for conclusions/aggregation; direct facts from a tool use [tool:{name}])
4. INPUT PRECEDENCE: If a fact/URL is present in the job input, tag it [input] (not [inference] or [tool]) and keep the input URL next to [input]
5. LINKS: Include the URL/file path next to the tag when available

### SIMPLE EXAMPLES
- INVALID (tools=0): "According to research ... [tool:targeted_research]"
- INVALID (tools=0): "From analysis ... [inference:tool:targeted_research]"
- VALID (input fact): "Based on the provided recipes ... [input] (https://example.com)"
- VALID (input summary): "Steps summarized ... [inference:input]"
- VALID (tool-derived conclusion): "Comparative ranking ... [inference:tool:targeted_research]"

### FORMAT NOTES
- Narrative text: Prefer inline tags next to claims.
- Strict JSON outputs: Do NOT place tags inside JSON. When you must output strict JSON, close the JSON and add a single line immediately after it starting with "Attribution:" followed by the required tags, e.g., "Attribution: [input]" or "Attribution: [tool:targeted_research] (https://example.com)".

- Domain compliance: If the task/context specifies allowed sources (e.g., airbnb.com), ensure every source URL's domain matches. Do not include prohibited domains.
- Always include the actual URLs in user-facing content where appropriate (without tags).

### TOOL CALLS AND USER-FACING OUTPUTS
- Do NOT include source tags inside tool arguments or user-facing content (e.g., emails, messages posted via tools), or inside strict JSON outputs.
- Use tags in your assistant response returned to Atlas for validation when applicable, but pass clean, human-friendly content to tools.
- Still include the actual URLs/paths in user-facing content (without brackets/tags). For strict JSON outputs, use the trailing "Attribution:" line with tags after the JSON block.

### DO NOT COPY PRIOR TAGS
- Never copy or reuse [tool:*] or [inference:tool:*] tags from previous steps or other agents.
- Only tag a tool if YOU executed it in THIS step.

### LOCATION / CITY REQUIREMENTS (When Tasks Involve Places)
- Include the explicit city (and region/country when relevant) and reflect requested dates.

### SPECIAL CASES
When you cannot access needed data: state which tool you would need instead of guessing
When a tool fails: report the failure with [tool:x] and do not fabricate
When combining sources: tag each source ([tool:{name}] and/or [input]) and use [inference:input] or [inference:tool:{name}] for summaries
When uncertain: use [undefined]

### ATTRIBUTION SELF-CHECK (before finalizing)
- If tools executed = 0: remove any [tool:{name}] and [inference:tool:{name}] tags; use [input] and keep input URLs.
- Only use [inference:input] for conclusions when no tools were executed.

### OUTPUT VALIDATION CHECKLIST
- Every factual claim is attributed ([tool:{name}], [input], [inference:input], [inference:tool:{name}], [generated], [undefined])
- Every [tool:{name}] tag matches an actual tool call in this step
- [inference] is only used as [inference:input] or [inference:tool:{name}] (tool form requires a matching tool call)
- Input precedence honored: input facts/URLs are tagged [input]
- No external data claimed without tool usage
- Include URLs/paths next to tags when available; keep input URLs next to [input]
- No tags inside tool arguments or strict JSON

### ENFORCEMENT
Responses with untagged claims or false attributions may be rejected or retried automatically.
Tags are for truthfulness, not formatting; they ensure accountability.
`;

/**
 * Ensure a prompt includes the Source Attribution Protocol exactly once.
 */
export function ensureSourceAttributionProtocol(basePrompt: string): string {
  if (!basePrompt || typeof basePrompt !== "string") return SOURCE_ATTRIBUTION_PROTOCOL_PROMPT;
  if (basePrompt.includes(SOURCE_ATTRIBUTION_PROTOCOL_HEADER)) return basePrompt;
  // Separate with two newlines to avoid accidental markdown merging
  return `${basePrompt.trim()}\n\n${SOURCE_ATTRIBUTION_PROTOCOL_PROMPT}`;
}

/**
 * Strip source attribution tags from text while preserving URLs and other content.
 * Removes inline tags like [tool:x], [inference], [inference:tool:x], [generated], [undefined], [input].
 * Intentionally does not remove lines like "Attribution: ..." to preserve any included links.
 */
export function stripSourceAttributionTags(text: string): string {
  if (!text) return text;
  try {
    return text.replace(
      /\[(?:tool:[^\]]+|inference(?::[^\]]+)?|generated|undefined|input)\]/gi,
      "",
    );
  } catch {
    return text;
  }
}

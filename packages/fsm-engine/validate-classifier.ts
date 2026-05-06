/**
 * Observability-only classifier (phase B1 of melodic-strolling-seal-pt2).
 *
 * Decides what validation strategy WOULD apply per FSM `type: llm` action,
 * without changing runtime behavior. Wired into fsm-engine.ts as a debug log
 * so we can compare decisions against author intent on real workloads BEFORE
 * B2 lands the schema field that flips behavior.
 *
 * - "skip"     — read-only fetcher / pure formatter / non-llm agent type
 * - "self"     — LLM did real reasoning (or called mutating tools), validate inline
 * - "external" — author opt-in only (B2). The auto classifier never returns this.
 */

export type ValidateDecision = "skip" | "self" | "external";

export interface ClassifierInput {
  /** Action's declared `tools:` allowlist (action.tools ?? []). */
  declaredTools: string[];
  /** Tool names the LLM actually invoked during the call. */
  calledToolNames: string[];
  /** !!action.outputType */
  hasOutputType: boolean;
  /** !!action.inputFrom */
  hasInputFrom: boolean;
  /** Resolved agent kind for `case "agent"` paths; undefined for `case "llm"`. */
  resolvedAgentType?: "llm" | "user" | "atlas";
  /** Trace.content non-empty and not a trivial echo. */
  emittedProse: boolean;
  /** declaredTools.length > 0 (cached for clarity at call sites). */
  toolsAvailable: boolean;
}

export interface ClassifierResult {
  decision: ValidateDecision;
  reason: string;
}

/**
 * Read-only tool allowlist. Tool names in the runtime are typically
 * `<mcp-server-id>/<tool>`; built-ins (e.g. `memory_read`) may appear unprefixed.
 * Match is performed against both the full name and the suffix after `/`.
 *
 * `run_code` is intentionally NOT in this list — it can mutate state.
 */
export const READ_ONLY_ALLOWLIST: ReadonlyArray<string | RegExp> = [
  // gmail
  /^search_/,
  /^get_gmail_/,
  /^list_gmail_/,
  // github
  /^get_/,
  /^search_/,
  /^list_/,
  /^view_/,
  // fs
  "fs_read_file",
  "fs_glob",
  "fs_list_files",
  "fs_grep",
  // core
  "web_fetch",
  "web_search",
  "request_tool_access",
  // memory
  "memory_read",
  // artifacts
  "artifacts_get",
  "parse_artifact",
  "display_artifact",
];

/**
 * Verbs that strongly imply the tool mutates state. Match is performed against
 * the suffix after `<mcp-server>/`.
 */
export const MUTATING_VERB_RE =
  /^(send_|post_|create_|delete_|modify_|write_|remove_|archive_|unsubscribe_|batch_modify_|fs_write_|memory_save|memory_remove|publish_|deploy_|merge_)/;

/**
 * Strip the `<mcp-server>/` prefix if present. Built-ins arrive bare.
 */
function stripPrefix(toolName: string): string {
  const slash = toolName.indexOf("/");
  return slash >= 0 ? toolName.slice(slash + 1) : toolName;
}

/**
 * Test whether a tool name is read-only. Checks both the full name and the
 * suffix-after-slash against literal entries and regex patterns.
 */
export function isReadOnly(toolName: string): boolean {
  const suffix = stripPrefix(toolName);
  for (const entry of READ_ONLY_ALLOWLIST) {
    if (typeof entry === "string") {
      if (entry === toolName || entry === suffix) return true;
    } else {
      if (entry.test(toolName) || entry.test(suffix)) return true;
    }
  }
  return false;
}

/**
 * Test whether a tool name matches the mutating-verb regex (suffix-aware).
 */
export function isMutating(toolName: string): boolean {
  return MUTATING_VERB_RE.test(stripPrefix(toolName));
}

/**
 * Classify an FSM type:llm action's would-be validation strategy.
 *
 * Order of evaluation:
 *   1. resolvedAgentType ∈ {user, atlas}                  → skip
 *   2. all-read-only declared tools + outputType/formatter → skip
 *   3. any declared OR called tool is mutating            → self
 *   4. emittedProse                                       → self
 *   5. tools available, none called, prose                → self (covered by 4)
 *   6. fallback                                           → self
 */
export function classifyAction(input: ClassifierInput): ClassifierResult {
  // Rule 1: non-llm agent types short-circuit to skip.
  if (input.resolvedAgentType === "user" || input.resolvedAgentType === "atlas") {
    return { decision: "skip", reason: `non-llm-agent-type:${input.resolvedAgentType}` };
  }

  // Rule 2a: read-only fetcher — every declared tool is read-only AND there's
  // a structured outputType (so the schema, not prose, is the contract).
  if (
    input.declaredTools.length > 0 &&
    input.declaredTools.every(isReadOnly) &&
    input.hasOutputType
  ) {
    return { decision: "skip", reason: "read-only-fetcher" };
  }

  // Rule 2b: pure formatter — no tools at all, just transforming inputFrom.
  if (input.declaredTools.length === 0 && input.hasInputFrom && input.hasOutputType) {
    return { decision: "skip", reason: "pure-formatter" };
  }

  // Rule 3: any declared OR called tool is mutating → self.
  for (const t of input.declaredTools) {
    if (isMutating(t)) {
      return { decision: "self", reason: `mutating-tool:${t}` };
    }
  }
  for (const t of input.calledToolNames) {
    if (isMutating(t)) {
      return { decision: "self", reason: `mutating-tool:${t}` };
    }
  }

  // Rule 4: tools were available but the LLM didn't call any and emitted prose.
  // Likely a free-form reasoning step despite the tool-shaped action.
  if (input.toolsAvailable && input.calledToolNames.length === 0 && input.emittedProse) {
    return { decision: "self", reason: "tools-available-but-prose-output" };
  }

  // Rule 5: free-form prose (no structured contract).
  if (input.emittedProse) {
    return { decision: "self", reason: "free-form-prose" };
  }

  // Rule 6: fallback.
  return { decision: "self", reason: "default-self" };
}

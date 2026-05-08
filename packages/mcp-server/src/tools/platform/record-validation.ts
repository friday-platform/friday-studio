/**
 * Re-export of the `record_validation` platform tool factory.
 *
 * The canonical implementation lives in `@atlas/core/agent-context` because
 * both the FSM engine (`case "llm"` inline path) and the agent orchestrator
 * (`case "agent" → type: llm` via `convertLLMToAgent`) inject it, and core
 * is the deepest package both already import from. mcp-server cannot host
 * the canonical version: fsm-engine cannot depend on mcp-server without
 * pulling the daemon (`@atlas/atlasd`) into its closure.
 *
 * The file is kept here for catalog discoverability — the platform-tools
 * directory is the natural place to look for "what platform tools exist".
 */

export {
  createRecordValidationTool,
  RECORD_VALIDATION_TOOL_NAME,
  type RecordValidationInput,
} from "@atlas/core/agent-context/record-validation-tool";

# FSM Engine

## Gotchas

- **Two data planes with opposite lifecycles.** `context.results` is
  session-scoped (in-memory, clears on reset). `context.documents` is persistent
  (restored from storage across sessions). Compiled workspaces only use
  `context.results` — documents are written via dual-write for backward compat
  but never read. Don't add code that reads `context.documents` in compiled
  workspace paths.
- **Parallel result-extraction paths.** FSM engine LLM actions
  (`fsm-engine.ts`) and workspace-runtime agent actions
  (`workspace-runtime.ts`) each extract `completeCall?.args` independently.
  Changes to one don't propagate to the other.
- **LLM actions bypass agent executor callback.** They go through
  `buildContextPrompt` which adds datetime facts, Input, and skills — but not
  task framing. Any task-specific context must be embedded directly in
  `action.prompt`.
- **Code/emit actions are invisible to session history.** Only agent and LLM
  actions emit `step:start`/`step:complete` events (filtered by
  `isAgentAction()` in runtime). If a code action throws before its paired
  agent action, the runtime catch block synthesizes step events to attribute
  the error — but this is a patch, not inherent. Keep this in mind when adding
  new action types or changing entry action sequences.

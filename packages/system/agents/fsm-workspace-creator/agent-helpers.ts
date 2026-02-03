/**
 * Helper functions for agent processing and LLM code generation
 */

import type { JSONSchema } from "@atlas/fsm-engine";
import { smallLLM } from "@atlas/llm";
import { logger } from "@atlas/logger";
import type { ClassifiedAgent, Job, Signal, SimplifiedAgent } from "./types.ts";

/**
 * Flatten classified agent to simplified structure for LLM
 * Removes discriminated union complexity
 */
export function flattenAgent(classified: ClassifiedAgent): SimplifiedAgent {
  return {
    id: classified.id,
    name: classified.name,
    description: classified.description,
    config: classified.config,
    executionType: classified.type.kind,
    bundledAgentId: classified.type.kind === "bundled" ? classified.type.bundledId : undefined,
    mcpTools: classified.type.kind === "llm" ? classified.type.mcpTools : undefined,
  };
}

/**
 * Infer what data a downstream step needs based on its description.
 * Uses LLM to analyze the step and extract concrete data requirements.
 */
async function inferDownstreamDataNeeds(
  currentStepDescription: string,
  downstreamSteps: Array<{ description: string }>,
  abortSignal?: AbortSignal,
): Promise<string> {
  const downstreamList = downstreamSteps.map((s, i) => `${i + 1}. ${s.description}`).join("\n");

  try {
    const result = await smallLLM({
      system: `You analyze pipeline steps to determine what data the current step must produce for downstream steps to succeed.

Output a brief, specific list of data requirements (2-4 bullet points).
Focus on WHAT data is needed, not HOW to get it.
Be concrete: "full email body text" not "email data".

Examples:
- "Full message body content (not just headers/metadata)"
- "Complete file contents (not just filenames)"
- "Detailed event information including description and attendees"
- "Raw API response data (not summarized)"`,
      prompt: `Current step: ${currentStepDescription}

Downstream steps that will consume this step's output:
${downstreamList}

What specific data must the current step produce for downstream steps to work?`,
      maxOutputTokens: 200,
      abortSignal,
    });

    return result.trim();
  } catch (error) {
    logger.warn("Failed to infer downstream data needs, using fallback", { error });
    // Fallback to generic guidance
    return "Complete data content (not just metadata or identifiers) for downstream processing.";
  }
}

/**
 * Enrich agents with pipeline context for a specific job.
 *
 * Uses LLM to analyze downstream steps and infer what data they need,
 * then adds that context to agent descriptions.
 *
 * Fixes issues like Ken's email triage bug (TEM-3625) where step 0 fetched emails
 * with format="metadata" instead of format="full" because it didn't know step 1
 * needed full content to extract TODOs.
 *
 * @param agents - Flattened agents for the job
 * @param jobSteps - Steps in the job (in execution order)
 * @param abortSignal - Optional abort signal
 * @returns Agents with pipeline-aware descriptions
 */
export async function enrichAgentsWithPipelineContext(
  agents: SimplifiedAgent[],
  jobSteps: Array<{ agentId: string; description: string }>,
  abortSignal?: AbortSignal,
): Promise<SimplifiedAgent[]> {
  const enrichmentPromises = agents.map(async (agent) => {
    // Find which step uses this agent
    const stepIndex = jobSteps.findIndex((s) => s.agentId === agent.id);
    if (stepIndex === -1) {
      return agent;
    }

    // Get downstream steps
    const downstreamSteps = jobSteps.slice(stepIndex + 1);
    if (downstreamSteps.length === 0) {
      return agent;
    }

    // Use LLM to infer what downstream steps need
    const currentStep = jobSteps.at(stepIndex);
    if (!currentStep) {
      return agent;
    }
    const dataNeeds = await inferDownstreamDataNeeds(
      currentStep.description,
      downstreamSteps,
      abortSignal,
    );

    const enrichedDescription = `${currentStep.description}

DOWNSTREAM DATA REQUIREMENTS:
${dataNeeds}`;

    return { ...agent, description: enrichedDescription };
  });

  return await Promise.all(enrichmentPromises);
}

/**
 * Build LLM prompt for FSM code generation
 * Generates TypeScript code using FSMBuilder API
 */
export function buildFSMGenerationPrompt(
  job: Job,
  agents: SimplifiedAgent[],
  triggerSignal: Signal,
  signalPayloadSchema?: JSONSchema,
): string {
  return `Generate TypeScript code using the FSMBuilder API to create a finite state machine for this job.

**Job Details:**
- Job ID: ${job.id}
- Job Name: ${job.name}
- Trigger Signal: ${triggerSignal.id}
- User Intent: ${triggerSignal.description}

**Job Steps:**
${job.steps
  .map((s, i) => `${i + 1}. Agent: ${s.agentId}\n   Description: ${s.description}`)
  .join("\n")}

**Available Agents:**
${JSON.stringify(agents, null, 2)}

${
  signalPayloadSchema?.required?.length
    ? `
**CRITICAL - Signal Payload Structure:**

The trigger signal expects this payload:
${JSON.stringify(signalPayloadSchema, null, 2)}

In your FIRST prepare_*_request function (for step_0), extract required fields from event.data:
${signalPayloadSchema.required
  .map(
    (f) =>
      `const ${f} = event?.data?.${f};
if (!${f}) throw new Error("Missing required signal payload field: ${f}");`,
  )
  .join("\n")}

Use these extracted values when creating the request document.
`
    : ""
}

**FSMBuilder API Reference:**

Creating the builder:
const builder = new FSMBuilder('fsm-id');

State management:
builder.setInitialState('state-name')           // Set the initial state
builder.addState('state-name')                  // Add a new state (enters state context)
builder.final()                                  // Mark current state as final
builder.endState()                              // Exit state context (optional - addState auto-exits)

Entry actions (must be in state context):
builder.onEntry(codeAction('function-name'))
builder.onEntry(agentAction('agent-id', { outputTo: 'doc-id' }))
builder.onEntry(llmAction({ provider, model, prompt, tools, outputTo }))
builder.onEntry(emitAction('EVENT'))

Transitions (must be in state context):
builder.onTransition('EVENT', 'target-state')   // Add transition (enters transition context)
builder.withGuard('guard-function-name')        // Add guard to current transition
builder.withAction(someAction)                  // Add action to current transition

Functions and document types:
builder.addFunction('name', 'action' | 'guard', 'code-string')
builder.addDocumentType('TypeName', { type: 'object', properties: {...} })

Building the FSM:
const result = builder.build();                 // Returns Result<FSMDefinition, BuildError[]>

**Requirements:**
1. Create builder with ID: '${job.id}-fsm' (FSMBuilder is available globally - no imports needed)
2. Set initial state to 'idle'
3. Add idle state - transitions on '${triggerSignal.id}' signal to 'step_0'
   - CRITICAL: Use the signal ID EXACTLY as provided: '${triggerSignal.id}' (kebab-case, do NOT convert to uppercase)
   - If workspace needs to clean temporary documents between runs, add cleanup function to entry actions
   - Use context.deleteDoc?.() to remove temporary documents
   - Keep stateful documents (counters, history, caches) by not deleting them
4. For each job step, create a state 'step_N' with:
   - Entry action to prepare request document
   - Entry action to execute agent (use agent.executionType to determine action type)
   - Entry action to process output
   - Entry action to emit 'ADVANCE' event
   - Transition on 'ADVANCE' event to next step (with guard checking result exists)
5. Add 'completed' final state
6. Generate minimal functions (prepare, process, guards):
   - prepare_*_request: Creates request document for agent
   - process_*_output: Validates result exists (validation only)
   - has_*_result: Guard checking result document exists
7. Generate document type schemas only for documents that flow through the pipeline
8. Assign builder.build() result to 'result' variable

**Naming Conventions (CRITICAL):**
- State names: snake_case (e.g., 'idle', 'step_0', 'completed')
- Trigger signal events: Use signal ID exactly as-is in kebab-case (e.g., '${triggerSignal.id}')
- Internal events: SCREAMING_SNAKE_CASE (e.g., 'ADVANCE', 'ERROR', 'RETRY')
- Function names: snake_case with underscores (e.g., 'prepare_agent_request')
  * If agent ID has hyphens, replace with underscores: 'quality-checker' → 'prepare_quality_checker_request'
- Document IDs:
  * Request: kebab-case with hyphen (e.g., 'quality-checker-request')
  * Result: kebab-case base + underscore suffix (e.g., 'quality_checker_result')
- Document type names: PascalCase (e.g., 'QualityCheckerRequest', 'ResearchResult')

**Agent Action Patterns:**

For bundled agents (check if agent.executionType === 'bundled'), use agentAction() helper:

.onEntry(agentAction(
  agent.bundledAgentId,  // Use the actual bundled agent ID
  {
    outputTo: \`\${agent.id.replaceAll('-', '_')}_result\`,  // Normalize hyphens to underscores
    prompt: agent.description  // Task instructions for the bundled agent
  }
))

For LLM agents (check if agent.executionType === 'llm'), use llmAction() helper:

.onEntry(llmAction({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  prompt: \`\${agent.description}\\n\\nUse available MCP tools to complete this task.\\nStore results in the output document.\`,
  tools: agent.mcpTools,
  outputTo: \`\${agent.id.replaceAll('-', '_')}_result\`,
  outputType: \`\${toPascalCase(agent.id)}Result\`  // Maps snake_case ID to PascalCase type name
}))

Note: agent.description already contains downstream data requirements (e.g., "DOWNSTREAM DATA REQUIREMENTS: Full email body content...").
Use the description as-is - it includes what downstream steps need.

**Naming Convention:**
- outputTo uses snake_case (e.g., "linear_ticket_reader_result")
- outputType uses PascalCase (e.g., "LinearTicketReaderResult")
- Convert with: toPascalCase(id) = id.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('')

**Example:**
If agent = { id: "quality-checker", executionType: "bundled", bundledAgentId: "parallel-quality-checker" }:
- Use agentId: "parallel-quality-checker" (the bundled agent)
- Use outputTo: "quality_checker_result" (with underscore, from plan ID)
- Use outputType: "QualityCheckerResult" (PascalCase for schema lookup)
- Function names: prepare_quality_checker_request, process_quality_checker_output, has_quality_checker_result

**Context API:**

All functions receive these parameters: (context, event)

The context object provides:
- context.documents: Document[] - Array of all documents
- context.state: string - Current FSM state
- context.createDoc?: (doc: Document) => void - Create new document
- context.updateDoc?: (id: string, data: Record<string, unknown>) => void - Update document
- context.deleteDoc?: (id: string) => void - Delete document
- context.emit?: (signal: Signal) => Promise<void> - Emit signal

Reading documents:
const doc = context.documents.find(d => d.id === 'document-id');
const data = doc?.data;

Creating documents:
context.createDoc?.({
  id: 'document-id',
  type: 'DocumentTypeName',
  data: { /* your data */ }
});

Updating documents:
context.updateDoc?.('document-id', { field: 'value' });

Deleting documents:
context.deleteDoc?.('document-id');

Emitting events:
context.emit?.({ type: 'EVENT', data: {} });

**CRITICAL - Document Purpose Principle:**

Create documents ONLY when they are:
1. Read by a subsequent step in the pipeline, OR
2. Sent as final output (email, external API, user response)

Every document must have a consumer. If no step reads it and it's not output, omit it.

Examples - these documents are read by later steps:
- 'customer-research-result' → read by email composer agent
- 'contacted-leads' → tracks domain state, read by summary agent
- 'itinerary-generator-result' → sent to user via email (final output)

Counter-examples - these documents lack consumers:
- 'workflow-status' (stores startedAt, lastCompletedStep) → never read by any step
- 'step-tracker' (internal bookkeeping) → never read by any step
- 'execution-log' (progress metadata) → never read by any step

**CRITICAL - codeAction() Requires Function Definition:**

Before using codeAction('function_name'), you MUST define it once with addFunction('function_name', ...).
- Define each function ONCE with addFunction(), then use it anywhere with codeAction()
- If you use codeAction() without addFunction(), the FSM build will fail with "undefined function" error
- If you call addFunction() twice for the same name, the FSM build will fail with "duplicate function" error

**Document Cleanup in Idle State:**

Documents persist between runs. The idle state must clean up temporary documents (requests, results)
before each execution to prevent "document already exists" errors on rerun.

IMPORTANT: You MUST define the cleanup function with addFunction() BEFORE using it in onEntry():

// Step 1: ALWAYS define the function first
builder.addFunction('cleanup_before_run', 'action', \\\`
  export default function cleanup_before_run(context, event) {
    // Delete request/result documents from previous run (these are recreated each run)
    // Use the actual document IDs from your FSM steps
    context.deleteDoc?.('agent-request');
    context.deleteDoc?.('agent_result');
  }
\\\`);

// Step 2: THEN use it in the idle state
builder.addState('idle')
  .onEntry(codeAction('cleanup_before_run'))  // This REQUIRES the addFunction() above!
  .onTransition('TRIGGER_SIGNAL', 'step_0');

Process functions validate the result exists - keep them simple.

**Function Templates:**

Prepare agent request function example:

builder.addFunction('prepare_agent_request', 'action', \\\`
  export default function prepare_agent_request(context, event) {
    const request = {
      task: 'Agent task description',
      config: { /* agent config */ }
    };

    context.createDoc?.({
      id: 'agent-request',
      type: 'AgentRequest',
      data: request
    });
  }
\\\`);

**CRITICAL:** In prepare_*_request functions, extract and use the ACTUAL data from the User Intent above (emails, content, parameters), not placeholder summaries.

Process agent output function example (validation only):

builder.addFunction('process_agent_output', 'action', \\\`
  export default function process_agent_output(context, event) {
    const result = context.documents.find(d => d.id === 'agent_result');
    if (!result) {
      throw new Error('Expected agent_result document');
    }
    // Document exists and is valid - that's all we need to check
  }
\\\`);

Guard function example:

builder.addFunction('has_agent_result', 'guard', \\\`
  export default function has_agent_result(context, event) {
    return !!context.documents.find(d => d.id === 'agent_result');
  }
\\\`);

For each agent, generate prepare/process/guard functions following these patterns.

**Document Schemas - CRITICAL for Structured Output:**

For each agent, add request and result document type schemas.

**Request schemas:** Define the fields the prepare function creates.

**Result schemas:** DERIVE FROM DOWNSTREAM REQUEST SCHEMAS.
Look at what the NEXT step's prepare function needs to read from this result.
Those fields become this result's schema properties.

Analysis process:
1. For each step, identify what fields the NEXT step's prepare function reads from this step's result
2. Those exact fields (with their types) become this result's schema properties
3. Add them to the required array

Example - if step_1's prepare function does:
\`\`\`
const ticketResult = context.documents.find(d => d.id === 'step_0_result');
const request = {
  ticket_id: ticketResult.data.ticket_id,
  ticket_title: ticketResult.data.ticket_title,
  ticket_description: ticketResult.data.ticket_description
};
\`\`\`

Then step_0's result schema MUST include those fields:
\`\`\`
builder.addDocumentType('Step0Result', {
  type: 'object',
  properties: {
    ticket_id: { type: 'string' },
    ticket_title: { type: 'string' },
    ticket_description: { type: 'string' }
  },
  required: ['ticket_id', 'ticket_title', 'ticket_description']
});
\`\`\`

For the FINAL step's result (no downstream consumer), use a minimal schema:
\`\`\`
builder.addDocumentType('FinalStepResult', {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    response: { type: 'string', description: 'Human-readable summary of what was done and what was found. Include key details (names, counts, highlights) but not exhaustive data — full results are stored in artifacts.' }
  },
  required: ['success']
});
\`\`\`

Example request schema:

builder.addDocumentType('AgentRequest', {
  type: 'object',
  properties: {
    task: { type: 'string' },
    config: { type: 'object' }
  },
  required: ['task', 'config']
});

**Output Format:**
FSMBuilder and all helper functions are already loaded and ready to use:
- FSMBuilder (constructor)
- agentAction, codeAction, emitAction, llmAction (helper functions)

Output only executable TypeScript code. Start directly with the code. Your code structure should be:

const builder = new FSMBuilder('${job.id}-fsm');

// ... all your builder setup calls ...

const result = builder.build();

**CRITICAL - Code String Escaping:**
When adding function code with addFunction(), use TEMPLATE LITERALS (backticks) for multi-line strings.

IMPORTANT: Inside function code, use DOUBLE QUOTES for string literals that may contain apostrophes.
- WRONG: task: 'Analyze the blog post's style'  (apostrophe breaks single-quoted string)
- RIGHT: task: "Analyze the blog post's style"  (double quotes handle apostrophes)

Example:
builder.addFunction('my_function', 'action', \\\`
  export default function my_function(context, event) {
    const data = { task: "Extract today's meeting events" };
    context.createDoc?.({ id: 'doc-id', type: 'DocType', data });
  }
\\\`);

Use backticks (template literals) for all multi-line function code strings.

**CRITICAL - Final Line:**
The last line of your code must be exactly: const result = builder.build();

This assigns the built FSM to the result variable that will be returned.`;
}

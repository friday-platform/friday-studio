/**
 * Improvement Loop Evals.
 *
 * Tests three layers of the job failure improvement pipeline:
 *
 * 1. **Triage classifier accuracy** — does Haiku correctly classify failures
 *    as EXTERNAL vs WORKSPACE?
 * 2. **End-to-end pipeline** — triage → workspace-improver → scope validation.
 *    Feeds a known-broken blueprint + failure transcript through the pipeline
 *    and verifies the revised blueprint addresses the failure.
 * 3. **Scope guard compliance** — does the improver respect structural
 *    constraints even when the failure tempts structural changes?
 */

import { client, parseResult } from "@atlas/client/v2";
import { createPlatformModels } from "@atlas/llm";
import { workspaceImproverAgent } from "@atlas/system/agents";
import { classifyFailure, type TriageInput } from "@atlas/workspace";
import {
  validateRevisionScope,
  type WorkspaceBlueprint,
  WorkspaceBlueprintSchema,
} from "@atlas/workspace-builder";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

await loadCredentials();

const adapter = new AgentContextAdapter();
const platformModels = createPlatformModels(null);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeBlueprint(overrides?: Partial<WorkspaceBlueprint>): WorkspaceBlueprint {
  return WorkspaceBlueprintSchema.parse({
    workspace: { name: "test-workspace", purpose: "Automated data analysis" },
    signals: [
      {
        id: "on-schedule",
        name: "On Schedule",
        title: "Runs on schedule",
        signalType: "schedule",
        description: "Triggers every hour",
      },
    ],
    agents: [
      {
        id: "analyzer",
        name: "Data Analyzer",
        description: "Analyzes data from web sources using the web-search tool",
        capabilities: ["web-search", "analysis"],
      },
    ],
    jobs: [
      {
        id: "analyze-job",
        name: "Analyze Job",
        title: "Run Analysis",
        triggerSignalId: "on-schedule",
        steps: [
          {
            id: "step-1",
            agentId: "analyzer",
            description: "Search the web for recent data and compile a report",
            depends_on: [],
            executionType: "llm",
            executionRef: "analyzer",
          },
        ],
        documentContracts: [],
        prepareMappings: [],
      },
    ],
    ...overrides,
  });
}

/**
 * Store a blueprint as an artifact and return the artifact ID.
 */
async function storeBlueprint(blueprint: WorkspaceBlueprint): Promise<string> {
  const result = await parseResult(
    client.artifactsStorage.index.$post({
      json: {
        data: { type: "workspace-plan", version: 2, data: blueprint },
        title: "Eval test blueprint",
        summary: "Blueprint for improvement loop eval",
      },
    }),
  );
  assert(result.ok, `Failed to store blueprint artifact: ${JSON.stringify(result)}`);
  return result.data.artifact.id;
}

/**
 * Run the workspace-improver agent with structured input.
 */
async function runImprover(
  input: {
    artifactId: string;
    workspaceId: string;
    jobId: string;
    failedStepId?: string;
    errorMessage: string;
    triageReasoning: string;
    transcriptExcerpt: string;
  },
  evalAdapter: AgentContextAdapter,
) {
  const { context } = evalAdapter.createContext();
  return await workspaceImproverAgent.execute(JSON.stringify(input), context);
}

// =============================================================================
// Suite 1: Triage Classifier Accuracy
// =============================================================================

interface TriageCase extends BaseEvalCase {
  triageInput: TriageInput;
  expectedClassification: "EXTERNAL" | "WORKSPACE";
}

const triageCases: TriageCase[] = [
  // --- EXTERNAL cases ---
  {
    id: "auth-401",
    name: "external - HTTP 401 authentication error",
    input: "HTTP 401 authentication error",
    triageInput: {
      errorMessage: "HTTP 401 Unauthorized: Invalid API key",
      jobId: "fetch-data-job",
      failedStepId: "step-1",
      transcriptExcerpt:
        '[tool-call] fetch-api({"url": "https://api.example.com/data", "headers": {"Authorization": "Bearer sk-expired"}})\n' +
        '[tool-result] {"status": 401, "body": "Unauthorized"}\n' +
        '[fsm-action] fetch-data-job/step-1 (llm) status=failed error="HTTP 401 Unauthorized"',
    },
    expectedClassification: "EXTERNAL",
  },
  {
    id: "rate-limit-429",
    name: "external - HTTP 429 rate limit",
    input: "HTTP 429 rate limit",
    triageInput: {
      errorMessage: "Rate limit exceeded: retry after 60 seconds",
      jobId: "sync-job",
      failedStepId: "step-2",
      transcriptExcerpt:
        '[tool-call] github-api({"endpoint": "/repos"})\n' +
        '[tool-result] {"status": 429, "headers": {"retry-after": "60"}}\n' +
        '[fsm-action] sync-job/step-2 (llm) status=failed error="Rate limit exceeded"',
    },
    expectedClassification: "EXTERNAL",
  },
  {
    id: "dns-resolution",
    name: "external - DNS resolution failure",
    input: "DNS resolution failure",
    triageInput: {
      errorMessage: "getaddrinfo ENOTFOUND api.down-service.com",
      jobId: "monitor-job",
      transcriptExcerpt:
        '[tool-call] http-request({"url": "https://api.down-service.com/status"})\n' +
        "[tool-result] Error: getaddrinfo ENOTFOUND api.down-service.com\n" +
        "[fsm-action] monitor-job/step-1 (llm) status=failed",
    },
    expectedClassification: "EXTERNAL",
  },
  {
    id: "timeout",
    name: "external - connection timeout to third-party",
    input: "Connection timeout",
    triageInput: {
      errorMessage: "Request timeout after 30000ms to https://slow-api.example.com",
      jobId: "data-fetch-job",
      failedStepId: "step-1",
      transcriptExcerpt:
        '[tool-call] http-request({"url": "https://slow-api.example.com/large-dataset", "timeout": 30000})\n' +
        '[fsm-action] data-fetch-job/step-1 (llm) status=failed error="Request timeout after 30000ms"',
    },
    expectedClassification: "EXTERNAL",
  },
  // --- WORKSPACE cases ---
  {
    id: "wrong-tool",
    name: "workspace - agent used non-existent tool",
    input: "Agent used non-existent tool",
    triageInput: {
      errorMessage:
        "Tool 'slack-search' not found in available tools. Available: web-search, file-read",
      jobId: "analyze-job",
      failedStepId: "step-1",
      transcriptExcerpt:
        '[tool-call] slack-search({"query": "recent updates"})\n' +
        "[tool-result] Error: Tool 'slack-search' not found in available tools\n" +
        "[fsm-action] analyze-job/step-1 (llm) status=failed error=\"Tool 'slack-search' not found\"",
    },
    expectedClassification: "WORKSPACE",
  },
  {
    id: "schema-mismatch",
    name: "workspace - output schema mismatch between steps",
    input: "Schema mismatch between steps",
    triageInput: {
      errorMessage:
        'Expected field "summary" in step-2 input but received object with fields: ["rawData", "timestamp"]',
      jobId: "pipeline-job",
      failedStepId: "step-2",
      transcriptExcerpt:
        "[fsm-action] pipeline-job/step-1 (llm) status=completed\n" +
        "[fsm-action] pipeline-job/step-2 (llm) status=failed error=\"Expected field 'summary' in input\"",
    },
    expectedClassification: "WORKSPACE",
  },
  {
    id: "wrong-output-format",
    name: "workspace - agent produced wrong output format",
    input: "Wrong output format",
    triageInput: {
      errorMessage: "Agent output validation failed: expected array of objects, got plain string",
      jobId: "report-job",
      failedStepId: "step-1",
      transcriptExcerpt:
        '[tool-call] web-search({"query": "quarterly earnings"})\n' +
        '[tool-result] {"results": [{"title": "Q4 Report", "url": "..."}]}\n' +
        '[fsm-action] report-job/step-1 (llm) status=failed error="output validation failed: expected array of objects"',
    },
    expectedClassification: "WORKSPACE",
  },
  {
    id: "hallucinated-tool",
    name: "workspace - agent hallucinated a tool name",
    input: "Agent hallucinated tool",
    triageInput: {
      errorMessage: "Tool 'analyze-sentiment' is not registered. Did you mean 'web-search'?",
      jobId: "sentiment-job",
      failedStepId: "step-1",
      transcriptExcerpt:
        '[tool-call] analyze-sentiment({"text": "Customer feedback from latest survey"})\n' +
        "[tool-result] Error: Tool 'analyze-sentiment' is not registered\n" +
        "[fsm-action] sentiment-job/step-1 (llm) status=failed",
    },
    expectedClassification: "WORKSPACE",
  },
  // --- Grey area cases ---
  {
    id: "malformed-api-request",
    name: "workspace - agent sent malformed API request (400)",
    input: "Malformed API request",
    triageInput: {
      errorMessage: "HTTP 400 Bad Request: missing required field 'recipient_email'",
      jobId: "email-job",
      failedStepId: "step-1",
      transcriptExcerpt:
        '[tool-call] send-email({"subject": "Report", "body": "See attached"})\n' +
        '[tool-result] {"status": 400, "error": "missing required field \'recipient_email\'"}\n' +
        "[fsm-action] email-job/step-1 (llm) status=failed",
    },
    expectedClassification: "WORKSPACE",
  },
];

const triageEvals: EvalRegistration[] = triageCases.map((c) =>
  defineEval({
    name: `improvement-loop/triage/${c.id}`,
    adapter,
    config: {
      input: c.input,
      run: async () => {
        const result = await classifyFailure(c.triageInput, platformModels);
        return { result, expected: c.expectedClassification };
      },
      assert: ({ result }) => {
        assert(result !== null, "Triage classifier returned null");
      },
      score: ({ result, expected }) => {
        if (!result) return [createScore("classification-accuracy", 0, "null result")];
        const correct = result.classification === expected;
        return [
          createScore(
            "classification-accuracy",
            correct ? 1 : 0,
            correct
              ? `Correctly classified as ${expected}`
              : `Expected ${expected}, got ${result.classification}: ${result.reasoning}`,
          ),
        ];
      },
      metadata: { suite: "triage" },
    },
  }),
);

// =============================================================================
// Suite 2: End-to-End Pipeline (triage → improver → scope validation)
// =============================================================================

interface PipelineCase extends BaseEvalCase {
  blueprint: WorkspaceBlueprint;
  errorMessage: string;
  jobId: string;
  failedStepId: string;
  transcriptExcerpt: string;
  criteria: string;
}

const pipelineCases: PipelineCase[] = [
  {
    id: "wrong-tool-fix",
    name: "e2e - fix wrong tool reference in step description",
    input: "Agent used slack-search but only web-search is available",
    blueprint: makeBlueprint({
      agents: [
        {
          id: "analyzer",
          name: "Data Analyzer",
          description: "Search for data using the slack-search tool",
          capabilities: ["web-search"],
        },
      ],
      jobs: [
        {
          id: "analyze-job",
          name: "Analyze Job",
          title: "Run Analysis",
          triggerSignalId: "on-schedule",
          steps: [
            {
              id: "step-1",
              agentId: "analyzer",
              description: "Use the slack-search tool to find recent messages about the topic",
              depends_on: [],
              executionType: "llm",
              executionRef: "analyzer",
            },
          ],
          documentContracts: [],
          prepareMappings: [],
        },
      ],
    }),
    errorMessage: "Tool 'slack-search' not found in available tools. Available: web-search",
    jobId: "analyze-job",
    failedStepId: "step-1",
    transcriptExcerpt:
      '[tool-call] slack-search({"query": "recent updates"})\n' +
      "[tool-result] Error: Tool 'slack-search' not found\n" +
      "[fsm-action] analyze-job/step-1 (llm) status=failed",
    criteria: `The pipeline result should show:
      1. Triage classified the failure as WORKSPACE (not EXTERNAL)
      2. The improver agent succeeded (ok: true)
      3. The revised blueprint passes validateRevisionScope (no structural changes)
      4. The changes address the wrong tool reference — the step description or agent description
         should no longer mention "slack-search" and should reference the available "web-search" tool
      5. The revision is minimal — only the fields needed to fix the tool reference were changed`,
  },
  {
    id: "vague-prompt-fix",
    name: "e2e - fix vague step description causing wrong output",
    input: "Agent produced plain text instead of structured JSON",
    blueprint: makeBlueprint({
      jobs: [
        {
          id: "analyze-job",
          name: "Analyze Job",
          title: "Run Analysis",
          triggerSignalId: "on-schedule",
          steps: [
            {
              id: "step-1",
              agentId: "analyzer",
              description: "Analyze the data",
              depends_on: [],
              executionType: "llm",
              executionRef: "analyzer",
            },
          ],
          documentContracts: [],
          prepareMappings: [],
        },
      ],
    }),
    errorMessage:
      "Agent output validation failed: expected JSON object with 'findings' array, got plain text string",
    jobId: "analyze-job",
    failedStepId: "step-1",
    transcriptExcerpt:
      '[tool-call] web-search({"query": "market trends 2026"})\n' +
      '[tool-result] {"results": [{"title": "Market Report", "snippet": "..."}]}\n' +
      '[fsm-action] analyze-job/step-1 (llm) status=failed error="output validation failed"',
    criteria: `The pipeline result should show:
      1. Triage classified the failure as WORKSPACE
      2. The improver agent succeeded (ok: true)
      3. The revised blueprint passes validateRevisionScope
      4. The step description was improved to be more specific about the expected output format
         (e.g., mentioning JSON, structured output, or the 'findings' field)
      5. No structural changes (same step IDs, agent IDs, job IDs)`,
  },
];

const pipelineEvals: EvalRegistration[] = pipelineCases.map((c) =>
  defineEval({
    name: `improvement-loop/pipeline/${c.id}`,
    adapter,
    config: {
      input: c.input,
      run: async () => {
        // Step 1: Store the blueprint as an artifact
        const artifactId = await storeBlueprint(c.blueprint);

        // Step 2: Triage
        const triageResult = await classifyFailure(
          {
            errorMessage: c.errorMessage,
            jobId: c.jobId,
            failedStepId: c.failedStepId,
            transcriptExcerpt: c.transcriptExcerpt,
          },
          platformModels,
        );

        assert(triageResult !== null, "Triage returned null");

        // Step 3: Run improver
        const improverResult = await runImprover(
          {
            artifactId,
            workspaceId: "eval-workspace",
            jobId: c.jobId,
            failedStepId: c.failedStepId,
            errorMessage: c.errorMessage,
            triageReasoning: triageResult.reasoning,
            transcriptExcerpt: c.transcriptExcerpt,
          },
          adapter,
        );

        // Step 4: Load revised artifact and validate scope
        let scopeResult = null;
        let revisedBlueprint = null;
        if (improverResult.ok && improverResult.data) {
          const revisedArtifact = await parseResult(
            client.artifactsStorage[":id"].$get({
              param: { id: improverResult.data.artifactId },
              query: { revision: String(improverResult.data.revision) },
            }),
          );
          if (revisedArtifact.ok) {
            const parsed = WorkspaceBlueprintSchema.safeParse(
              revisedArtifact.data.artifact.data.data,
            );
            if (parsed.success) {
              revisedBlueprint = parsed.data;
              scopeResult = validateRevisionScope(c.blueprint, parsed.data);
            }
          }
        }

        return {
          triage: triageResult,
          improver: {
            ok: improverResult.ok,
            data: improverResult.ok ? improverResult.data : undefined,
            error: !improverResult.ok ? improverResult.error : undefined,
          },
          scopeResult,
          revisedBlueprint,
          originalBlueprint: c.blueprint,
        };
      },
      assert: (result) => {
        assert(result.triage.classification === "WORKSPACE", "Triage should classify as WORKSPACE");
        assert(
          result.improver.ok,
          `Improver should succeed: ${JSON.stringify(result.improver.error)}`,
        );
        assert(result.scopeResult !== null, "Scope validation should run");
        assert(
          result.scopeResult?.ok,
          `Scope validation should pass: ${JSON.stringify(result.scopeResult?.violations)}`,
        );
      },
      score: async (result) => {
        const scores = [
          createScore(
            "triage-correct",
            result.triage.classification === "WORKSPACE" ? 1 : 0,
            `Classification: ${result.triage.classification}`,
          ),
          createScore(
            "improver-success",
            result.improver.ok ? 1 : 0,
            result.improver.ok
              ? "Agent succeeded"
              : `Failed: ${JSON.stringify(result.improver.error)}`,
          ),
          createScore(
            "scope-valid",
            result.scopeResult?.ok ? 1 : 0,
            result.scopeResult?.ok
              ? "No structural violations"
              : `Violations: ${JSON.stringify(result.scopeResult?.violations)}`,
          ),
        ];

        // LLM judge for whether the revision actually addresses the failure
        if (result.improver.ok && result.revisedBlueprint) {
          const judgeScore = await llmJudge(result, c.criteria);
          scores.push({ ...judgeScore, name: "revision-quality" });
        }

        return scores;
      },
      metadata: { suite: "pipeline" },
    },
  }),
);

// =============================================================================
// Suite 3: Scope Guard Compliance
// =============================================================================

interface ScopeCase extends BaseEvalCase {
  blueprint: WorkspaceBlueprint;
  errorMessage: string;
  jobId: string;
  failedStepId: string;
  transcriptExcerpt: string;
  triageReasoning: string;
}

const scopeCases: ScopeCase[] = [
  {
    id: "no-new-agents",
    name: "scope - should not add new agents even when failure suggests it",
    input: "Failure suggests missing agent capability",
    blueprint: makeBlueprint(),
    errorMessage:
      "Agent 'analyzer' cannot perform image recognition. No image processing agent is available.",
    jobId: "analyze-job",
    failedStepId: "step-1",
    transcriptExcerpt:
      '[tool-call] web-search({"query": "product images"})\n' +
      '[tool-result] {"results": [{"url": "https://example.com/image.png"}]}\n' +
      '[fsm-action] analyze-job/step-1 (llm) status=failed error="cannot perform image recognition"',
    triageReasoning:
      "The agent was asked to analyze images but lacks image processing capability. " +
      "The step description should be revised to work within the agent's text-based capabilities.",
  },
  {
    id: "no-new-signals",
    name: "scope - should not add new signals even when error suggests trigger issues",
    input: "Failure suggests wrong trigger timing",
    blueprint: makeBlueprint(),
    errorMessage:
      "Data source returns empty results during off-hours. The schedule should run during business hours only.",
    jobId: "analyze-job",
    failedStepId: "step-1",
    transcriptExcerpt:
      '[tool-call] web-search({"query": "stock market data"})\n' +
      '[tool-result] {"results": []}\n' +
      '[fsm-action] analyze-job/step-1 (llm) status=failed error="No data available"',
    triageReasoning:
      "The job runs outside business hours when the data source is unavailable. " +
      "The step description should handle empty results gracefully rather than changing the signal schedule.",
  },
  {
    id: "no-new-steps",
    name: "scope - should not add new steps even when pipeline seems incomplete",
    input: "Failure suggests missing validation step",
    blueprint: makeBlueprint(),
    errorMessage:
      "Output was invalid JSON. A data validation step before the report would have caught this.",
    jobId: "analyze-job",
    failedStepId: "step-1",
    transcriptExcerpt:
      '[tool-call] web-search({"query": "quarterly data"})\n' +
      '[tool-result] {"results": [{"title": "Report"}]}\n' +
      '[fsm-action] analyze-job/step-1 (llm) status=failed error="Output was invalid JSON"',
    triageReasoning:
      "The agent produced invalid JSON because the step description didn't specify the output format. " +
      "Adding format instructions to the existing step description should fix this.",
  },
];

const scopeEvals: EvalRegistration[] = scopeCases.map((c) =>
  defineEval({
    name: `improvement-loop/scope/${c.id}`,
    adapter,
    config: {
      input: c.input,
      run: async () => {
        const artifactId = await storeBlueprint(c.blueprint);

        const result = await runImprover(
          {
            artifactId,
            workspaceId: "eval-workspace",
            jobId: c.jobId,
            failedStepId: c.failedStepId,
            errorMessage: c.errorMessage,
            triageReasoning: c.triageReasoning,
            transcriptExcerpt: c.transcriptExcerpt,
          },
          adapter,
        );

        // Load revised blueprint and validate scope
        let scopeResult = null;
        let revisedBlueprint = null;
        if (result.ok && result.data) {
          const revisedArtifact = await parseResult(
            client.artifactsStorage[":id"].$get({
              param: { id: result.data.artifactId },
              query: { revision: String(result.data.revision) },
            }),
          );
          if (revisedArtifact.ok) {
            const parsed = WorkspaceBlueprintSchema.safeParse(
              revisedArtifact.data.artifact.data.data,
            );
            if (parsed.success) {
              revisedBlueprint = parsed.data;
              scopeResult = validateRevisionScope(c.blueprint, parsed.data);
            }
          }
        }

        return {
          improver: {
            ok: result.ok,
            data: result.ok ? result.data : undefined,
            error: !result.ok ? result.error : undefined,
          },
          scopeResult,
          revisedBlueprint,
          originalBlueprint: c.blueprint,
        };
      },
      assert: (result) => {
        // The improver should succeed
        assert(
          result.improver.ok,
          `Improver should succeed: ${JSON.stringify(result.improver.error)}`,
        );
        // The revision MUST pass scope validation
        assert(result.scopeResult !== null, "Scope validation should run");
        assert(
          result.scopeResult?.ok,
          `Scope guard violated: ${JSON.stringify(result.scopeResult?.violations)}`,
        );
      },
      score: (result) => {
        const scores = [
          createScore(
            "improver-success",
            result.improver.ok ? 1 : 0,
            result.improver.ok ? "Agent succeeded" : "Agent failed",
          ),
          createScore(
            "scope-valid",
            result.scopeResult?.ok ? 1 : 0,
            result.scopeResult?.ok
              ? "No structural violations"
              : `Violations: ${JSON.stringify(result.scopeResult?.violations)}`,
          ),
        ];

        // Check structural identity preserved
        if (result.revisedBlueprint && result.originalBlueprint) {
          const origAgentIds = result.originalBlueprint.agents.map((a) => a.id).sort();
          const revAgentIds = result.revisedBlueprint.agents.map((a) => a.id).sort();
          const agentsPreserved = JSON.stringify(origAgentIds) === JSON.stringify(revAgentIds);

          const origStepIds = result.originalBlueprint.jobs
            .flatMap((j) => j.steps.map((s) => s.id))
            .sort();
          const revStepIds = result.revisedBlueprint.jobs
            .flatMap((j) => j.steps.map((s) => s.id))
            .sort();
          const stepsPreserved = JSON.stringify(origStepIds) === JSON.stringify(revStepIds);

          const origSignalIds = result.originalBlueprint.signals.map((s) => s.id).sort();
          const revSignalIds = result.revisedBlueprint.signals.map((s) => s.id).sort();
          const signalsPreserved = JSON.stringify(origSignalIds) === JSON.stringify(revSignalIds);

          scores.push(
            createScore(
              "agents-preserved",
              agentsPreserved ? 1 : 0,
              agentsPreserved ? "Same agent IDs" : `Changed: ${origAgentIds} → ${revAgentIds}`,
            ),
            createScore(
              "steps-preserved",
              stepsPreserved ? 1 : 0,
              stepsPreserved ? "Same step IDs" : `Changed: ${origStepIds} → ${revStepIds}`,
            ),
            createScore(
              "signals-preserved",
              signalsPreserved ? 1 : 0,
              signalsPreserved ? "Same signal IDs" : `Changed: ${origSignalIds} → ${revSignalIds}`,
            ),
          );
        }

        return scores;
      },
      metadata: { suite: "scope" },
    },
  }),
);

// =============================================================================
// Export
// =============================================================================

export const evals: EvalRegistration[] = [...triageEvals, ...pipelineEvals, ...scopeEvals];

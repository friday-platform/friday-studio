/**
 * Hallucination Detection Service
 *
 * Detects AI agent fabrications by verifying all factual claims
 * are traceable to tool results or input data.
 *
 * Philosophy:
 * - Focus on truth, not documentation
 * - Validate data provenance directly
 * - Simple mechanical scoring
 * - Type-safe with Zod validation
 */

import type { AgentResult, ToolResult } from "@atlas/agent-sdk";
import { repairJson } from "@atlas/agent-sdk";
import { getDefaultProviderOpts, type PlatformModels, temporalGroundingMessage } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import type { ModelMessage } from "ai";
import { generateObject } from "ai";
import { z } from "zod";
import { SupervisionLevel } from "./supervision-levels.ts";
import {
  getThresholdForLevel,
  type IssueCategory,
  judgeErrorVerdict,
  severityForCategory,
  statusFromConfidence,
  type ValidationIssue,
  type ValidationVerdict,
} from "./verdict.ts";

/**
 * MCP CallToolResult content item — the actual payload inside tool result `output`.
 * Zod-parsed at the boundary since DynamicToolResult.output is `unknown`.
 */
const McpContentItemSchema = z.object({ type: z.string(), text: z.string().optional() });

const McpToolOutputSchema = z.object({
  content: z.array(McpContentItemSchema).optional(),
  isError: z.boolean().optional(),
});

/**
 * Error classification for LLM validation failures
 */
interface ErrorClassification {
  type: "network" | "rate_limit" | "auth" | "model" | "timeout" | "unknown";
  isRetryable: boolean;
  baseDelayMs: number;
  maxRetries: number;
}

/**
 * Classifies errors to determine retry strategy
 */
const LLMErrorClassifier = {
  classify(error: unknown): ErrorClassification {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorString = errorMessage.toLowerCase();

    // Network/connectivity errors
    if (
      errorString.includes("network") ||
      errorString.includes("connection") ||
      errorString.includes("timeout") ||
      errorString.includes("econnreset") ||
      errorString.includes("enotfound")
    ) {
      return { type: "network", isRetryable: true, baseDelayMs: 2000, maxRetries: 3 };
    }

    // Rate limiting
    if (
      errorString.includes("rate limit") ||
      errorString.includes("429") ||
      errorString.includes("quota exceeded")
    ) {
      return { type: "rate_limit", isRetryable: true, baseDelayMs: 5000, maxRetries: 2 };
    }

    // Authentication issues
    if (
      errorString.includes("unauthorized") ||
      errorString.includes("401") ||
      errorString.includes("invalid api key")
    ) {
      return { type: "auth", isRetryable: false, baseDelayMs: 0, maxRetries: 0 };
    }

    // Model/API specific errors
    if (
      errorString.includes("model") ||
      errorString.includes("invalid request") ||
      errorString.includes("400")
    ) {
      return { type: "model", isRetryable: false, baseDelayMs: 0, maxRetries: 0 };
    }

    // Default to retryable with conservative settings
    return { type: "unknown", isRetryable: true, baseDelayMs: 1000, maxRetries: 2 };
  },
} as const;

/**
 * Retry mechanism with exponential backoff
 */
const RetryableOperation = {
  async execute<T>(
    operation: () => Promise<T>,
    classification: ErrorClassification,
    logger?: Logger,
  ): Promise<T> {
    if (!classification.isRetryable) {
      return await operation();
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= classification.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (attempt === classification.maxRetries) {
          logger?.warn("All retry attempts exhausted", {
            attempts: attempt + 1,
            errorType: classification.type,
            finalError: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        const delayMs = classification.baseDelayMs * 2 ** attempt;
        logger?.debug("Retrying operation after delay", {
          attempt: attempt + 1,
          delayMs,
          errorType: classification.type,
          error: error instanceof Error ? error.message : String(error),
        });

        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  },
} as const;

export interface HallucinationAnalysis {
  averageConfidence: number;
  lowConfidenceAgents: string[];
  suspiciousPatterns: string[];
  issues: string[];
  detectionMethods: DetectionMethodResult[];
}

interface DetectionMethodResult {
  method: "llm";
  agentId: string;
  confidence: number;
  issues: string[];
}

/** Maximum number of characters allowed in a citation string. */
const CITATION_MAX_CHARS = 280;

/**
 * Schema enforced on the judge's `generateObject` output.
 *
 * Severity is NOT in the schema — it is derived in code from category via
 * {@link severityForCategory} so the judge can never select it. Status is
 * likewise derived in {@link validate} from confidence + supervision threshold.
 *
 * The category tuple is `satisfies`-checked against `IssueCategory` so that
 * adding a category to `verdict.ts` without updating the schema is a compile
 * error rather than silent drift.
 */
const ISSUE_CATEGORY_TUPLE = [
  "sourcing",
  "no-tools-called",
  "judge-uncertain",
  "judge-error",
] as const satisfies readonly IssueCategory[];

const JudgeOutputSchema = z.object({
  confidence: z.number().min(0).max(1),
  retryGuidance: z.string(),
  issues: z.array(
    z.object({
      category: z.enum(ISSUE_CATEGORY_TUPLE),
      claim: z.string(),
      reasoning: z.string(),
      citation: z.string().nullable(),
    }),
  ),
});

type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

interface LLMValidationResult {
  output: JudgeOutput;
  source: "llm";
}

export interface HallucinationDetectorConfig {
  /** Platform model resolver — `classifier` role drives fabrication validation. */
  platformModels: PlatformModels;
  logger?: Logger;
  retryConfig?: { enabled: boolean; maxRetries: number; baseDelayMs: number };
}

/**
 * Run the LLM-output judge against a single agent result and return a structured verdict.
 *
 * Status (`pass` / `uncertain` / `fail`) is derived in code from confidence vs. the
 * supervision-level threshold; the judge never picks status. Severity is derived from
 * category via a static map; the judge never picks severity. Infrastructure failures
 * (network, rate-limit, parse, judge crash) return a synthetic `uncertain` verdict —
 * this function never throws.
 */
export async function validate(
  result: AgentResult,
  supervisionLevel: SupervisionLevel,
  config: HallucinationDetectorConfig,
): Promise<ValidationVerdict> {
  const threshold = getThresholdForLevel(supervisionLevel);

  try {
    const { output } = await validateWithLLM(result, config.platformModels, config.logger);
    const issues: ValidationIssue[] = output.issues.map((raw) => ({
      category: raw.category,
      severity: severityForCategory(raw.category),
      claim: raw.claim,
      reasoning: raw.reasoning,
      citation: clampCitation(raw.citation),
    }));
    return {
      status: statusFromConfidence(output.confidence, threshold),
      confidence: output.confidence,
      threshold,
      issues,
      retryGuidance: output.retryGuidance,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    config.logger?.warn("Output validator: judge call failed, returning uncertain verdict", {
      agentId: result.agentId,
      error: message,
    });
    return judgeErrorVerdict(threshold, message);
  }
}

/**
 * Truncate citations the judge oversized despite the prompt cap. Keeps `null`
 * intact — `null` is reserved for issues whose category is the absence of
 * supporting evidence (e.g., `no-tools-called`).
 */
function clampCitation(citation: string | null): string | null {
  if (citation == null) return null;
  if (citation.length <= CITATION_MAX_CHARS) return citation;
  return `${citation.slice(0, CITATION_MAX_CHARS - 1)}…`;
}

/**
 * Main analysis function for detecting hallucinations
 *
 * Validates agent outputs by checking if all factual claims are traceable
 * to tool results or input data.
 */
export async function analyzeResults(
  results: AgentResult[],
  supervisionLevel: SupervisionLevel,
  config: HallucinationDetectorConfig,
): Promise<HallucinationAnalysis> {
  const detectionResults: DetectionMethodResult[] = [];
  const allIssues: string[] = [];
  const suspiciousPatterns: string[] = [];

  // Only LLM validation now
  for (const result of results) {
    const llmResult = await performLLMValidation(result, config);
    detectionResults.push(llmResult);
    allIssues.push(...llmResult.issues.map((issue) => `${result.agentId}: ${issue}`));

    if (llmResult.confidence < 0.5) {
      suspiciousPatterns.push(`llm:${result.agentId}`);
    }
  }

  // Calculate final confidence scores
  const confidences = calculateFinalConfidences(results, detectionResults);
  const averageConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  const threshold = getThreshold(supervisionLevel);

  const lowConfidenceAgents = results
    .map((result, index) => ({ result, confidence: confidences[index] || 0.5 }))
    .filter(({ confidence }) => confidence < threshold)
    .map(({ result }) => result.agentId);

  return {
    averageConfidence,
    lowConfidenceAgents,
    suspiciousPatterns,
    issues: allIssues,
    detectionMethods: detectionResults,
  };
}

/**
 * Perform LLM validation with retry logic and error handling
 */
async function performLLMValidation(
  result: AgentResult,
  config: HallucinationDetectorConfig,
): Promise<DetectionMethodResult> {
  const operation = async (): Promise<LLMValidationResult> => {
    return await validateWithLLM(result, config.platformModels, config.logger);
  };

  try {
    const retryConfig: ErrorClassification =
      config.retryConfig?.enabled !== false
        ? { type: "unknown", isRetryable: true, baseDelayMs: 1000, maxRetries: 2 }
        : { type: "unknown", isRetryable: false, baseDelayMs: 0, maxRetries: 0 };

    const llmResult = await RetryableOperation.execute(operation, retryConfig, config.logger);
    const issueStrings = llmResult.output.issues.map((i) => `${i.category}: ${i.claim}`);

    config.logger?.debug("HallucinationDetector: LLM validation result", {
      agentId: result.agentId,
      confidence: llmResult.output.confidence,
      issues: issueStrings,
    });

    return {
      method: "llm",
      agentId: result.agentId,
      confidence: llmResult.output.confidence,
      issues: issueStrings,
    };
  } catch (error) {
    const classification = LLMErrorClassifier.classify(error);

    config.logger?.warn("LLM validation failed after retries", {
      agentId: result.agentId,
      errorType: classification.type,
      isRetryable: classification.isRetryable,
      error,
    });

    // Infrastructure-failure fallback — confidence 0.4 keeps us in the `uncertain`
    // band (above the 0.3 fail-floor) so judge outages never lose agent work.
    return {
      method: "llm",
      agentId: result.agentId,
      confidence: 0.4,
      issues: [
        "Wasn't validated properly",
        `LLM validation failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

/**
 * LLM validation with structured output. Returns the judge's verbatim object
 * (categorized issues, confidence, judge-phrased retry guidance). Severity and
 * status are derived in {@link validate} — the schema deliberately does not
 * expose them to the judge.
 */
async function validateWithLLM(
  result: AgentResult,
  platformModels: PlatformModels,
  logger?: Logger,
): Promise<LLMValidationResult> {
  try {
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: buildValidationPrompt(),
        providerOptions: getDefaultProviderOpts("anthropic"),
      },
      temporalGroundingMessage(),
      { role: "user", content: buildValidationInput(result) },
    ];

    const llmResult = await generateObject({
      model: platformModels.get("classifier"),
      messages,
      schema: JudgeOutputSchema,
      temperature: 0.05,
      maxOutputTokens: 1500,
      maxRetries: 3,
      experimental_repairText: repairJson,
    });

    logger?.debug("AI SDK generateObject completed", {
      agent: "hallucination-detector",
      step: "validate-with-llm",
      usage: llmResult.usage,
    });

    return { output: llmResult.object, source: "llm" };
  } catch (error) {
    throw new Error(
      `LLM validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Build LLM validation system prompt.
 *
 * The prompt is paired with {@link JudgeOutputSchema}; both must change
 * together. The out-of-scope section and the bias-toward-valid rule exist to
 * prevent the most common false-positive class — the judge making its own
 * arithmetic, timezone, or date-math errors and flagging the agent's correct
 * output as fabrication.
 */
function buildValidationPrompt(): string {
  return `You detect AI agent fabrication by verifying data provenance.

## YOUR TASK

For each factual claim in the agent's output, decide whether it is supported by the tool results or input data. Emit one structured issue per claim that is NOT supported.

## OUT OF SCOPE — DO NOT ATTEMPT THESE CHECKS

You are NOT a math, calendar, or timezone engine. The following are EXPLICITLY out of scope:

1. **Arithmetic** — do not recompute sums, counts, percentages, durations, totals, or averages. If the agent says "3 + 5 = 8" or "the total is 142", trust it.
2. **Timezone conversions** — do not convert between timezones, do not check whether a UTC time matches a local time, do not validate offsets.
3. **Date math** — do not compute "days between", "next Monday", "X weeks from now", or any other date arithmetic. Do not validate weekday-of-date claims.
4. **Unit conversions** — do not check "5 miles = 8.04 km" or any other unit conversion.

These computations are the agent's responsibility, not yours. Your judgement on them is unreliable and produces false-positive fabrication claims. SKIP THEM.

## BIAS TOWARD VALID WHEN UNCERTAIN

False positives (rejecting correct work) are STRICTLY WORSE than false negatives (letting unsourced claims through) in this system. When you are not confident a claim is fabricated, treat it as sourced. Reserve fabrication flags for cases where you can clearly identify the missing source.

## WHAT IS FABRICATION

1. **External data without access** — agent claims web/API/database data but called NO tools (category: \`no-tools-called\` if the agent called zero tools; otherwise \`sourcing\`).
2. **False tool attribution** — agent claims a tool returned data that does not appear in any tool result (category: \`sourcing\`).
3. **Fabricated examples due to missing tools** — agent admits lack of tool access then generates sample data anyway, when the task did not request synthetic data (category: \`sourcing\`).

## LEGITIMATE DATA OPERATIONS — NOT FABRICATION

- Reformatting: \`{"firstName":"Alice","lastName":"Smith"}\` → "Alice Smith"
- Field extraction: picking 5 of 20 fields from a tool result
- Summarization: condensing 500 words into 50
- Number formatting: \`20000\` → "20,000"
- Data transformation: CSV → JSON → text
- Requested example data: when the task explicitly asks for synthetic/mock data

## ISSUE CATEGORIES

You MUST pick exactly one of these for every issue:

- \`sourcing\` — claim is not in tool results, input, or a direct logical inference from them, and at least one tool was called. Use a verbatim citation of the most relevant tool-result excerpt that should have backed the claim if you can identify one; otherwise use null.
- \`no-tools-called\` — the agent called zero tools but produced claims that would require external data. \`citation\` is always null for this category — there is no source to quote.
- \`judge-uncertain\` — you cannot tell from the available evidence whether the claim is sourced. Use sparingly; bias toward valid when uncertain. \`citation\` is null.
- \`judge-error\` — reserved for runtime use; do not emit this category yourself.

## CITATIONS

When category is \`sourcing\`, set \`citation\` to a verbatim quote of the most relevant 1–3 lines from the tool result that should have supported the claim. The quote MUST be ≤ 280 characters. Do not paraphrase. If no tool result is even close to the claim, use null.

For \`no-tools-called\` and \`judge-uncertain\`, \`citation\` is always null.

\`citation: null\` is reserved for cases where there is no source to quote (the categories above). Never use null because you "forgot to cite" — if a quote applies, include it.

## RETRY GUIDANCE

\`retryGuidance\` is a single short string (1–3 sentences) addressed to the agent retrying this step. Phrase it as actionable instructions ("Call tool X before claiming Y", "Cite the tool result for the employee count"). When confidence is high (no real issues), \`retryGuidance\` may be an empty string.

## CONFIDENCE

Confidence is a number in [0, 1] expressing how confident you are that the agent's output is well-sourced. High confidence = sourced; low confidence = fabricated.

Start at 0.7. For each \`sourcing\` or \`no-tools-called\` issue you emit, subtract 0.2. Clamp the final value to [0, 1]. If the output is well-sourced and you have no issues to emit, confidence stays at or above 0.7.

The system maps confidence to a status (\`pass\` / \`uncertain\` / \`fail\`); you do not select status.

## SEVERITY

Severity is derived from category in code; do not include it in your output.`;
}

/** Max chars per tool result sent to the validation LLM. */
const MAX_TOOL_RESULT_CHARS = 100_000;

/**
 * Extract the human-readable content from a tool result's output.
 *
 * MCP tools return `CallToolResult` with a `content` array of typed items.
 * We Zod-parse the `unknown` output to extract text content cleanly.
 * Falls back to compact JSON for non-MCP or unrecognized shapes.
 *
 * @param output - The raw `output` field from a ToolResult (typed `unknown` on DynamicToolResult)
 */
function extractOutputText(output: unknown): string {
  if (typeof output === "string") return output;

  const parsed = McpToolOutputSchema.safeParse(output);
  if (parsed.success && parsed.data.content) {
    const texts = parsed.data.content.map((item) => item.text ?? `[${item.type}]`).filter(Boolean);
    if (texts.length > 0) return texts.join("\n");
  }

  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/**
 * Format tool results for the validation LLM.
 *
 * Accepts the typed `ToolResult[]` from AgentResult. Extracts tool name and
 * text content from MCP envelopes — strips envelope noise (toolCallId,
 * providerMetadata) that wastes tokens without aiding validation.
 *
 * When a result exceeds {@link MAX_TOOL_RESULT_CHARS}, the tail is truncated
 * and a single English banner is appended at the bottom so the judge can
 * distinguish truncation from absence — the judge's most common false-positive
 * class is flagging missing-tail content as fabrication.
 *
 * @param toolResults - Typed tool results from agent execution
 * @returns Formatted string with all tool results, each capped at MAX_TOOL_RESULT_CHARS
 */
export function formatToolResults(toolResults: ToolResult[]): string {
  return toolResults
    .map((tr, i) => {
      const inputText = tr.input != null ? ` | input: ${JSON.stringify(tr.input)}` : "";
      const header = `=== Tool Result ${i + 1}: ${tr.toolName}${inputText} ===`;
      try {
        const text = extractOutputText(tr.output);
        if (text.length <= MAX_TOOL_RESULT_CHARS) return `${header}\n${text}`;
        const omitted = text.length - MAX_TOOL_RESULT_CHARS;
        const banner =
          `[TOOL RESULT TRUNCATED — ${omitted} bytes omitted from end. ` +
          `The judge should not flag missing tail content as fabrication.]`;
        return `${header}\n${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n${banner}`;
      } catch {
        return `${header}\n[Failed to serialize]`;
      }
    })
    .join("\n\n");
}

/**
 * Build validation input with full data visibility
 */
function buildValidationInput(result: AgentResult): string {
  // Extract toolCalls/toolResults from success envelope
  const toolCalls = result.ok ? result.toolCalls : undefined;
  const toolResults = result.ok ? result.toolResults : undefined;

  // Safely stringify tool calls
  const toolCallsSummary = (() => {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return "NONE - Agent did not call any tools";
    }

    try {
      return JSON.stringify(toolCalls, null, 2);
    } catch {
      return "Failed to serialize tool calls";
    }
  })();

  // Safely stringify tool results - show full data
  const toolResultsText = (() => {
    if (!Array.isArray(toolResults) || toolResults.length === 0) {
      return "No tool results available";
    }

    return formatToolResults(toolResults);
  })();

  // Format output - use data for success, error.reason for failure
  const outputText = (() => {
    const output = result.ok ? result.data : result.error.reason;
    try {
      return typeof output === "string" ? output : JSON.stringify(output, null, 2);
    } catch {
      return String(output);
    }
  })();

  // Format input
  const inputText = (() => {
    if (!result.input) return "No input data provided";
    try {
      return typeof result.input === "string"
        ? result.input
        : JSON.stringify(result.input, null, 2);
    } catch {
      return String(result.input);
    }
  })();

  return `## FABRICATION DETECTION

**TOOLS CALLED:**
${toolCallsSummary}

**TOOL RESULTS (full data for validation):**
${toolResultsText}

**AGENT OUTPUT:**
${outputText}

**INPUT DATA (if any):**
${inputText}

## VALIDATION TASK

Check if factual claims in the agent output are present in:
1. Tool results above
2. Input data above
3. Logical inferences from #1 or #2

Agent: ${result.agentId} | Duration: ${result.durationMs}ms`;
}

// JSON parsing helpers removed due to structured output usage

/**
 * Calculate final confidence scores for all results
 */
function calculateFinalConfidences(
  results: AgentResult[],
  detectionResults: DetectionMethodResult[],
): number[] {
  const finalConfidences: number[] = [];

  for (const result of results) {
    const agentDetections = detectionResults.filter((d) => d.agentId === result.agentId);

    if (agentDetections.length === 0) {
      finalConfidences.push(0.5); // Neutral default
      continue;
    }

    // Use LLM detection results for final confidence calculation
    const llmDetections = agentDetections.filter((d) => d.method === "llm");

    if (llmDetections.length === 0) {
      finalConfidences.push(0.5); // Neutral default if no LLM results
      continue;
    }

    // Average confidence from LLM detection methods
    const avgConfidence =
      llmDetections.reduce((sum, d) => sum + d.confidence, 0) / llmDetections.length;

    finalConfidences.push(avgConfidence);
  }

  return finalConfidences;
}

/**
 * Get confidence threshold based on supervision level
 *
 * Thresholds tuned for new scoring system:
 * - Base score: 0.5
 * - Each sourced claim: +0.05
 * - Each fabrication: -0.25
 *
 * This means legitimate work with 2-3 sourced claims scores 0.6-0.65
 * while fabrications with 1+ unsourced claims score < 0.3
 */
function getThreshold(supervisionLevel: SupervisionLevel): number {
  switch (supervisionLevel) {
    case SupervisionLevel.MINIMAL:
      return 0.35; // Allow some ambiguity, catch severe fabrications
    case SupervisionLevel.STANDARD:
      return 0.45; // Balanced - most legitimate work passes
    case SupervisionLevel.PARANOID:
      return 0.6; // Strict but achievable for well-sourced outputs
    default:
      return 0.45;
  }
}

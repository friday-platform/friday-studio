/**
 * Shared test fixtures for config mutation tests.
 *
 * Fixtures use Zod schema.parse() to apply defaults and validate output,
 * ensuring test data matches production behavior.
 */

import { type AtlasAgentConfig, AtlasAgentConfigSchema } from "@atlas/agent-sdk";
import {
  type LLMAgentConfig,
  LLMAgentConfigSchema,
  type SystemAgentConfig,
  SystemAgentConfigSchema,
} from "../agents.ts";
import { type JobSpecification, JobSpecificationSchema } from "../jobs.ts";
import {
  type HTTPSignalConfig,
  HTTPSignalConfigSchema,
  type ScheduleSignalConfig,
  ScheduleSignalConfigSchema,
} from "../signals.ts";
import { type MergedConfig, type WorkspaceConfig, WorkspaceConfigSchema } from "../workspace.ts";
import type {
  ConflictError,
  InvalidOperationError,
  MutationError,
  MutationResult,
  NotFoundError,
  ValidationError,
  WriteError,
} from "./types.ts";

/**
 * Create a minimal valid WorkspaceConfig for testing.
 *
 * Uses Zod parse to apply defaults. Loose input type since Zod validates at runtime.
 */
export function createTestConfig(overrides: Record<string, unknown> = {}): WorkspaceConfig {
  return WorkspaceConfigSchema.parse({
    version: "1.0",
    workspace: { id: "test-workspace", name: "Test Workspace" },
    ...overrides,
  });
}

/**
 * Create a MergedConfig wrapping a WorkspaceConfig.
 *
 * Used in route tests where handlers receive MergedConfig from the workspace manager.
 */
export function createMergedConfig(workspaceConfig: WorkspaceConfig): MergedConfig {
  return { atlas: null, workspace: workspaceConfig };
}

// ==============================================================================
// AGENT FACTORIES
// ==============================================================================

/**
 * Create an LLM agent config with sensible defaults.
 * Uses schema.parse() to apply Zod defaults (e.g., temperature).
 */
export function llmAgent(
  overrides: Partial<{
    description: string;
    prompt: string;
    tools: string[];
    temperature: number;
    max_tokens: number;
    tool_choice: "auto" | "required" | "none";
    timeout: string;
    max_retries: number;
    provider_options: Record<string, unknown>;
    provider: string;
    model: string;
  }> = {},
): LLMAgentConfig {
  return LLMAgentConfigSchema.parse({
    type: "llm",
    description: overrides.description ?? "Test LLM agent",
    config: {
      provider: overrides.provider ?? "anthropic",
      model: overrides.model ?? "claude-sonnet-4-6",
      prompt: overrides.prompt ?? "Test prompt",
      ...(overrides.temperature !== undefined && { temperature: overrides.temperature }),
      ...(overrides.max_tokens !== undefined && { max_tokens: overrides.max_tokens }),
      ...(overrides.tools !== undefined && { tools: overrides.tools }),
      ...(overrides.tool_choice !== undefined && { tool_choice: overrides.tool_choice }),
      ...(overrides.timeout !== undefined && { timeout: overrides.timeout }),
      ...(overrides.max_retries !== undefined && { max_retries: overrides.max_retries }),
      ...(overrides.provider_options !== undefined && {
        provider_options: overrides.provider_options,
      }),
    },
  });
}

/**
 * Create an Atlas agent config with sensible defaults.
 * Uses schema.parse() to validate - no type assertions needed.
 */
export function atlasAgent(
  overrides: Partial<{
    agent: string;
    description: string;
    prompt: string;
    env: Record<string, unknown>;
  }> = {},
): AtlasAgentConfig {
  return AtlasAgentConfigSchema.parse({
    type: "atlas",
    agent: overrides.agent ?? "github",
    description: overrides.description ?? "Test Atlas agent",
    prompt: overrides.prompt ?? "Test prompt",
    ...(overrides.env !== undefined && { env: overrides.env }),
  });
}

/**
 * Create a system agent config with sensible defaults.
 * Uses schema.parse() to apply Zod defaults (e.g., temperature when config present).
 */
export function systemAgent(
  overrides: Partial<{
    agent: string;
    description: string;
    prompt: string;
    tools: string[];
    model: string;
    temperature: number;
  }> = {},
): SystemAgentConfig {
  const hasConfig =
    overrides.prompt !== undefined ||
    overrides.tools !== undefined ||
    overrides.model !== undefined ||
    overrides.temperature !== undefined;

  return SystemAgentConfigSchema.parse({
    type: "system",
    agent: overrides.agent ?? "conversation",
    description: overrides.description ?? "Test system agent",
    ...(hasConfig && {
      config: {
        ...(overrides.temperature !== undefined && { temperature: overrides.temperature }),
        ...(overrides.model !== undefined && { model: overrides.model }),
        ...(overrides.prompt !== undefined && { prompt: overrides.prompt }),
        ...(overrides.tools !== undefined && { tools: overrides.tools }),
      },
    }),
  });
}

// ==============================================================================
// SIGNAL FACTORIES
// ==============================================================================

/**
 * Create an HTTP signal config with sensible defaults.
 * Uses schema.parse() for validation.
 */
export function httpSignal(
  overrides: Partial<{ description: string; path: string; timeout: string }> = {},
): HTTPSignalConfig {
  return HTTPSignalConfigSchema.parse({
    provider: "http",
    description: overrides.description ?? "Test HTTP signal",
    config: {
      path: overrides.path ?? "/webhook",
      ...(overrides.timeout !== undefined && { timeout: overrides.timeout }),
    },
  });
}

/**
 * Create a schedule signal config with sensible defaults.
 * Uses schema.parse() to apply Zod defaults (e.g., timezone).
 */
export function scheduleSignal(
  overrides: Partial<{ description: string; schedule: string; timezone: string }> = {},
): ScheduleSignalConfig {
  return ScheduleSignalConfigSchema.parse({
    provider: "schedule",
    description: overrides.description ?? "Test schedule signal",
    config: {
      schedule: overrides.schedule ?? "0 9 * * *",
      ...(overrides.timezone !== undefined && { timezone: overrides.timezone }),
    },
  });
}

// ==============================================================================
// JOB FACTORIES
// ==============================================================================

/**
 * Create a job specification with sensible defaults.
 * Uses schema.parse() to apply Zod defaults (e.g., execution.strategy).
 *
 * Default job has one trigger (webhook signal) and one agent (test-agent).
 */
export function createJob(
  overrides: Partial<{
    description: string;
    triggers: Array<{ signal: string }>;
    agents: string[];
    strategy: "sequential" | "parallel";
  }> = {},
): JobSpecification {
  return JobSpecificationSchema.parse({
    description: overrides.description ?? "Test job",
    triggers: overrides.triggers ?? [{ signal: "webhook" }],
    execution: {
      ...(overrides.strategy !== undefined && { strategy: overrides.strategy }),
      agents: overrides.agents ?? ["test-agent"],
    },
  });
}

// ==============================================================================
// ERROR ASSERTION HELPERS
// ==============================================================================

/**
 * Map from error type discriminator to the narrowed error type.
 */
type ErrorTypeMap = {
  not_found: NotFoundError;
  validation: ValidationError;
  conflict: ConflictError;
  invalid_operation: InvalidOperationError;
  write: WriteError;
};

/**
 * Assert that a mutation result is an error of a specific type.
 *
 * Eliminates boilerplate type narrowing in tests. The validator callback
 * receives the correctly narrowed error type for additional assertions.
 *
 * @example
 * ```ts
 * // Before: 5-8 lines of boilerplate
 * expect(result.ok).toBe(false);
 * if (!result.ok) {
 *   expect(result.error.type).toBe("not_found");
 *   if (result.error.type === "not_found") {
 *     expect(result.error.entityId).toBe("missing");
 *   }
 * }
 *
 * // After: 1 line
 * expectError(result, "not_found", (e) => expect(e.entityId).toBe("missing"));
 * ```
 *
 * @param result - The mutation result to check
 * @param errorType - The expected error type discriminator
 * @param validator - Optional callback to make assertions on the narrowed error
 * @throws AssertionError if result is not an error of the expected type
 */
export function expectError<T extends MutationError["type"]>(
  result: MutationResult<unknown>,
  errorType: T,
  validator?: (error: ErrorTypeMap[T]) => void,
): asserts result is { ok: false; error: ErrorTypeMap[T] } {
  if (result.ok) {
    throw new Error(`Expected error of type "${errorType}", but result was ok`);
  }
  if (result.error.type !== errorType) {
    throw new Error(`Expected error type "${errorType}", got "${result.error.type}"`);
  }
  if (validator) {
    validator(result.error as ErrorTypeMap[T]);
  }
}

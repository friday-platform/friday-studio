/**
 * Workspace blueprint schemas.
 *
 * Canonical definitions for the structured plan format produced by the planner
 * pipeline and consumed by the deterministic compiler. Lives in @atlas/schemas
 * so both @atlas/core and @atlas/workspace-builder can depend on it without
 * creating a circular dependency.
 */

import { HTTPProviderConfigSchema, ScheduleProviderConfigSchema } from "@atlas/config";
import { z } from "zod";
import { JSONSchemaSchema } from "./json-schema.ts";

// ---------------------------------------------------------------------------
// Signal & Agent
// ---------------------------------------------------------------------------

/**
 * Signal types the planner can generate: time-based triggers (schedule) and
 * external event triggers (http). Slack attaches per-workspace as a chat
 * surface via the Communicator flow, handled outside the planner.
 */
const SignalTypeSchema = z.enum(["schedule", "http"]);

export const SignalConfigSchema = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("schedule"), config: ScheduleProviderConfigSchema }),
  z.strictObject({ provider: z.literal("http"), config: HTTPProviderConfigSchema }),
]);
export type SignalConfig = z.infer<typeof SignalConfigSchema>;

export const SignalSchema = z.strictObject({
  id: z.string().describe("Kebab-case identifier. Example: 'new-note-detected'"),
  name: z.string().describe("Human-readable signal name"),
  title: z.string().describe("Short verb-noun sentence for UI display"),
  signalType: SignalTypeSchema.describe("Signal provider type"),
  description: z.string().describe("When and how this triggers, including rationale"),
  payloadSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("JSON Schema defining required payload fields for this signal"),
  displayLabel: z.string().optional().describe("Badge text for UI display"),
  signalConfig: SignalConfigSchema.optional().describe(
    "Concrete provider configuration (populated by signal enrichment)",
  ),
});
export type Signal = z.infer<typeof SignalSchema>;

export const AgentSchema = z.strictObject({
  id: z.string().describe("Kebab-case identifier. Example: 'note-analyzer'"),
  name: z.string().describe("Human-readable agent name"),
  description: z.string().describe("What this agent accomplishes and how it works"),
  capabilities: z.array(z.string()).describe("High-level capabilities this agent requires"),
  configuration: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("User-specific values that must not be lost"),
  bundledId: z
    .string()
    .optional()
    .describe(
      "Bundled agent registry ID if classified as a bundled agent (e.g. 'research', 'email')",
    ),
  mcpServers: z
    .array(z.object({ serverId: z.string(), name: z.string() }))
    .optional()
    .describe("Resolved MCP server IDs for agents that aren't bundled"),
});
export type Agent = z.infer<typeof AgentSchema>;

// ---------------------------------------------------------------------------
// DAG Step
// ---------------------------------------------------------------------------

export const DAGStepSchema = z.strictObject({
  id: z.string().describe("Unique step identifier within the job"),
  agentId: z.string().describe("Agent ID to execute"),
  description: z.string().describe("What this step accomplishes"),
  depends_on: z
    .array(z.string())
    .describe("Step IDs this step depends on. Empty array = root step"),
});
export type DAGStep = z.infer<typeof DAGStepSchema>;

/** Inner schema — separated from preprocess wrapper so `z.infer` resolves cleanly. */
const ClassifiedDAGStepInnerSchema = DAGStepSchema.extend({
  executionType: z
    .enum(["bundled", "llm"])
    .describe("How this step executes: bundled agent or LLM agent"),
  executionRef: z
    .string()
    .describe("Execution target — bundled registry key or agent ID for LLM agents"),
  tools: z.array(z.string()).optional().describe("Tool names available to this step"),
});

/** Backfills `executionRef` from `agentId` for pre-2026-02-20 blueprints. */
// `as Record<string, unknown>` exception: z.preprocess receives `unknown` and
// there's no Zod-native way to narrow inside the callback. The typeof/null/in
// guards provide runtime safety; the inner schema validates immediately after.
export const ClassifiedDAGStepSchema = z.preprocess((data) => {
  if (typeof data === "object" && data !== null && "agentId" in data && !("executionRef" in data)) {
    const obj = data as Record<string, unknown>;
    return { ...obj, executionRef: obj.agentId };
  }
  return data;
}, ClassifiedDAGStepInnerSchema);
export type ClassifiedDAGStep = z.infer<typeof ClassifiedDAGStepInnerSchema>;

// ---------------------------------------------------------------------------
// Document Contract
// ---------------------------------------------------------------------------

export const DocumentContractSchema = z.strictObject({
  producerStepId: z.string().describe("Step ID that produces this document"),
  documentId: z.string().describe("Unique document identifier"),
  documentType: z.string().describe("Artifact type (e.g. 'summary', 'table')"),
  schema: JSONSchemaSchema.describe("JSON Schema defining the document structure"),
});
export type DocumentContract = z.infer<typeof DocumentContractSchema>;

// ---------------------------------------------------------------------------
// Prepare Mapping
// ---------------------------------------------------------------------------

const SourceMappingSchema = z
  .strictObject({
    from: z.string().describe("Dot-path to source field"),
    to: z.string().describe("Target field name in the prepared document"),
    transform: z
      .string()
      .optional()
      .describe(
        "JavaScript expression operating on `value` (extracted field) and " +
          "`docs` (all upstream document data by ID). Single expression, no statements. Omit for plain field extraction.",
      ),
    description: z
      .string()
      .optional()
      .describe(
        "Human-readable explanation of what the transform does. Required when transform is present.",
      ),
  })
  .refine((s) => !s.transform || s.description, {
    message: "description is required when transform is present",
  });

const ConstantMappingSchema = z.strictObject({
  key: z.string().describe("Target field name"),
  value: z.unknown().describe("Constant value to inject"),
});

export const PrepareMappingSchema = z.strictObject({
  consumerStepId: z.string().describe("Step ID that consumes this mapping"),
  documentId: z.string().describe("Source document identifier"),
  documentType: z.string().describe("Source document type"),
  sources: z.array(SourceMappingSchema).describe("Field mappings from source documents"),
  constants: z.array(ConstantMappingSchema).describe("Constant values to inject"),
});
export type PrepareMapping = z.infer<typeof PrepareMappingSchema>;

// ---------------------------------------------------------------------------
// Conditional
// ---------------------------------------------------------------------------

const BranchSchema = z.strictObject({
  equals: z.unknown().optional().describe("Value to match against"),
  default: z.boolean().optional().describe("Whether this is the default branch"),
  targetStep: z.string().describe("Step ID to transition to"),
});

export const ConditionalSchema = z.strictObject({
  stepId: z.string().describe("Step ID this conditional applies to"),
  field: z.string().describe("Dot-path to the field to branch on"),
  branches: z.array(BranchSchema).describe("Branch conditions and targets"),
});
export type Conditional = z.infer<typeof ConditionalSchema>;

// ---------------------------------------------------------------------------
// Job with DAG
// ---------------------------------------------------------------------------

export const JobWithDAGSchema = z.strictObject({
  id: z.string().describe("Kebab-case job identifier"),
  name: z.string().describe("Human-readable job name"),
  title: z.string().describe("Short 2-4 word title for UI display"),
  triggerSignalId: z.string().describe("Signal ID that triggers this job"),
  steps: z.array(DAGStepSchema).describe("DAG steps with dependency edges"),
  documentContracts: z.array(DocumentContractSchema).describe("Output schemas for each step"),
  prepareMappings: z
    .array(PrepareMappingSchema)
    .describe(
      "Input mappings wiring signal payloads to root steps and upstream outputs to downstream steps",
    ),
  conditionals: z.array(ConditionalSchema).optional().describe("Conditional branching definitions"),
});
export type JobWithDAG = z.infer<typeof JobWithDAGSchema>;

// ---------------------------------------------------------------------------
// Credential Binding
// ---------------------------------------------------------------------------

/**
 * Workspace-level credential binding. Uses generic `targetId` for both MCP servers and agents.
 * The planner stage (`@atlas/core/artifacts/primitives`) uses discriminated `serverId`/`agentId` instead.
 */
export const CredentialBindingSchema = z.strictObject({
  targetType: z
    .enum(["mcp", "agent"])
    .describe("Whether this binding targets an MCP server or agent"),
  targetId: z.string().describe("MCP server ID or agent ID"),
  field: z.string().describe("Environment variable / config field name"),
  credentialId: z.string().describe("Link credential ID"),
  provider: z.string().describe("OAuth provider (e.g. 'google', 'slack')"),
  key: z.string().describe("Credential key to extract (e.g. 'access_token')"),
  label: z.string().optional().describe("Human-readable label for the credential"),
});
export type CredentialBinding = z.infer<typeof CredentialBindingSchema>;

// ---------------------------------------------------------------------------
// Classified Job — post-classification job with executionType on steps
// ---------------------------------------------------------------------------

/** Job schema using ClassifiedDAGStep (post stamp-execution-types). */
export const ClassifiedJobWithDAGSchema = z.strictObject({
  id: z.string().describe("Kebab-case job identifier"),
  name: z.string().describe("Human-readable job name"),
  title: z.string().describe("Short 2-4 word title for UI display"),
  triggerSignalId: z.string().describe("Signal ID that triggers this job"),
  steps: z.array(ClassifiedDAGStepSchema).describe("Classified DAG steps with execution metadata"),
  documentContracts: z.array(DocumentContractSchema).describe("Output schemas for each step"),
  prepareMappings: z
    .array(PrepareMappingSchema)
    .describe(
      "Input mappings wiring signal payloads to root steps and upstream outputs to downstream steps",
    ),
  conditionals: z.array(ConditionalSchema).optional().describe("Conditional branching definitions"),
});

// ---------------------------------------------------------------------------
// Credential Candidates — surfaced for multi-credential picker in plan UI
// ---------------------------------------------------------------------------

/** A single credential candidate for a provider (mirrors AvailableCredential in web client). */
export const CredentialCandidateSchema = z.strictObject({
  id: z.string().describe("Link credential ID"),
  label: z.string().describe("User-assigned credential label"),
  displayName: z.string().nullable().describe("Provider display name (e.g. 'Google Calendar')"),
  userIdentifier: z.string().nullable().describe("Account identifier (e.g. email address)"),
  isDefault: z.boolean().describe("Whether this credential is the user's default for its provider"),
});
export type CredentialCandidate = z.infer<typeof CredentialCandidateSchema>;

/** All credential candidates for a single provider. */
export const ProviderCredentialCandidatesSchema = z.strictObject({
  provider: z.string().describe("OAuth provider (e.g. 'google', 'slack')"),
  candidates: z
    .array(CredentialCandidateSchema)
    .describe("Available credentials for this provider (2+)"),
});
export type ProviderCredentialCandidates = z.infer<typeof ProviderCredentialCandidatesSchema>;

// ---------------------------------------------------------------------------
// Workspace Blueprint — top-level schema (renamed from PlanWithContracts)
// ---------------------------------------------------------------------------

/** Detail extracted from user requirements for UI display. */
const DetailSchema = z.strictObject({
  label: z.string().describe("Human-readable label (e.g., 'GitHub Repository', 'Slack Channel')"),
  value: z.string().describe("User-provided value (e.g., 'org/repo', '#releases')"),
});

export const WorkspaceBlueprintSchema = z.strictObject({
  workspace: z.strictObject({
    name: z.string().describe("Workspace name"),
    purpose: z.string().describe("What this workspace does"),
    details: z
      .array(DetailSchema)
      .optional()
      .describe("User-provided details for UI display (e.g., repositories, channels)"),
  }),
  signals: z.array(SignalSchema),
  agents: z.array(AgentSchema),
  jobs: z.array(ClassifiedJobWithDAGSchema),
  credentialBindings: z
    .array(CredentialBindingSchema)
    .optional()
    .describe("Resolved Link credential bindings for MCP servers and agents"),
  credentialCandidates: z
    .array(ProviderCredentialCandidatesSchema)
    .optional()
    .describe("Credential candidates for providers with 2+ credentials (for plan UI picker)"),
});
export type WorkspaceBlueprint = z.infer<typeof WorkspaceBlueprintSchema>;

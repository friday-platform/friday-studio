/**
 * MCP registry doctor — the install-time classification step.
 *
 * Given a registry entry and its README, runs one LLM call to classify the
 * server and, when configuration is needed, extract the env vars from the
 * README. The output is a `DoctorReport` — a tagged union on verdict.
 *
 * Trust contract: `runDoctor` never throws. Every failure — timeout, bad JSON,
 * a thrown LLM error — collapses to an `unknown` verdict with the error as a
 * finding, so the install flow stays a deterministic state machine.
 *
 * Every env var name the LLM returns is verified against the source text
 * (registry entry + README); hallucinated names are dropped, and an
 * `attention` verdict that empties out after verification downgrades to
 * `unknown`.
 *
 * @module
 */

import { repairJson } from "@atlas/agent-sdk";
import type { PlatformModels } from "@atlas/llm";
import { createLogger } from "@atlas/logger";
import { generateObject as defaultGenerateObject } from "ai";
import { z } from "zod";
import { getAnnotation } from "./annotations.ts";
import type { DoctorEnvVar, DoctorFinding, DoctorReport } from "./schemas.ts";
import type { UpstreamServerEntry } from "./upstream-client.ts";

const logger = createLogger({ name: "mcp-registry-doctor" });

/** Hard ceiling on the doctor's single LLM call. */
const DOCTOR_TIMEOUT_MS = 30_000;

/**
 * The raw shape the LLM is asked to return — looser than `DoctorReport`. The
 * LLM tags each extracted env var with the README excerpt it read the name
 * from; `runDoctor` verifies those names against the source text, then
 * normalizes the response into a `DoctorReport`.
 */
const LLMResponseSchema = z.object({
  verdict: z.enum(["clean", "attention", "unknown"]),
  tldr: z.string(),
  findings: z
    .array(
      z.object({
        severity: z.enum(["info", "warn", "error"]),
        title: z.string(),
        detail: z.string(),
      }),
    )
    .optional(),
  env_vars: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        isRequired: z.boolean(),
        isSecret: z.boolean(),
        default: z.string().optional(),
        readme_excerpt: z.string(),
      }),
    )
    .optional(),
});

type LLMResponse = z.infer<typeof LLMResponseSchema>;

/** Dependencies for `runDoctor`. */
export interface RunDoctorDeps {
  registryEntry: UpstreamServerEntry;
  /** Repository README markdown, or null when none could be fetched. */
  readme: string | null;
  /** Platform model resolver — the `classifier` role runs the classification. */
  platformModels: PlatformModels;
  /** Optional override for the AI SDK generator (testing seam). */
  generateObject?: (...args: unknown[]) => Promise<{ object: unknown }>;
}

/**
 * Classify a registry server and extract the env it needs. Never throws.
 */
export async function runDoctor(deps: RunDoctorDeps): Promise<DoctorReport> {
  const { registryEntry, readme, platformModels } = deps;
  const generate = deps.generateObject ?? defaultGenerateObject;
  const canonicalName = registryEntry.server.name;

  const doctorNotes = getAnnotation(canonicalName)?.doctorNotes;
  const prompt = buildDoctorPrompt(registryEntry, readme, doctorNotes);

  let raw: LLMResponse;
  try {
    const { object } = await generate({
      model: platformModels.get("classifier"),
      schema: LLMResponseSchema,
      prompt,
      maxOutputTokens: 2000,
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(DOCTOR_TIMEOUT_MS),
      experimental_repairText: repairJson,
    });
    raw = LLMResponseSchema.parse(object);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn("doctor llm call failed", { canonicalName, error: detail });
    return {
      verdict: "unknown",
      tldr: "The setup doctor could not analyze this server.",
      findings: [{ severity: "error", title: "Doctor analysis failed", detail }],
    };
  }

  return normalizeReport(raw, registryEntry, readme);
}

/**
 * Build the doctor's LLM prompt. When `doctorNotes` is set (curator hints from
 * the annotation overlay), they are prepended as an authoritative section the
 * LLM is told to trust over the README.
 */
export function buildDoctorPrompt(
  registryEntry: UpstreamServerEntry,
  readme: string | null,
  doctorNotes?: string,
): string {
  const { server } = registryEntry;

  const curatorSection = doctorNotes
    ? `## Curator notes (authoritative — trust these over the README)\n${doctorNotes}\n\n`
    : "";

  const registrySection = JSON.stringify(
    {
      name: server.name,
      description: server.description,
      packages: server.packages,
      remotes: server.remotes,
    },
    null,
    2,
  );

  return `You are the setup doctor for an MCP server install. Classify whether this server runs as-is, needs configuration, or can't be determined — and when it needs configuration, extract the environment variables from its README.

${curatorSection}## Registry entry
${registrySection}

## README
${readme ?? "(no README available)"}

## Your task
Return a JSON object:
- verdict: "clean" | "attention" | "unknown"
  - "clean": the server is self-contained and runs with no configuration.
  - "attention": the server needs environment variables you can enumerate from the README.
  - "unknown": something signals the server needs setup, but you cannot enumerate a clean schema.
- tldr: one sentence — what the server does, what it needs, what to do next. Not a list.
- findings: array of { severity: "info" | "warn" | "error", title, detail }. For "unknown", explain what you saw and could not pin down.
- env_vars: for "attention" only — array of { name, description?, isRequired, isSecret, default?, readme_excerpt }.
  - readme_excerpt: the exact snippet you read the variable from.
  - isRequired / isSecret: your best read from the docs.

Rules:
- Every env var name MUST be copied verbatim from the registry entry or README above — never invent, normalize, or guess names.
- "clean" carries no env_vars. "attention" needs at least one env var. "unknown" needs at least one finding.`;
}

/**
 * Turn the raw LLM response into a valid `DoctorReport`: drop any env var whose
 * name is not present verbatim in the source text, tag survivors with `friday`
 * provenance, and downgrade `attention` to `unknown` when nothing survives.
 */
function normalizeReport(
  raw: LLMResponse,
  registryEntry: UpstreamServerEntry,
  readme: string | null,
): DoctorReport {
  const findings: DoctorFinding[] = (raw.findings ?? []).map((f) => ({
    severity: f.severity,
    title: f.title,
    detail: f.detail,
  }));

  if (raw.verdict === "clean") {
    return { verdict: "clean", tldr: raw.tldr, findings };
  }

  if (raw.verdict === "attention") {
    const sourceText = `${JSON.stringify(registryEntry.server)}\n${readme ?? ""}`;
    const verified: DoctorEnvVar[] = [];
    let droppedCount = 0;

    for (const ev of raw.env_vars ?? []) {
      // Verbatim-name verification — the only defense against a hallucinated
      // name becoming a Link provider key the real package doesn't have.
      if (!sourceText.includes(ev.name)) {
        droppedCount++;
        continue;
      }
      verified.push({
        name: ev.name,
        description: ev.description,
        isRequired: ev.isRequired,
        isSecret: ev.isSecret,
        default: ev.default,
        provenance: { source: "friday", readme_excerpt: ev.readme_excerpt },
      });
    }

    if (droppedCount > 0) {
      findings.push({
        severity: "warn",
        title: "Dropped unverifiable env vars",
        detail: `${String(droppedCount)} env var name(s) the doctor returned did not appear in the registry entry or README and were discarded.`,
      });
    }

    if (verified.length === 0) {
      // attention with nothing verifiable → unknown
      if (findings.length === 0) {
        findings.push({
          severity: "warn",
          title: "No verifiable configuration found",
          detail:
            "The doctor flagged this server as needing configuration but could not enumerate any env vars present in the source text.",
        });
      }
      return { verdict: "unknown", tldr: raw.tldr, findings };
    }

    return { verdict: "attention", tldr: raw.tldr, findings, env_vars: verified };
  }

  // raw.verdict === "unknown" — guarantee at least one finding.
  if (findings.length === 0) {
    findings.push({
      severity: "warn",
      title: "Doctor could not classify this server",
      detail: "The doctor returned an unknown verdict without a specific finding.",
    });
  }
  return { verdict: "unknown", tldr: raw.tldr, findings };
}

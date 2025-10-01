import type { Logger } from "@atlas/logger";
import { generateObject, type LanguageModel } from "ai";
import { anthropic } from "@atlas/core";
import { z } from "zod";

export type FactSourceType = "session_summary" | "agent_input" | "agent_output" | "payload";

export interface SemanticFact {
  subject: string;
  predicate: string;
  object: string;
  qualifiers?: Record<string, string>;
  evidence: string;
  sourceType: FactSourceType;
  sourceAgentId?: string;
  confidence: number;
}

interface FactExtractionResult {
  facts: SemanticFact[];
  reasoning: string;
}

interface FactExtractionBatch {
  text: string;
  sourceType: FactSourceType;
  sourceAgentId?: string;
}

interface SemanticFactExtractorConfig {
  llmProvider?: (model: string) => LanguageModel;
  logger?: Logger;
  enabled?: boolean;
  model?: string; // default small/fast model
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  confidenceThreshold?: number; // drop facts below this
}

const SemanticFactSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  qualifiers: z.record(z.string(), z.string()).optional(),
  evidence: z.string().min(1),
  sourceType: z.enum(["session_summary", "agent_input", "agent_output", "payload"] as const),
  sourceAgentId: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

const FactExtractionResultSchema = z.object({
  facts: z.array(SemanticFactSchema).default([]),
  reasoning: z.string().default(""),
});

export class SemanticFactExtractor {
  private readonly logger?: Logger;
  private readonly model: string;
  private readonly llmProvider: (model: string) => LanguageModel;
  private readonly enabled: boolean;
  private readonly temperature: number;
  private readonly maxOutputTokens: number;
  private readonly timeoutMs?: number;
  private readonly confidenceThreshold: number;

  constructor(config: SemanticFactExtractorConfig = {}) {
    this.logger = config.logger;
    this.enabled = config.enabled ?? true;
    this.model = config.model || "claude-3-haiku-20240307";
    this.temperature = config.temperature ?? 0.1;
    this.maxOutputTokens = config.maxOutputTokens ?? 1200;
    this.timeoutMs = config.timeoutMs;
    this.confidenceThreshold = config.confidenceThreshold ?? 0.6;

    if (config.llmProvider) {
      this.llmProvider = config.llmProvider;
    } else {
      this.llmProvider = (model: string) => anthropic(model);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getConfidenceThreshold(): number {
    return this.confidenceThreshold;
  }

  async extractFromBatch(batch: FactExtractionBatch): Promise<FactExtractionResult> {
    if (!this.enabled) {
      return { facts: [], reasoning: "disabled" };
    }

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(batch);

    try {
      const options = {
        model: this.llmProvider(this.model),
        system: systemPrompt,
        messages: [{ role: "user" as const, content: userPrompt }],
        schema: FactExtractionResultSchema,
        temperature: this.temperature,
        maxOutputTokens: this.maxOutputTokens,
        ...(this.timeoutMs ? { abortSignal: AbortSignal.timeout(this.timeoutMs) } : {}),
      };

      const { object } = await generateObject(options);
      const parsed = FactExtractionResultSchema.parse(object);

      // Post-filter: low-confidence and cleanup
      const filtered = this.filterFacts(parsed.facts);
      const deduped = this.deduplicateFacts(filtered);

      return { facts: deduped, reasoning: parsed.reasoning };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn("Semantic fact extraction failed", { error: message });
      return { facts: [], reasoning: `error: ${message}` };
    }
  }

  private buildSystemPrompt(): string {
    return [
      "Extract semantic facts as subject–predicate–object triples.",
      "- Prefer general, stable, entity-centric knowledge that will aid future tasks.",
      "- Facts should be concise and normalized.",
      "- Provide a short evidence snippet.",
      "- Return only structured JSON per provided schema.",
    ].join("\n");
  }

  private buildUserPrompt(batch: FactExtractionBatch): string {
    const header = `SourceType: ${batch.sourceType}${
      batch.sourceAgentId ? `\nSourceAgentId: ${batch.sourceAgentId}` : ""
    }`;
    return [
      header,
      "\n--- BEGIN TEXT ---",
      this.truncate(batch.text, 12000),
      "--- END TEXT ---\n",
      "Instructions:",
      "1) Extract general semantic facts.",
      "2) Use concise SPO triples with optional qualifiers and evidence.",
      "3) Confidence should reflect extraction certainty (0..1).",
    ].join("\n");
  }

  private truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 20) + "\n[TRUNCATED]";
  }

  private deduplicateFacts(facts: SemanticFact[]): SemanticFact[] {
    const seen = new Set<string>();
    const results: SemanticFact[] = [];
    for (const f of facts) {
      const key = [
        f.subject.trim().toLowerCase(),
        f.predicate.trim().toLowerCase(),
        f.object.trim().toLowerCase(),
        f.sourceType,
        f.sourceAgentId || "",
      ].join("|");
      if (!seen.has(key)) {
        seen.add(key);
        results.push(f);
      }
    }
    return results;
  }

  private filterFacts(facts: SemanticFact[]): SemanticFact[] {
    const threshold = this.confidenceThreshold;
    const safe: SemanticFact[] = [];
    for (const f of facts) {
      if (typeof f.confidence !== "number" || f.confidence < threshold) continue;
      const sanitized: SemanticFact = {
        subject: this.cleanString(f.subject),
        predicate: this.cleanString(f.predicate),
        object: this.cleanString(f.object),
        qualifiers: this.sanitizeQualifiers(f.qualifiers),
        evidence: this.cleanEvidence(f.evidence),
        sourceType: f.sourceType,
        sourceAgentId: f.sourceAgentId,
        confidence: f.confidence,
      };
      safe.push(sanitized);
    }
    return safe;
  }

  private cleanString(value: string): string {
    const trimmed = value.trim();
    return trimmed.length > 400 ? trimmed.slice(0, 380) + "…" : trimmed;
  }

  private cleanEvidence(value: string): string {
    const cleaned = value.replace(/\s+/g, " ").trim();
    return cleaned.length > 300 ? cleaned.slice(0, 280) + "…" : cleaned;
  }

  private sanitizeQualifiers(
    qualifiers?: Record<string, string>,
  ): Record<string, string> | undefined {
    if (!qualifiers) return undefined;
    const result: Record<string, string> = {};
    for (const key of Object.keys(qualifiers)) {
      const val = qualifiers[key];
      if (typeof val === "string") {
        result[key] = this.cleanString(val);
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
}

/**
 * Server-only exports for artifacts
 * These should not be imported by browser/client code
 */

// Re-export common types from mod.ts for convenience
export type { Artifact, ArtifactLifecycle } from "./mod.ts";
// CSV Parsing (server-only, uses papaparse Node dependency)
export type { CsvCell, CsvParseResult } from "./parsers/mod.ts";
export { CsvParseResultSchema, parseCsvContent } from "./parsers/mod.ts";
// Promotion-by-reference scan (Phase 6.B sweeper helper).
export type {
  AiSummaryProvider,
  KeyDetailLike,
  PromotionScanContext,
} from "./reference-scan.ts";
export { hasPromotionSignal } from "./reference-scan.ts";
// Storage (server-only — JetStream KV + Object Store backed)
export { ArtifactStorage, initArtifactStorage } from "./storage.ts";

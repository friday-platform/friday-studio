import { getContext, setContext } from "svelte";

/**
 * Pre-fetched artifact metadata snapshot used during export rendering.
 *
 * Mirrors the payload of `ArtifactResponseSchema` in
 * `artifact-card.svelte` so the card can hydrate synchronously from
 * context instead of fetching `/api/daemon/...` (which does not exist
 * in the static export HTML).
 */
export type ArtifactPrefetch = {
  /** Artifact id, matches the `artifactId` prop the card receives. */
  id: string;
  /** Display title; falls back to "Artifact" if empty. */
  title: string;
  /** Optional one-line summary shown beneath the title. */
  summary?: string;
  /** Full mime type, including any `; charset=...` parameters. */
  mimeType: string;
  /** Byte length of the artifact contents. */
  size: number;
  /** Original filename when the artifact was uploaded. */
  originalName?: string;
  /** Inline contents for text-like artifacts (mirrors `contents` from the live response). */
  contents?: string;
};

/**
 * Context passed from the export preview page down through
 * `ChatMessageList → ToolCallCard → ArtifactCard`.
 *
 * The live UI never sets this context, so `getExportContext()` returns
 * `undefined` and components fall through to their normal
 * fetch-from-daemon behavior.
 */
export type ExportContext = {
  /** Pre-fetched artifact metadata keyed by artifact id. */
  artifacts: ReadonlyMap<string, ArtifactPrefetch>;
  /**
   * Maps an artifact id to a relative URL inside the export bundle
   * (e.g. `assets/artifacts/<id>/<filename>`).
   */
  resolveUrl: (id: string) => string;
};

const EXPORT_CONTEXT_KEY: unique symbol = Symbol("atlas.chat.export-context");

/**
 * Stores the export context for descendants of the calling component.
 * Must be invoked during component initialization (Svelte's
 * `setContext` rule).
 */
export function setExportContext(ctx: ExportContext): void {
  setContext(EXPORT_CONTEXT_KEY, ctx);
}

/**
 * Reads the export context set by an ancestor, or `undefined` when no
 * ancestor called `setExportContext` (the live-UI path).
 */
export function getExportContext(): ExportContext | undefined {
  return getContext<ExportContext | undefined>(EXPORT_CONTEXT_KEY);
}

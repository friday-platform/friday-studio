/**
 * Hand-curated capability overlay for image-generation models.
 *
 * The overlay is the source of truth for "what can this model do" and
 * "what are this model's default call-shape params." It is intentionally
 * separate from the gateway-discovered model catalog: the gateway tells us
 * which ids exist; the overlay tells us which ids Friday has *verified*.
 *
 * Resolver behavior: any chain entry whose id is not in `IMAGE_OVERLAY`
 * is rejected at boot (see `unknown_image_model` ErrorKind — added in a
 * follow-up task). For the tracer bullet, only the single canonical
 * default entry is present.
 *
 * Adding an entry: bump `lastValidatedAt` after running the validation
 * harness against the live provider so the round-trip drift check can
 * flag stale entries.
 */

/**
 * What a given image model can do. `generation` is always true (every model
 * in the overlay generates images; the picker filters by `edit` to surface
 * edit-capable options separately).
 */
export type ImageCapabilities = { generation: true; edit: boolean };

/**
 * Default call-shape parameters per model.
 *
 * Discriminated on `controlAxis`: providers split cleanly into "takes a
 * `size` like `1024x1024`" (OpenAI's `gpt-image-*`, DALL·E) and "takes an
 * `aspectRatio` like `1:1`" (Google's Gemini, Imagen). Encoding this as a
 * type-level discriminator means the agent's dispatch site cannot
 * accidentally pass `size` to Imagen or `aspectRatio` to DALL·E.
 */
export type ImageDefaults =
  | { controlAxis: "size"; size: `${number}x${number}`; format: "png" | "jpeg" }
  | { controlAxis: "aspectRatio"; aspectRatio: string; format: "png" | "jpeg" };

export type ImageOverlayEntry = {
  displayName: string;
  capabilities: ImageCapabilities;
  defaults: ImageDefaults;
  /** ISO-8601 date the harness last verified this entry against the live provider. */
  lastValidatedAt: string;
  /** Optional note rendered in Settings (e.g. "requires verified OpenAI org"). */
  note?: string;
};

/**
 * Verified image models, keyed by `provider:model`. Resolver and Settings
 * picker treat this as authoritative for capability and default-param
 * questions.
 *
 * Default rationale:
 * - Google: `1:1` PNG matches Gemini/Imagen's natural square output and
 *   keeps lossless transport for editing flows.
 * - OpenAI: `1024x1024` PNG is the canonical baseline supported by every
 *   entry (`gpt-image-*`, `dall-e-3`, `dall-e-2`) and avoids paying for
 *   higher-resolution tiers users haven't opted into.
 */
export const IMAGE_OVERLAY: Readonly<Record<string, ImageOverlayEntry>> = {
  "google:gemini-2.5-flash-image": {
    displayName: "Gemini 2.5 Flash Image",
    capabilities: { generation: true, edit: true },
    defaults: { controlAxis: "aspectRatio", aspectRatio: "1:1", format: "png" },
    lastValidatedAt: "2026-06-02",
  },
  "google:imagen-4.0-generate-001": {
    displayName: "Imagen 4",
    capabilities: { generation: true, edit: false },
    defaults: { controlAxis: "aspectRatio", aspectRatio: "1:1", format: "png" },
    lastValidatedAt: "2026-06-02",
  },
  "google:imagen-4.0-fast-generate-001": {
    displayName: "Imagen 4 Fast",
    capabilities: { generation: true, edit: false },
    defaults: { controlAxis: "aspectRatio", aspectRatio: "1:1", format: "png" },
    lastValidatedAt: "2026-06-02",
  },
  "openai:gpt-image-1.5": {
    displayName: "GPT Image 1.5",
    capabilities: { generation: true, edit: true },
    defaults: { controlAxis: "size", size: "1024x1024", format: "png" },
    lastValidatedAt: "2026-06-02",
    // Surfaced in the Settings picker so users hit the org-verification
    // gate at config time rather than at first generation attempt.
    note: "Requires a verified OpenAI organization.",
  },
  "openai:dall-e-3": {
    displayName: "DALL·E 3",
    capabilities: { generation: true, edit: false },
    defaults: { controlAxis: "size", size: "1024x1024", format: "png" },
    lastValidatedAt: "2026-06-02",
  },
  "openai:dall-e-2": {
    displayName: "DALL·E 2",
    capabilities: { generation: true, edit: true },
    defaults: { controlAxis: "size", size: "1024x1024", format: "png" },
    lastValidatedAt: "2026-06-02",
  },
};

/**
 * Look up an overlay entry by `provider:model` id. Returns `null` when the
 * id is unknown to Friday — callers should treat null as a hard "this
 * model is not usable" signal (boot-time validation prevents this at the
 * resolver layer, but the lookup is null-safe for defense in depth).
 */
export function lookupImageEntry(id: string): ImageOverlayEntry | null {
  return IMAGE_OVERLAY[id] ?? null;
}

/**
 * List every overlay entry with its id flattened in. Used by the Settings
 * picker to render capability badges and by the round-trip drift test to
 * iterate the full set.
 */
export function listImageEntries(): ReadonlyArray<{ id: string } & ImageOverlayEntry> {
  return Object.entries(IMAGE_OVERLAY).map(([id, entry]) => ({ id, ...entry }));
}

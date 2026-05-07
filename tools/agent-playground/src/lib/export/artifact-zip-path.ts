import { deriveDownloadFilename } from "@atlas/core/artifacts/file-upload";

/**
 * Slugify a derived filename to ASCII-safe characters before it lands in
 * the export zip. `originalName` and `title` flow straight from artifact
 * metadata, which can carry any unicode the user/agent wrote — strip
 * control chars and path separators so the zip never grows nested
 * directories or non-portable names.
 *
 * MUST stay byte-identical to the rule the export orchestrator uses when
 * placing artifact bytes in the zip (see Task #8). Both call sites import
 * this helper to enforce that parity by construction. There is a duplicate
 * of this rule in `apps/atlasd/routes/workspaces/chat.ts` (slugifyZipBasename)
 * that gets deleted along with the daemon's export route in Task #9 —
 * keeping it isolated there until then avoids churn on a soon-to-die file.
 */
export function slugifyZipBasename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "artifact";
}

/**
 * Inputs to derive a stable, zip-safe asset path for an artifact. Mirrors
 * the metadata fields `deriveDownloadFilename` consumes — we keep the
 * shape narrow so callers don't need to thread a full `ArtifactSummary`.
 */
export interface ArtifactPathInput {
  id: string;
  mimeType: string;
  originalName?: string;
  title: string;
}

/**
 * Compute the relative path under which an artifact's bytes live in the
 * export zip — `assets/artifacts/{id}/{slugified-derived-filename}`.
 *
 * The preview page's `ExportContext.resolveUrl` calls this so HTML
 * references resolve against the same path the orchestrator (Task #8)
 * writes to in the zip. No leading slash so the path is resolvable when
 * the file is opened directly off disk.
 *
 * Both `id` and the derived basename run through `slugifyZipBasename`.
 * Artifact ids are daemon-generated today (so containing `..` or `/` is
 * not currently possible) but a future change to id generation, or a
 * compromised daemon, would otherwise let an attacker write outside
 * `assets/artifacts/` — JSZip honours whatever path you hand it. Slug at
 * the boundary instead of trusting the upstream charset.
 */
export function artifactZipPath(input: ArtifactPathInput): string {
  const safeId = slugifyZipBasename(input.id);
  const basename = slugifyZipBasename(
    deriveDownloadFilename({
      mimeType: input.mimeType,
      originalName: input.originalName,
      title: input.title,
    }),
  );
  return `assets/artifacts/${safeId}/${basename}`;
}

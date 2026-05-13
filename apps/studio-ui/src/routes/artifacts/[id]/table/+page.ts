import { error } from "@sveltejs/kit";
import { loadArtifactWithProvenance } from "../_load-artifact.ts";
import type { PageLoad } from "./$types";

/**
 * Load the raw bytes of a tabular artifact + the headers we need to
 * pick a parser. The actual parsing happens in the page component so
 * `DOMParser` (browser-only) is available — Sveltekit's universal
 * loader runs on both server and client and we want one code path.
 *
 * Provenance ("From <chat> in <workspace>") and provider error handling
 * live in `../_load-artifact.ts` — shared with the markdown viewer.
 *
 * Parsing failures (the bytes are well-formed but not tabular in any
 * shape we recognize) are handled inline by the +page.svelte so the
 * user sees a graceful "this artifact isn't tabular" fallback with a
 * link to download the original.
 */
export const load: PageLoad = async ({ params, fetch }) => {
  const { id: artifactId } = params;
  if (!artifactId) {
    throw error(400, "Missing artifact id");
  }
  return loadArtifactWithProvenance(artifactId, fetch);
};

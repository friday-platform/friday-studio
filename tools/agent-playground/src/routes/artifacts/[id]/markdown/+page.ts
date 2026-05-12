import { error } from "@sveltejs/kit";
import { loadArtifactWithProvenance } from "../_load-artifact.ts";
import type { PageLoad } from "./$types";

/**
 * Load a markdown artifact for the dedicated `/markdown` viewer. The
 * page component renders the document as prose and surfaces any
 * embedded GFM tables inline via the same TableView + action chrome
 * that powers the `/table` route. This is the destination the artifact
 * dispatcher redirects `text/markdown` mimes to.
 */
export const load: PageLoad = async ({ params, fetch }) => {
  const { id: artifactId } = params;
  if (!artifactId) {
    throw error(400, "Missing artifact id");
  }
  return loadArtifactWithProvenance(artifactId, fetch);
};

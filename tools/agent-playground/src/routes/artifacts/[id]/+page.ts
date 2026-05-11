import { error, redirect } from "@sveltejs/kit";
import { TABULAR_MIMES } from "$lib/components/chat/table-parsers.ts";
import type { PageLoad } from "./$types";

/**
 * Artifact view dispatcher. Reads the artifact's mimeType and routes
 * to the renderer best suited to it:
 *
 *   text/csv, text/tab-separated-values, application/json,
 *   text/html                         → `./table` (full-screen
 *                                       sticky-header view with
 *                                       Copy / Download CSV / Download
 *                                       MD action bar)
 *
 *   text/markdown                     → `./markdown` (prose renderer
 *                                       that surfaces embedded GFM
 *                                       tables inline via TableView +
 *                                       the same action chrome)
 *
 *   anything else                     → render a file-info card with
 *                                       a download link inline on
 *                                       this same page
 *
 * Subpath renderers (`./table`, `./markdown`, future `./raw`,
 * `./diff/[rev]`) are the explicit-override URLs. This bare path is
 * the "open the artifact" URL — what tool-call cards and the inline-
 * table Actions menu link to.
 */
export const load: PageLoad = async ({ params, fetch }) => {
  const { id: artifactId } = params;
  if (!artifactId) {
    throw error(400, "Missing artifact id");
  }

  const metaUrl = `/api/daemon/api/artifacts/${encodeURIComponent(artifactId)}`;
  const metaRes = await fetch(metaUrl);
  if (metaRes.status === 404) {
    throw error(404, "Artifact not found");
  }
  if (!metaRes.ok) {
    throw error(metaRes.status, `Failed to load artifact: ${metaRes.status}`);
  }
  const body = (await metaRes.json()) as {
    artifact?: {
      title?: string;
      data?: { mimeType?: string; originalName?: string; size?: number };
    };
  };
  const artifact = body.artifact;
  if (!artifact) {
    throw error(500, "Artifact response missing metadata");
  }
  const baseMime = (artifact.data?.mimeType ?? "application/octet-stream").split(";")[0]?.trim().toLowerCase() ?? "";
  if (baseMime === "text/markdown") {
    throw redirect(307, `/artifacts/${encodeURIComponent(artifactId)}/markdown`);
  }
  if (TABULAR_MIMES.has(baseMime)) {
    // Forward to the explicit table renderer — keeps the table-
    // specific chrome (Copy / Download CSV / Download MD) accessible
    // at a self-describing URL, and lets the user bookmark / share
    // the link without leaning on dispatcher behavior.
    throw redirect(307, `/artifacts/${encodeURIComponent(artifactId)}/table`);
  }

  return {
    artifactId,
    mimeType: artifact.data?.mimeType ?? "application/octet-stream",
    filename: artifact.data?.originalName ?? artifact.title ?? "artifact",
    size: artifact.data?.size,
    contentUrl: `/api/daemon/api/artifacts/${encodeURIComponent(artifactId)}/content`,
  };
};

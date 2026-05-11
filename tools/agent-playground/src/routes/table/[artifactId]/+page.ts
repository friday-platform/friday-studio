import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/**
 * Load the raw bytes of a tabular artifact + the headers we need to
 * pick a parser. The actual parsing happens in the page component so
 * `DOMParser` (browser-only) is available — Sveltekit's universal
 * loader runs on both server and client and we want one code path.
 *
 * Errors that should leave the user stranded (missing artifact, daemon
 * unreachable) throw via `error()` to surface SvelteKit's error page.
 * Parsing failures (the bytes are well-formed but not tabular in any
 * shape we recognize) are handled inline by the +page.svelte so the
 * user sees a graceful "this artifact isn't tabular" fallback with a
 * link to download the original.
 */
export const load: PageLoad = async ({ params, fetch }) => {
  const { artifactId } = params;
  if (!artifactId) {
    throw error(400, "Missing artifactId");
  }

  const contentUrl = `/api/daemon/api/artifacts/${encodeURIComponent(artifactId)}/content`;
  const res = await fetch(contentUrl);
  if (res.status === 404) {
    throw error(404, "Artifact not found");
  }
  if (!res.ok) {
    throw error(res.status, `Failed to load artifact: ${res.status}`);
  }

  const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
  // Pull the original filename out of `Content-Disposition: ...
  // filename="foo.csv"` so the page header can show what was uploaded.
  // The `filename*` form (`filename*=UTF-8''foo.csv`) takes priority
  // when present.
  const disposition = res.headers.get("content-disposition") ?? "";
  const filename = parseFilenameFromDisposition(disposition) ?? "artifact";

  const text = await res.text();

  return {
    artifactId,
    mimeType,
    filename,
    text,
    contentUrl,
  };
};

function parseFilenameFromDisposition(disposition: string): string | null {
  // RFC 5987 filename* (UTF-8 encoded) takes priority over plain filename.
  const star = /filename\*\s*=\s*([^']+)'([^']*)'([^;\n]+)/i.exec(disposition);
  if (star?.[3]) {
    try {
      return decodeURIComponent(star[3].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename\s*=\s*("([^"]+)"|([^;\n]+))/i.exec(disposition);
  if (plain?.[2]) return plain[2].trim();
  if (plain?.[3]) return plain[3].trim();
  return null;
}

import { ArtifactSummarySchema } from "@atlas/core/artifacts";
import type { RequestHandler } from "@sveltejs/kit";
import { artifactZipPath } from "$lib/export/artifact-zip-path";
import { GetChatResponseSchema } from "$lib/components/chat/types";
import faviconUrl from "$lib/assets/favicon.png";
import JSZip from "jszip";
import { z } from "zod";
import { MAX_ARTIFACT_BYTES, MAX_TOTAL_ARTIFACT_BYTES } from "./limits";

/**
 * Hard ceiling on the preview render. The preview load function fans out
 * to the daemon and the artifact list endpoint, so a hung upstream there
 * could pin this route indefinitely. 10s mirrors the prior daemon route's
 * `EXPORT_TIMEOUT_MS` for recipient-facing parity.
 */
const EXPORT_TIMEOUT_MS = 10_000;

const ArtifactsResponseSchema = z.object({ artifacts: z.array(ArtifactSummarySchema) });

/**
 * Replace absolute home-directory prefixes with `~` so shared exports do
 * not reveal the sender's username or local filesystem layout. Tools like
 * `run_code` emit fields such as `scratch_dir: "/Users/<name>/.atlas/..."`
 * in their output JSON, which lands verbatim in both the rendered HTML and
 * the raw chat.json. The rewrite is intentionally narrow:
 *
 *   - `/Users/<name>/...`     (macOS)
 *   - `/home/<name>/...`      (Linux)
 *   - `C:\\Users\\<name>\\...` (Windows, escaped in JSON strings)
 *
 * Kept as a string transform rather than a deep-walk over the message
 * tree so it covers both the SSR'd HTML (where paths appear inside Shiki
 * highlight spans) and the JSON without two parallel implementations.
 */
function scrubHomePaths(input: string): string {
  return input
    .replace(/\/Users\/[^/\s"'<>\\]+/g, "/Users/~")
    .replace(/\/home\/[^/\s"'<>\\]+/g, "/home/~")
    .replace(/C:\\\\Users\\\\[^\\\\\s"'<>]+/g, "C:\\\\Users\\\\~");
}

/**
 * Orchestrate a chat export: render the preview HTML via the in-process
 * SvelteKit route, fetch the raw chat JSON and artifact byte payloads
 * from the daemon, and pack them into a downloadable zip.
 *
 * Layout of the response zip:
 *   - `index.html`                              — preview HTML (verbatim)
 *   - `chat.json`                               — `{ chat, messages, systemPromptContext }`
 *   - `assets/artifacts/{id}/{slugified-name}`  — one entry per successful byte fetch
 *
 * Failure modes:
 *   - Preview render failure (non-2xx)    → return that same status + body
 *   - Preview render exceeds 10s          → 504
 *   - Daemon chat fetch 404               → 404 (the upstream body is forwarded as-is)
 *   - Single artifact byte fetch failure  → server-side `console.warn`, skip the
 *     entry; the HTML keeps the broken `assets/artifacts/...` link, recipient sees
 *     one missing download, the rest of the export is intact.
 *
 * The artifact zip path scheme is shared with the preview's
 * `ExportContext.resolveUrl` via `$lib/export/artifact-zip-path`, so the
 * static HTML's `<img src="...">` URLs resolve to the entry name written
 * here byte-for-byte.
 */
export const GET: RequestHandler = async (event) => {
  const workspaceId = event.params.workspaceId ?? "";
  const chatId = event.params.chatId ?? "";
  const wsPath = encodeURIComponent(workspaceId);
  const chatPath = encodeURIComponent(chatId);

  const previewUrl = `/platform/${wsPath}/chat/${chatPath}/export/preview`;
  const chatUrl = `/api/daemon/api/workspaces/${wsPath}/chat/${chatPath}?full=true`;
  const artifactsUrl = `/api/daemon/api/artifacts?chatId=${chatPath}`;

  // Race the preview render against a 10s ceiling. We abort the inner
  // fetch on timeout so the SvelteKit handler chain can clean up, and
  // return 504 to the caller with a JSON body rather than a half-rendered
  // HTML stub. We also fold in the request signal so a closed browser tab
  // tears down the upstream fetch instead of leaving it pinned.
  const requestSignal = event.request.signal;
  const previewController = new AbortController();
  const previewTimer = setTimeout(() => previewController.abort(), EXPORT_TIMEOUT_MS);
  const previewSignal = AbortSignal.any([requestSignal, previewController.signal]);

  let previewRes: Response;
  try {
    previewRes = await event.fetch(previewUrl, { signal: previewSignal });
  } catch (err) {
    clearTimeout(previewTimer);
    if (previewController.signal.aborted) {
      return new Response(JSON.stringify({ error: "Chat too large to export" }), {
        status: 504,
        headers: { "content-type": "application/json" },
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `preview fetch failed: ${message}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  clearTimeout(previewTimer);

  if (!previewRes.ok) {
    // Forward the upstream status and body so callers see the same shape
    // whether the failure originated in the preview's `load` (e.g. 404
    // for missing chat) or here.
    return new Response(previewRes.body, {
      status: previewRes.status,
      headers: previewRes.headers,
    });
  }
  if (requestSignal.aborted) {
    // Client closed the tab between the preview render and the next fetch.
    // Bail before doing more work — the response we return is discarded by
    // SvelteKit, but 499 is the right status to log if anything sees it.
    return new Response(null, { status: 499 });
  }
  const html = await previewRes.text();

  // Chat JSON and artifact list run in parallel — neither depends on the
  // other and we want the wall-clock pipeline to be max(preview, max(chat,
  // artifacts), max(artifact-bytes…)) rather than a serial sum. The
  // request signal threads through so a tab close tears down the daemon
  // fetches instead of leaving them pinned.
  const [chatRes, artifactsRes] = await Promise.all([
    event.fetch(chatUrl, { signal: requestSignal }),
    event.fetch(artifactsUrl, { signal: requestSignal }),
  ]);

  if (chatRes.status === 404) {
    return new Response(JSON.stringify({ error: "Chat not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  if (!chatRes.ok) {
    return new Response(JSON.stringify({ error: `daemon chat fetch failed: ${chatRes.status}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  const chatJsonRaw: unknown = await chatRes.json();
  const chatParsed = GetChatResponseSchema.safeParse(chatJsonRaw);
  if (!chatParsed.success) {
    return new Response(
      JSON.stringify({ error: `daemon chat schema mismatch: ${chatParsed.error.message}` }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  // Artifact list failures are non-fatal: the HTML still renders without
  // it (ArtifactCards fall back to a placeholder) and an export with
  // missing artifact entries is more useful than no export at all.
  let artifacts: z.infer<typeof ArtifactSummarySchema>[] = [];
  if (artifactsRes.ok) {
    const artifactsJson: unknown = await artifactsRes.json();
    const artifactsParsed = ArtifactsResponseSchema.safeParse(artifactsJson);
    if (artifactsParsed.success) {
      artifacts = artifactsParsed.data.artifacts;
    } else {
      console.warn(
        "[chat-export] artifact list response did not match schema; exporting without bytes",
        artifactsParsed.error.message,
      );
    }
  } else {
    console.warn(
      `[chat-export] artifact list fetch failed (${artifactsRes.status}); exporting without bytes`,
    );
  }

  // Fan out artifact byte reads in parallel via `Promise.allSettled` so a
  // single 404 / network blip can't poison the whole export. Each entry
  // either yields `{ ok: true, path, bytes }` or `{ ok: false }` with a
  // server-side log; we drop the failures and keep building the zip.
  const byteResults = await Promise.allSettled(
    artifacts.map(async (summary) => {
      const res = await event.fetch(
        `/api/daemon/api/artifacts/${encodeURIComponent(summary.id)}/content`,
        { signal: requestSignal },
      );
      if (!res.ok) {
        throw new Error(`status ${res.status}`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      // Per-artifact ceiling. Throwing here lands in the same skip-and-warn
      // path as a fetch failure: the entry is dropped from the zip and the
      // rest of the export proceeds. We pin the message so tests / log
      // greps can distinguish oversize from network failures.
      if (buf.byteLength > MAX_ARTIFACT_BYTES) {
        throw new Error(
          `artifact ${summary.id} exceeds per-artifact byte ceiling (${buf.byteLength} > ${MAX_ARTIFACT_BYTES})`,
        );
      }
      return {
        path: artifactZipPath({
          id: summary.id,
          mimeType: summary.mimeType,
          originalName: summary.originalName,
          title: summary.title,
        }),
        bytes: buf,
      };
    }),
  );

  if (requestSignal.aborted) {
    // Each per-artifact fetch reacts to the request signal by rejecting
    // with `AbortError`, which `Promise.allSettled` swallows into a
    // "rejected" entry — control still falls through here. Bail before
    // building a zip that nobody is waiting for.
    return new Response(null, { status: 499 });
  }

  // Aggregate ceiling. Sum the byte lengths of everything that survived the
  // per-artifact cap; if the total still blows past the limit we 413 before
  // ever calling `zip.generateAsync` — generating a 500 MB zip just to drop
  // it on the floor would burn the request budget for nothing.
  let totalBytes = 0;
  for (const result of byteResults) {
    if (result.status === "fulfilled") {
      totalBytes += result.value.bytes.byteLength;
    }
  }
  if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
    return new Response(
      JSON.stringify({
        error: "Export exceeds size limit",
        totalBytes,
        limit: MAX_TOTAL_ARTIFACT_BYTES,
      }),
      { status: 413, headers: { "content-type": "application/json" } },
    );
  }

  // Fetch the favicon through Vite/SvelteKit's asset pipeline so the same
  // import works in dev (where `faviconUrl` is `/src/lib/...`) and in the
  // compiled binary (where it's `/_app/immutable/assets/favicon-<hash>.png`).
  // A miss is non-fatal — the export still ships, just without a favicon.
  let faviconBytes: Uint8Array | undefined;
  try {
    const faviconRes = await event.fetch(faviconUrl, { signal: requestSignal });
    if (faviconRes.ok) {
      faviconBytes = new Uint8Array(await faviconRes.arrayBuffer());
    } else {
      console.warn(`[chat-export] favicon fetch failed (${faviconRes.status})`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[chat-export] favicon fetch threw: ${message}`);
  }

  const zip = new JSZip();
  zip.file("index.html", scrubHomePaths(html));
  if (faviconBytes) {
    // The chromeless `+layout.svelte` head links `<link rel="icon"
    // href="favicon.png">` so the entry name must match exactly.
    zip.file("favicon.png", faviconBytes);
  }
  // Strip the top-level account-ownership ID from chat.json. The transcript,
  // system prompt context, and tool inputs/outputs are exported verbatim —
  // recipients see what the sender saw, minus absolute home-directory
  // prefixes that tools (e.g. run_code's `scratch_dir`) emit alongside.
  const { userId: _userId, ...chatWithoutUserId } = chatParsed.data.chat;
  const chatJson = JSON.stringify(
    {
      chat: chatWithoutUserId,
      messages: chatParsed.data.messages,
      systemPromptContext: chatParsed.data.systemPromptContext,
    },
    null,
    2,
  );
  zip.file("chat.json", scrubHomePaths(chatJson));
  byteResults.forEach((result, idx) => {
    if (result.status === "fulfilled") {
      zip.file(result.value.path, result.value.bytes);
    } else {
      const summary = artifacts[idx];
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.warn(
        `[chat-export] artifact byte fetch failed for ${summary?.id ?? "<unknown>"}: ${reason}`,
      );
    }
  });

  const zipBytes = await zip.generateAsync({ type: "arraybuffer" });

  return new Response(zipBytes, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="friday-chat-${chatId.slice(0, 8)}.zip"`,
    },
  });
};

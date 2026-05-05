import { ArtifactSummarySchema } from "@atlas/core/artifacts";
import type { RequestHandler } from "@sveltejs/kit";
import { artifactZipPath } from "$lib/export/artifact-zip-path";
import JSZip from "jszip";
import { z } from "zod";

/**
 * Hard ceiling on the preview render. The preview load function fans out
 * to the daemon and the artifact list endpoint, so a hung upstream there
 * could pin this route indefinitely. 10s mirrors the prior daemon route's
 * `EXPORT_TIMEOUT_MS` for recipient-facing parity.
 */
const EXPORT_TIMEOUT_MS = 10_000;

/**
 * Daemon `GET /api/workspaces/:wsId/chat/:chatId?full=true` response shape.
 * Mirrors the Zod schema used by the preview's `+page.server.ts`; we
 * `passthrough()` chat fields the orchestrator doesn't read so the
 * `chat.json` zip entry preserves anything the daemon adds in the future
 * without forcing a schema change here.
 */
const ChatResponseSchema = z.object({
  chat: z
    .object({
      id: z.string(),
      userId: z.string(),
      workspaceId: z.string(),
      source: z.string(),
      title: z.string().optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .passthrough(),
  messages: z.array(z.unknown()),
  systemPromptContext: z
    .object({ timestamp: z.string(), systemMessages: z.array(z.string()) })
    .nullable(),
});

const ArtifactsResponseSchema = z.object({ artifacts: z.array(ArtifactSummarySchema) });

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
  // HTML stub.
  const previewController = new AbortController();
  const previewTimer = setTimeout(() => previewController.abort(), EXPORT_TIMEOUT_MS);

  let previewRes: Response;
  try {
    previewRes = await event.fetch(previewUrl, { signal: previewController.signal });
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
  const html = await previewRes.text();

  // Chat JSON and artifact list run in parallel — neither depends on the
  // other and we want the wall-clock pipeline to be max(preview, max(chat,
  // artifacts), max(artifact-bytes…)) rather than a serial sum.
  const [chatRes, artifactsRes] = await Promise.all([
    event.fetch(chatUrl),
    event.fetch(artifactsUrl),
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
  const chatParsed = ChatResponseSchema.safeParse(chatJsonRaw);
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
      );
      if (!res.ok) {
        throw new Error(`status ${res.status}`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
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

  const zip = new JSZip();
  zip.file("index.html", html);
  // Strip `userId` from the exported chat — it's account-ownership PII and
  // shared exports shouldn't leak it. The schema validates the wire shape
  // upstream; the strip happens at the zip-write boundary.
  const { userId: _userId, ...chatWithoutUserId } = chatParsed.data.chat;
  zip.file(
    "chat.json",
    JSON.stringify(
      {
        chat: chatWithoutUserId,
        messages: chatParsed.data.messages,
        systemPromptContext: chatParsed.data.systemPromptContext,
      },
      null,
      2,
    ),
  );
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

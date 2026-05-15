import { ArtifactSummarySchema } from "@atlas/core/artifacts";
import { Hono } from "hono";
import JSZip from "jszip";
import { z } from "zod";
import { GetChatResponseSchema } from "$lib/components/chat/types";
import { artifactZipPath } from "$lib/export/artifact-zip-path";
import { DAEMON_BASE_URL } from "../../daemon-url.ts";

/**
 * Per-artifact byte ceiling. Anything larger than this is dropped from the
 * zip with a `console.warn`: the entry is omitted, the rest of the export
 * proceeds, the recipient sees one missing download.
 */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
/**
 * Aggregate byte ceiling across every artifact that survives the per-artifact
 * cap. If the running total exceeds this we abort with 413 before the zip is
 * generated rather than streaming a multi-hundred-megabyte response.
 */
export const MAX_TOTAL_ARTIFACT_BYTES = 250 * 1024 * 1024;

const ArtifactsResponseSchema = z.object({ artifacts: z.array(ArtifactSummarySchema) });

/**
 * Replace absolute home-directory prefixes with `~` so shared exports do
 * not reveal the sender's username or local filesystem layout. Tools like
 * `run_code` emit fields such as `scratch_dir: "/Users/<name>/.atlas/..."`
 * in their output JSON, which lands verbatim in chat.json. Kept as a
 * string transform rather than a deep-walk over the message tree so it
 * covers paths nested inside arbitrary tool output without two parallel
 * implementations.
 */
function scrubHomePaths(input: string): string {
  return input
    .replace(/\/Users\/[^/\s"'<>\\]+/g, "/Users/~")
    .replace(/\/home\/[^/\s"'<>\\]+/g, "/home/~")
    .replace(/C:\\\\Users\\\\[^\\\\\s"'<>]+/g, "C:\\\\Users\\\\~");
}

/**
 * Chat export route — `GET /api/export/:workspaceId/:chatId`.
 *
 * Lives in Hono (not a SvelteKit `+server.ts`) because adapter-static strips
 * all server handlers from the compiled build; only `/api/*` Hono routes
 * survive in the `static-server.ts` runtime. The prior route at
 * `routes/platform/.../export/+server.ts` worked in dev (vite SSR) and
 * 404'd through to the SPA fallback in the compiled binary, surfacing as
 * "Unexpected token '<'" when the frontend tried to read the response as
 * a ZIP.
 *
 * Layout of the response zip:
 *   - `chat.json`                               — `{ chat, messages, systemPromptContext }` (userId stripped, home paths scrubbed)
 *   - `assets/artifacts/{id}/{slugified-name}`  — one entry per successful byte fetch
 *
 * No HTML viewer ships in the zip — recipients open `chat.json` directly.
 * If we ever want a viewer it lives as a separate downloadable, not glued
 * into the export pipeline where adapter-static can break it.
 */
export const exportRoute = new Hono().get("/:workspaceId/:chatId", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const chatId = c.req.param("chatId");
  const signal = c.req.raw.signal;

  const wsPath = encodeURIComponent(workspaceId);
  const chatPath = encodeURIComponent(chatId);

  const chatUrl = `${DAEMON_BASE_URL}/api/workspaces/${wsPath}/chat/${chatPath}?full=true`;
  const artifactsUrl = `${DAEMON_BASE_URL}/api/artifacts?chatId=${chatPath}`;

  // Chat JSON and artifact list run in parallel — neither depends on the
  // other and we want the wall-clock pipeline to be max(chat, artifacts,
  // max(artifact-bytes…)) rather than a serial sum.
  let chatRes: Response;
  let artifactsRes: Response;
  try {
    [chatRes, artifactsRes] = await Promise.all([
      fetch(chatUrl, { signal }),
      fetch(artifactsUrl, { signal }),
    ]);
  } catch (err) {
    if (signal.aborted) return new Response(null, { status: 499 });
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `daemon fetch failed: ${message}` }, 502);
  }

  if (chatRes.status === 404) {
    return c.json({ error: "Chat not found" }, 404);
  }
  if (!chatRes.ok) {
    return c.json({ error: `daemon chat fetch failed: ${chatRes.status}` }, 502);
  }

  const chatJsonRaw: unknown = await chatRes.json();
  const chatParsed = GetChatResponseSchema.safeParse(chatJsonRaw);
  if (!chatParsed.success) {
    return c.json(
      { error: `daemon chat schema mismatch: ${chatParsed.error.message}` },
      502,
    );
  }

  // Artifact list failures are non-fatal — an export with missing artifact
  // entries is more useful than no export at all.
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
  // either resolves with `{ path, bytes }` or rejects; we drop rejections
  // and keep building the zip.
  const byteResults = await Promise.allSettled(
    artifacts.map(async (summary) => {
      const res = await fetch(
        `${DAEMON_BASE_URL}/api/artifacts/${encodeURIComponent(summary.id)}/content`,
        { signal },
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
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

  if (signal.aborted) return new Response(null, { status: 499 });

  let totalBytes = 0;
  for (const result of byteResults) {
    if (result.status === "fulfilled") totalBytes += result.value.bytes.byteLength;
  }
  if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
    return c.json(
      {
        error: "Export exceeds size limit",
        totalBytes,
        limit: MAX_TOTAL_ARTIFACT_BYTES,
      },
      413,
    );
  }

  const zip = new JSZip();
  // Strip the account-ownership id. Transcript, system prompt context, and
  // tool I/O are exported verbatim — recipients see what the sender saw,
  // minus the username paths scrubHomePaths catches downstream.
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
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
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
});

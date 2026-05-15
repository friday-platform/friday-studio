import { ArtifactSummarySchema } from "@atlas/core/artifacts";
import { Hono } from "hono";
import JSZip from "jszip";
import { z } from "zod";
import { GetChatResponseSchema } from "../../components/chat/types.ts";
import { artifactZipPath } from "../../export/artifact-zip-path.ts";
import { effectiveDaemonUrl } from "../daemon-url.ts";

/**
 * Per-artifact byte ceiling. Anything larger than this is dropped from the
 * zip with a `console.warn`: the entry is omitted, the rest of the export
 * proceeds, the recipient sees one missing download.
 */
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
/**
 * Aggregate byte ceiling across every artifact that survives the per-artifact
 * cap. If the running total exceeds this we abort with 413 before the zip is
 * generated rather than streaming a multi-hundred-megabyte response.
 */
const MAX_TOTAL_ARTIFACT_BYTES = 250 * 1024 * 1024;

const ArtifactsResponseSchema = z.object({ artifacts: z.array(ArtifactSummarySchema) });
type ArtifactSummary = z.infer<typeof ArtifactSummarySchema>;

/** Return true when an artifact id cannot safely be embedded as one URL path segment. */
function unsafeArtifactIdPathSegment(id: string): boolean {
  return /^\.+$/.test(id) || id.includes("/") || id.includes("\\");
}

/** Read a response body while enforcing a byte ceiling before full allocation. */
async function readResponseBytesWithLimit(res: Response, limit: number): Promise<Uint8Array> {
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > limit) {
      throw new Error(
        `artifact exceeds per-artifact byte ceiling (${bytes.byteLength} > ${limit})`,
      );
    }
    return bytes;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new Error(`artifact exceeds per-artifact byte ceiling (${total} > ${limit})`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released after cancellation.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Fetch artifact summaries, degrading non-abort failures to an empty artifact list. */
async function fetchArtifactSummaries(
  artifactsUrl: string,
  signal: AbortSignal,
): Promise<ArtifactSummary[]> {
  let artifactsRes: Response;
  try {
    artifactsRes = await fetch(artifactsUrl, { signal });
  } catch (err) {
    if (signal.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[chat-export] artifact list fetch failed (${message}); exporting without bytes`);
    return [];
  }

  if (!artifactsRes.ok) {
    console.warn(
      `[chat-export] artifact list fetch failed (${artifactsRes.status}); exporting without bytes`,
    );
    return [];
  }

  let artifactsJson: unknown;
  try {
    artifactsJson = await artifactsRes.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[chat-export] artifact list JSON parse failed (${message}); exporting without bytes`,
    );
    return [];
  }

  const artifactsParsed = ArtifactsResponseSchema.safeParse(artifactsJson);
  if (!artifactsParsed.success) {
    console.warn(
      "[chat-export] artifact list response did not match schema; exporting without bytes",
      artifactsParsed.error.message,
    );
    return [];
  }
  return artifactsParsed.data.artifacts;
}

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
  const daemonBaseUrl = effectiveDaemonUrl().replace(/\/+$/, "");

  const chatUrl = `${daemonBaseUrl}/api/workspaces/${wsPath}/chat/${chatPath}?full=true`;
  const artifactsUrl = `${daemonBaseUrl}/api/artifacts?chatId=${chatPath}`;

  let chatRes: Response;
  try {
    chatRes = await fetch(chatUrl, { signal });
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

  let chatJsonRaw: unknown;
  try {
    chatJsonRaw = await chatRes.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `daemon chat JSON parse failed: ${message}` }, 502);
  }
  const chatParsed = GetChatResponseSchema.safeParse(chatJsonRaw);
  if (!chatParsed.success) {
    return c.json({ error: `daemon chat schema mismatch: ${chatParsed.error.message}` }, 502);
  }

  // Artifact list failures are non-fatal — an export with missing artifact
  // entries is more useful than no export at all.
  let artifacts: ArtifactSummary[];
  try {
    artifacts = await fetchArtifactSummaries(artifactsUrl, signal);
  } catch (err) {
    if (signal.aborted) return new Response(null, { status: 499 });
    throw err;
  }

  if (signal.aborted) return new Response(null, { status: 499 });

  const fetchableArtifacts: ArtifactSummary[] = [];
  let plannedBytes = 0;
  for (const summary of artifacts) {
    if (unsafeArtifactIdPathSegment(summary.id)) {
      console.warn(`[chat-export] skipping artifact with unsafe id path segment: ${summary.id}`);
      continue;
    }
    if (summary.size > MAX_ARTIFACT_BYTES) {
      console.warn(
        `[chat-export] skipping artifact ${summary.id}: declared size exceeds per-artifact byte ceiling (${summary.size} > ${MAX_ARTIFACT_BYTES})`,
      );
      continue;
    }
    plannedBytes += summary.size;
    if (plannedBytes > MAX_TOTAL_ARTIFACT_BYTES) {
      return c.json(
        {
          error: "Export exceeds size limit",
          totalBytes: plannedBytes,
          limit: MAX_TOTAL_ARTIFACT_BYTES,
        },
        413,
      );
    }
    fetchableArtifacts.push(summary);
  }

  // Read artifact bytes one at a time so the byte ceilings are real memory
  // bounds, not post-hoc checks after a parallel fan-out has already
  // allocated every response body.
  const byteResults: PromiseSettledResult<{ path: string; bytes: Uint8Array }>[] = [];
  let downloadedBytes = 0;
  for (const summary of fetchableArtifacts) {
    if (signal.aborted) return new Response(null, { status: 499 });
    try {
      const res = await fetch(
        `${daemonBaseUrl}/api/artifacts/${encodeURIComponent(summary.id)}/content`,
        { signal },
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      const buf = await readResponseBytesWithLimit(res, MAX_ARTIFACT_BYTES);
      downloadedBytes += buf.byteLength;
      if (downloadedBytes > MAX_TOTAL_ARTIFACT_BYTES) {
        return c.json(
          {
            error: "Export exceeds size limit",
            totalBytes: downloadedBytes,
            limit: MAX_TOTAL_ARTIFACT_BYTES,
          },
          413,
        );
      }
      byteResults.push({
        status: "fulfilled",
        value: {
          path: artifactZipPath({
            id: summary.id,
            mimeType: summary.mimeType,
            originalName: summary.originalName,
            title: summary.title,
          }),
          bytes: buf,
        },
      });
    } catch (err) {
      if (signal.aborted) return new Response(null, { status: 499 });
      byteResults.push({ status: "rejected", reason: err });
    }
  }

  if (signal.aborted) return new Response(null, { status: 499 });

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
      const summary = fetchableArtifacts[idx];
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
});

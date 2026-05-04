/**
 * Lift oversized binary out of MCP tool results into the artifact Object
 * Store. Returns a scrub function suitable for `CreateMCPToolsOptions.scrubResult`.
 *
 * Why scrub at the MCP boundary: bytes that an MCP returns inline (Gmail's
 * `get_gmail_attachment_content` with `return_base64=True`, image responses,
 * etc.) flow into the AI SDK message buffer, then to the LLM as prompt
 * tokens, then to chat persistence. Each hop has a cost. Catching them as
 * the tool returns means the LLM sees a reference, the message buffer stays
 * small, and persistence never hits `MAX_PAYLOAD_EXCEEDED`.
 *
 * The scrubber walks the result recursively. For each string field that
 * looks like binary content above the size threshold:
 *   - data URLs: `data:<mime>;base64,<bytes>` → upload bytes, replace with marker
 *   - standalone base64 blobs (long, base64-character-class only) → upload, replace
 *
 * The replacement marker is short text describing what was lifted, the
 * resulting `artifactId`, byte size, and mime type. The model can call
 * `display_artifact` or `artifacts_get` to recover the bytes if it needs
 * them in a follow-up turn.
 *
 * Failures (network, storage) are swallowed by the caller (`create-mcp-tools.ts`
 * wraps with try/catch) so a scrub failure never breaks tool execution. The
 * pre-persist scrubber serves as a second line of defense.
 */

import { client, parseResult } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";
import type { ScrubToolResult } from "@atlas/mcp";

/**
 * Strings shorter than this are left alone. ~64 KB chars of base64 ≈ 48 KB
 * of decoded bytes. Below this size, inlining is cheap and persistence
 * never gets close to the 8 MB JetStream message limit.
 */
const SIZE_THRESHOLD_CHARS = 64 * 1024;

/**
 * Recursion depth ceiling. MCP results are usually shallow JSON; this is a
 * sanity stop in case some server returns pathological self-referential
 * shapes wrapped in containers.
 */
const MAX_DEPTH = 16;

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/s;

/**
 * Loose base64 character-class check. Doesn't validate strict base64 (which
 * would reject internal whitespace) — just confirms the string is plausibly
 * an opaque base64 blob, not human-readable text. Combined with the size
 * threshold this keeps the false-positive rate low.
 */
const BASE64_BODY_RE = /^[A-Za-z0-9+/_=\-\s]+$/;

/** Heuristic: a base64-looking string that's mostly base64 chars (>95%). */
function looksLikeBase64(s: string): boolean {
  if (s.length < SIZE_THRESHOLD_CHARS) return false;
  if (!BASE64_BODY_RE.test(s)) return false;
  // Belt-and-suspenders: count non-base64-ish chars in case the regex passed
  // but the string is just a long word with the right char class.
  let bad = 0;
  for (let i = 0; i < Math.min(s.length, 4096); i++) {
    const c = s.charCodeAt(i);
    const isAlnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    const isBase64Punct = c === 43 || c === 47 || c === 61 || c === 95 || c === 45; // + / = _ -
    const isWS = c === 32 || c === 9 || c === 10 || c === 13;
    if (!isAlnum && !isBase64Punct && !isWS) bad++;
  }
  return bad === 0;
}

interface ScrubContext {
  workspaceId: string;
  chatId: string;
  logger: Logger;
}

interface UploadResult {
  artifactId: string;
  bytes: number;
  mimeType: string;
}

async function uploadBlob(
  base64: string,
  mimeType: string | undefined,
  filename: string,
  ctx: ScrubContext,
  toolCtx: { serverId: string; toolName: string },
): Promise<UploadResult | null> {
  const data = {
    type: "file" as const,
    content: base64,
    contentEncoding: "base64" as const,
    ...(mimeType ? { mimeType } : {}),
    originalName: filename,
  };
  const response = await parseResult(
    client.artifactsStorage.index.$post({
      json: {
        data,
        title: filename,
        summary: `Auto-lifted from ${toolCtx.serverId}/${toolCtx.toolName}`,
        workspaceId: ctx.workspaceId,
        chatId: ctx.chatId,
      },
    }),
  );
  if (!response.ok) {
    ctx.logger.warn("scrub upload failed", {
      serverId: toolCtx.serverId,
      toolName: toolCtx.toolName,
      error: String(response.error),
    });
    return null;
  }
  // The artifact record carries the final mimeType + size from the storage
  // adapter's mime-sniff path; prefer those for the marker text.
  const a = response.data.artifact;
  const fileData = a.data?.type === "file" ? a.data : null;
  return {
    artifactId: a.id,
    bytes: fileData?.size ?? Math.ceil((base64.length * 3) / 4),
    mimeType: fileData?.mimeType ?? mimeType ?? "application/octet-stream",
  };
}

function refMarker(r: UploadResult, toolCtx: { serverId: string; toolName: string }): string {
  const kb = Math.ceil(r.bytes / 1024);
  return (
    `[attachment lifted to artifact ${r.artifactId} ` +
    `(${kb} KB, ${r.mimeType}, from ${toolCtx.serverId}/${toolCtx.toolName}) — ` +
    `use display_artifact or artifacts_get to read]`
  );
}

/** Synthetic filename when the source didn't carry one. */
function defaultFilename(mime: string | undefined, toolCtx: { toolName: string }): string {
  const ext = mime?.split("/")[1]?.split(";")[0]?.split("+")[0] || "bin";
  return `${toolCtx.toolName}-${Date.now()}.${ext}`;
}

async function scrubString(
  s: string,
  ctx: ScrubContext,
  toolCtx: { serverId: string; toolName: string },
): Promise<string> {
  // Data URL: pull mime + base64 body out of the prefix.
  const dataUrlMatch = s.match(DATA_URL_RE);
  if (dataUrlMatch) {
    const [, mime, body] = dataUrlMatch;
    if (body && body.length >= SIZE_THRESHOLD_CHARS) {
      const filename = defaultFilename(mime, toolCtx);
      const result = await uploadBlob(body, mime, filename, ctx, toolCtx);
      if (result) return refMarker(result, toolCtx);
    }
    return s;
  }
  // Standalone base64-looking blob.
  if (looksLikeBase64(s)) {
    const filename = defaultFilename(undefined, toolCtx);
    // Strip whitespace so the artifact storage gets clean base64.
    const clean = s.replace(/\s+/g, "");
    const result = await uploadBlob(clean, undefined, filename, ctx, toolCtx);
    if (result) return refMarker(result, toolCtx);
  }
  return s;
}

async function scrubValue(
  value: unknown,
  ctx: ScrubContext,
  toolCtx: { serverId: string; toolName: string },
  depth: number,
): Promise<unknown> {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === "string") {
    return await scrubString(value, ctx, toolCtx);
  }
  if (Array.isArray(value)) {
    return await Promise.all(value.map((v) => scrubValue(v, ctx, toolCtx, depth + 1)));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = await scrubValue(v, ctx, toolCtx, depth + 1);
    }
    return out;
  }
  return value;
}

export interface ScrubberOptions {
  workspaceId: string;
  chatId: string;
  logger: Logger;
}

/** Build a scrub function bound to a workspace + chat for artifact-tagging. */
export function createScrubber(opts: ScrubberOptions): ScrubToolResult {
  const ctx: ScrubContext = {
    workspaceId: opts.workspaceId,
    chatId: opts.chatId,
    logger: opts.logger,
  };
  return (result, toolCtx) => scrubValue(result, ctx, toolCtx, 0);
}

/**
 * Pre-persist scrubber — defense-in-depth for anything that slipped past
 * the MCP-boundary scrubber. Walks an assistant message's `tool-*` part
 * outputs (and `data-delegate-chunk` chunks, which can carry tool-result
 * envelopes from sub-agents) and lifts oversized binary into artifacts.
 *
 * Mutates the passed message; returns the count of fields rewritten so
 * the caller can decide whether to log.
 */
export async function scrubAssistantMessage(
  parts: Array<Record<string, unknown>>,
  opts: ScrubberOptions,
): Promise<{ scanned: number; rewritten: number }> {
  const ctx: ScrubContext = {
    workspaceId: opts.workspaceId,
    chatId: opts.chatId,
    logger: opts.logger,
  };
  let scanned = 0;
  let rewritten = 0;
  for (const part of parts) {
    const type = typeof part.type === "string" ? part.type : "";
    // Tool call outputs from the parent's own tool-use steps.
    if (type.startsWith("tool-") && "output" in part) {
      scanned++;
      const before = JSON.stringify(part.output);
      const after = await scrubValue(
        part.output,
        ctx,
        { serverId: "pre-persist", toolName: type },
        0,
      );
      if (JSON.stringify(after) !== before) {
        part.output = after;
        rewritten++;
      }
    }
    // Sub-agent stream envelopes — chunk may carry an embedded tool result.
    if (type === "data-delegate-chunk" && part.data && typeof part.data === "object") {
      scanned++;
      const data = part.data as Record<string, unknown>;
      if ("chunk" in data) {
        const before = JSON.stringify(data.chunk);
        const after = await scrubValue(
          data.chunk,
          ctx,
          { serverId: "pre-persist", toolName: "delegate-chunk" },
          0,
        );
        if (JSON.stringify(after) !== before) {
          data.chunk = after;
          rewritten++;
        }
      }
    }
  }
  return { scanned, rewritten };
}

// Exported for unit tests.
export const __test = { looksLikeBase64, DATA_URL_RE, SIZE_THRESHOLD_CHARS };

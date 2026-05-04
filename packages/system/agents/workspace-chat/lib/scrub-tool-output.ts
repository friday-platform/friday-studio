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
 * Below this size in chars, base64 stays inline. ~4 KB chars of base64 ≈
 * 3 KB of decoded bytes — small attachments stay in the prompt; larger
 * ones get lifted to artifacts before the model has a chance to emit them
 * back into the next tool call.
 *
 * Why so much lower than the 8 MB JetStream message limit: persistence
 * isn't the only cost. A model that sees inline base64 may decide to
 * forward those bytes into a subsequent tool call (e.g. embedding them
 * as a string literal in run_code), which costs prompt tokens, output
 * tokens, and turn latency. 4 KB is the floor below which those costs
 * are minor; above it, lift.
 */
const SIZE_THRESHOLD_CHARS = 4 * 1024;

/**
 * Recursion depth ceiling. MCP results are usually shallow JSON; this is a
 * sanity stop in case some server returns pathological self-referential
 * shapes wrapped in containers.
 */
const MAX_DEPTH = 16;

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/s;

/**
 * Match a contiguous run of base64 characters of at least
 * `SIZE_THRESHOLD_CHARS` length, with optional `=` padding. Used to find
 * base64 blobs *embedded* inside larger strings — Gmail's
 * `get_gmail_attachment_content`, for example, returns base64 inside a
 * text envelope ("Attachment downloaded ...\nBase64 content (XXX chars):\n
 * <base64>\n"). Whole-string detection misses those because the
 * surrounding prose breaks the character class.
 *
 * The regex is intentionally strict (no internal whitespace) — that
 * matches the single-line format MCPs use in practice and keeps false
 * positives low. Multi-line base64 (RFC-2045 76-char wrap) would need
 * a different match shape; not seen in the wild from the MCPs Friday
 * talks to today.
 *
 * Built lazily because the threshold is referenced as a number of chars.
 */
const EMBEDDED_BASE64_RE = new RegExp(`[A-Za-z0-9+/]{${SIZE_THRESHOLD_CHARS},}={0,2}`, "g");

interface ScrubContext {
  workspaceId: string;
  chatId: string;
  logger: Logger;
  /**
   * Per-call cache: base64 → in-flight or resolved upload promise. Some
   * MCP servers wrap their results in formats that duplicate the payload
   * (e.g. FastMCP returns both `content[].text` and
   * `structuredContent.result` with the same bytes). The recursive walker
   * would otherwise upload the same blob twice, producing two artifact
   * metadata records pointing at the same Object Store entry.
   *
   * Caching the *promise* (not the resolved result) handles two cases:
   *   - Sequential (object branch of scrubValue): the second access sees
   *     the resolved promise via cache hit.
   *   - Parallel (array branch via Promise.all): both callers fall into
   *     `uploadBlob` before either await resolves; whichever sets the
   *     cache first, the other gets the same in-flight promise back and
   *     awaits it instead of issuing a duplicate request.
   *
   * Cache is per-tool-call — no cross-call invalidation concerns.
   */
  uploads: Map<string, Promise<UploadResult | null>>;
}

interface UploadResult {
  artifactId: string;
  bytes: number;
  mimeType: string;
}

function uploadBlob(
  base64: string,
  mimeType: string | undefined,
  filename: string,
  ctx: ScrubContext,
  toolCtx: { serverId: string; toolName: string },
): Promise<UploadResult | null> {
  // Per-call dedup that's race-safe across concurrent callers (the array
  // branch of `scrubValue` runs siblings via Promise.all; both could land
  // on the same base64 between cache miss and resolved Set otherwise).
  // Caching the in-flight promise — not the resolved result — means the
  // second caller awaits the same upload instead of issuing a duplicate.
  const cached = ctx.uploads.get(base64);
  if (cached) return cached;

  const promise = doUploadBlob(base64, mimeType, filename, ctx, toolCtx);
  ctx.uploads.set(base64, promise);
  return promise;
}

async function doUploadBlob(
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

/**
 * Magic-byte prefixes for common binary formats, mapped to the base64
 * prefix they produce. Used by {@link sniffMimeFromBase64} to guess the
 * mime when an embedded base64 blob shows up with no surrounding mime
 * hint (Gmail's get_gmail_attachment_content envelope is the typical
 * source). Without this the scrubber uploads with no mime, the artifact
 * gets a ".bin" extension in its synthesized filename, and downloads
 * land as `foo.bin` instead of `foo.pdf`.
 *
 * Standard base64 alphabet — Gmail's _format_base64_content_block converts
 * URL-safe to standard before emitting, so we only need the standard form.
 */
const BASE64_MAGIC_PREFIXES: Array<[string, string]> = [
  ["JVBERi", "application/pdf"], //  %PDF-
  ["iVBORw0K", "image/png"], //  PNG signature
  ["/9j/", "image/jpeg"], //  JPEG SOI + JFIF/EXIF marker
  ["R0lGOD", "image/gif"], //  GIF87a / GIF89a
  ["UklGR", "image/webp"], //  RIFF…WEBP (also matches WAV; PDF case is what we care about)
  ["UEsDB", "application/zip"], //  ZIP local file header (DOCX/PPTX/XLSX use this)
];

function sniffMimeFromBase64(base64: string): string | undefined {
  const head = base64.slice(0, 12);
  for (const [prefix, mime] of BASE64_MAGIC_PREFIXES) {
    if (head.startsWith(prefix)) return mime;
  }
  return undefined;
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
  // Whole-string data URL — preserve the mime hint when uploading.
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
  // Embedded base64 blocks. Find every contiguous run >= threshold,
  // upload it, and splice the marker into its place. Done left-to-right
  // by re-matching from a moving offset so the splice doesn't invalidate
  // subsequent match indices.
  let result = s;
  let cursor = 0;
  // Bound iterations defensively — pathological input could in theory
  // produce many matches; in practice tool outputs have one block.
  for (let i = 0; i < 32; i++) {
    EMBEDDED_BASE64_RE.lastIndex = cursor;
    const m = EMBEDDED_BASE64_RE.exec(result);
    if (!m) break;
    const block = m[0];
    const sniffed = sniffMimeFromBase64(block);
    const filename = defaultFilename(sniffed, toolCtx);
    const upload = await uploadBlob(block, sniffed, filename, ctx, toolCtx);
    if (!upload) {
      // Move past this match to avoid an infinite loop on transient
      // upload failure; another scrub pass (e.g. pre-persist) can retry.
      cursor = m.index + block.length;
      continue;
    }
    const marker = refMarker(upload, toolCtx);
    result = result.slice(0, m.index) + marker + result.slice(m.index + block.length);
    cursor = m.index + marker.length;
  }
  return result;
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
  return (result, toolCtx) => {
    // Fresh upload cache per tool-call so dedup is scoped to one result
    // tree (FastMCP and similar wrappers duplicate payloads inside a
    // single response — no cross-call sharing needed).
    const ctx: ScrubContext = {
      workspaceId: opts.workspaceId,
      chatId: opts.chatId,
      logger: opts.logger,
      uploads: new Map(),
    };
    return scrubValue(result, ctx, toolCtx, 0);
  };
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
  // Single cache spans the whole message so duplicated payloads across
  // parts (e.g. a tool-output AND a sibling delegate-chunk carrying the
  // same wrapped result) collapse to one artifact.
  const ctx: ScrubContext = {
    workspaceId: opts.workspaceId,
    chatId: opts.chatId,
    logger: opts.logger,
    uploads: new Map(),
  };
  let scanned = 0;
  let rewritten = 0;

  /** Run the scrub on a value; replace via the writeback fn if it changed. */
  const scrubField = async (
    value: unknown,
    serverId: string,
    toolName: string,
    writeback: (next: unknown) => void,
  ) => {
    scanned++;
    const before = JSON.stringify(value);
    const after = await scrubValue(value, ctx, { serverId, toolName }, 0);
    if (JSON.stringify(after) !== before) {
      writeback(after);
      rewritten++;
    }
  };

  for (const part of parts) {
    const type = typeof part.type === "string" ? part.type : "";
    // Tool calls from the parent's own tool-use steps. Both `input` and
    // `output` get scrubbed — `output` covers MCP-server returns that
    // bypassed the boundary scrubber; `input` covers the case where the
    // model embedded base64 *into* a tool call (e.g. assigning bytes to a
    // string literal in `run_code`'s source argument). Without input scrub,
    // those bytes survive into chat history and into the next turn's prompt.
    if (type.startsWith("tool-")) {
      if ("output" in part) {
        await scrubField(part.output, "pre-persist", type, (next) => {
          part.output = next;
        });
      }
      if ("input" in part) {
        await scrubField(part.input, "pre-persist", `${type}.input`, (next) => {
          part.input = next;
        });
      }
    }
    // Sub-agent stream envelopes — chunk may carry an embedded tool
    // result OR an embedded tool input (the sub-agent emitting bytes into
    // its own next tool call). Walk the whole chunk; scrubValue recurses.
    if (type === "data-delegate-chunk" && part.data && typeof part.data === "object") {
      const data = part.data as Record<string, unknown>;
      if ("chunk" in data) {
        await scrubField(data.chunk, "pre-persist", "delegate-chunk", (next) => {
          data.chunk = next;
        });
      }
    }
  }
  return { scanned, rewritten };
}

// Exported for unit tests.
export const __test = { DATA_URL_RE, EMBEDDED_BASE64_RE, SIZE_THRESHOLD_CHARS };

<script lang="ts">
import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { IconSmall, Icons } from "@atlas/ui";
import { onMount, tick } from "svelte";
import { z } from "zod";
import ChatMessageList from "$lib/components/chat/chat-message-list.svelte";
import { extractToolCalls, flattenToolCalls } from "$lib/components/chat/extract-tool-calls.ts";
import type { ChatMessage, Segment, ToolCallDisplay } from "$lib/components/chat/types";

const RawMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant", "system"]),
    parts: z.array(z.unknown()).default([]),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const RawChatSchema = z
  .object({
    chat: z
      .object({
        id: z.string(),
        workspaceId: z.string(),
        title: z.string().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
      })
      .passthrough(),
    messages: z.array(RawMessageSchema),
    _sourceUrl: z.string().optional(),
  })
  .passthrough();

const SnapshotSchema = z.object({
  capturedAt: z.string().optional(),
  chats: z.array(RawChatSchema),
});

type RawMessage = z.infer<typeof RawMessageSchema>;
type RawChat = z.infer<typeof RawChatSchema>;
type Snapshot = z.infer<typeof SnapshotSchema>;
type MessageWithParts = { id: string; parts: unknown[] };

type ReplayEvent =
  | {
      kind: "workspace";
      chatIndex: number;
      workspaceId: string;
      chat: RawChat;
      label: string;
      detail: string;
    }
  | {
      kind: "part";
      chatIndex: number;
      messageIndex: number;
      partIndex: number;
      workspaceId: string;
      chat: RawChat;
      message: RawMessage;
      label: string;
      detail: string;
    };

let snapshot: Snapshot = $state({ capturedAt: new Date().toISOString(), chats: [] });
let currentIndex = $state(0);
let playing = $state(false);
let speedMs = $state(650);
let loadError = $state<string | null>(null);
let loading = $state(false);
let urlText = $state("");
let inspectorOpen = $state(true);
let overlayOpen = $state(true);
let timer: number | undefined = $state();
let toggleVisible = $state(true);
let toggleHideTimer: number | undefined;
let eventDelays = $state<Record<number, number>>({});
let loadedUrls = $state<string[]>([]);
let timelineFilter = $state<number | null>(null);
let editingDelayIndex = $state<number | null>(null);
let speedFactor = $state(1.0);
let useSourceTiming = $state(false);
let mounted = $state(false);

function showToggle() {
  toggleVisible = true;
  if (toggleHideTimer !== undefined) window.clearTimeout(toggleHideTimer);
  toggleHideTimer = window.setTimeout(() => {
    toggleVisible = false;
  }, 2500);
}
let piiEnabled = $state(false);
let piiCategories = $state({ email: true, phone: true, ip: true, uuid: true });
let piiCustomTermsText = $state("");
let chatAspect = $state("full");
let aspectPreviewActive = $state(false);
let aspectPreviewTimer: number | undefined;

const ASPECT_OPTIONS = [
  { value: "full", label: "Full width" },
  { value: "mobile", label: "Mobile (390px)" },
  { value: "tablet", label: "Tablet (768px)" },
  { value: "16:9", label: "16:9 — Landscape" },
  { value: "9:16", label: "9:16 — Shorts/Reels" },
  { value: "4:3", label: "4:3 — Classic TV" },
  { value: "3:4", label: "3:4 — Portrait tablet" },
  { value: "1:1", label: "1:1 — Square" },
  { value: "21:9", label: "21:9 — Ultra-wide" },
] as const;

const SPEED_PRESETS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0];

const chatMainStyle = $derived(
  chatAspect !== "full" ? "justify-items: center; align-items: center;" : "",
);
const chatPanelStyle = $derived(
  chatAspect === "full"
    ? ""
    : chatAspect === "mobile"
      ? "max-inline-size: 390px; margin-inline: auto;"
      : chatAspect === "tablet"
        ? "max-inline-size: 768px; margin-inline: auto;"
        : `aspect-ratio: ${chatAspect.replace(":", " / ")}; block-size: auto; max-block-size: calc(100dvh - var(--size-2)); margin-inline: auto;`,
);

const events = $derived(buildEvents(snapshot));
const currentEvent = $derived(events[currentIndex]);
const visibleMessages = $derived(buildVisibleMessages(snapshot, currentIndex));
const naturalEventDelays = $derived(buildNaturalDelays(events));

// --- PII filter ---

const FAKE_FIRST = [
  "alice",
  "bob",
  "charlie",
  "diana",
  "evan",
  "fiona",
  "george",
  "helen",
  "ivan",
  "julia",
  "kai",
  "lena",
];
const FAKE_LAST = [
  "smith",
  "jones",
  "chen",
  "patel",
  "nguyen",
  "kim",
  "garcia",
  "mueller",
  "santos",
  "okonkwo",
];
const FAKE_DOMAINS = ["example.com", "test.org", "sample.net", "demo.io", "placeholder.dev"];

function stableHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getPersona(key: string) {
  const h = stableHash(key.toLowerCase());
  return {
    first: FAKE_FIRST[h % FAKE_FIRST.length],
    last: FAKE_LAST[(h >> 4) % FAKE_LAST.length],
    domain: FAKE_DOMAINS[(h >> 8) % FAKE_DOMAINS.length],
  };
}

function fakeEmail(original: string): string {
  const { first, last, domain } = getPersona(original);
  return `${first}.${last}@${domain}`;
}

function fakePhone(original: string): string {
  const h = stableHash(original);
  const area = 200 + (h % 800);
  const mid = String(100 + ((h >> 4) % 900)).padStart(3, "0");
  const last = String(1000 + ((h >> 8) % 9000)).padStart(4, "0");
  return `(${area}) ${mid}-${last}`;
}

function fakeIp(original: string): string {
  const h = stableHash(original);
  return `203.0.113.${(h % 254) + 1}`;
}

function fakeUuid(original: string): string {
  const h = stableHash(original);
  const hex = (n: number, len: number) => (n >>> 0).toString(16).padStart(len, "0").slice(0, len);
  return `${hex(h, 8)}-${hex(h >> 4, 4)}-4${hex(h >> 8, 3)}-${["8", "9", "a", "b"][h & 3]}${hex(h >> 12, 3)}-${hex(h, 12)}`;
}

function fakeName(original: string): string {
  const { first, last } = getPersona(original);
  return `${cap(first)} ${cap(last)}`;
}

function parsedCustomTermGroups(): Array<{ aliases: string[]; replacement: string | null }> {
  return piiCustomTermsText
    .split(/\n+/)
    .map((line) => {
      const [aliasPart = "", replacementPart] = line.split(/→|->/, 2);
      const aliases = aliasPart
        .split(/,+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const replacement = replacementPart?.trim() || null;
      return { aliases, replacement };
    })
    .filter((g) => g.aliases.length > 0);
}

function filterJson(value: unknown): unknown {
  if (typeof value === "string") return filterText(value);
  if (Array.isArray(value)) return value.map(filterJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, filterJson(v)]),
    );
  }
  return value;
}

function filterToolCall(call: ToolCallDisplay): ToolCallDisplay {
  return {
    ...call,
    input: filterJson(call.input),
    output: filterJson(call.output),
    errorText: call.errorText !== undefined ? filterText(call.errorText) : undefined,
    reasoning: call.reasoning !== undefined ? filterText(call.reasoning) : undefined,
    children: call.children?.map(filterToolCall),
  };
}

function filterText(text: string): string {
  if (!piiEnabled) return text;
  let s = text;
  if (piiCategories.uuid)
    s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, fakeUuid);
  if (piiCategories.email) {
    // "Display Name <email>" — use the email's persona for both so they always match
    const placed = new Set<string>();
    s = s.replace(
      /([A-Za-z][a-zA-Z'-]*(?: [A-Za-z][a-zA-Z'-]*){0,3})\s*<([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>/g,
      (_, _name, email) => {
        const { first, last, domain } = getPersona(email);
        const fe = `${first}.${last}@${domain}`;
        placed.add(fe);
        return `${cap(first)} ${cap(last)} <${fe}>`;
      },
    );
    // Standalone emails — skip ones already placed by the combined pattern above
    s = s.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (email) =>
      placed.has(email) ? email : fakeEmail(email),
    );
  }
  if (piiCategories.ip)
    s = s.replace(
      /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
      fakeIp,
    );
  if (piiCategories.phone)
    s = s.replace(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g, fakePhone);
  for (const { aliases, replacement } of parsedCustomTermGroups()) {
    const text = replacement ?? fakeName(aliases[0]!);
    for (const alias of aliases) {
      s = s.replace(new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), text);
    }
  }
  return s;
}

function buildEvents(value: Snapshot): ReplayEvent[] {
  const result: ReplayEvent[] = [];
  for (const [chatIndex, chat] of value.chats.entries()) {
    const workspaceId = chat.chat.workspaceId;
    result.push({
      kind: "workspace",
      chatIndex,
      workspaceId,
      chat,
      label: `Switch to ${workspaceId}`,
      detail: chat.chat.title ?? chat.chat.id,
    });
    for (const [messageIndex, message] of chat.messages.entries()) {
      for (const [partIndex, part] of message.parts.entries()) {
        result.push({
          kind: "part",
          chatIndex,
          messageIndex,
          partIndex,
          workspaceId,
          chat,
          message,
          label: eventLabel(part, message.role),
          detail: eventDetail(part),
        });
      }
    }
  }
  return result;
}

function buildNaturalDelays(evts: ReplayEvent[]): Record<number, number> {
  const result: Record<number, number> = {};
  for (let i = 0; i < evts.length - 1; i++) {
    const curr = evts[i];
    const next = evts[i + 1];
    // Same message: parts stream fast, no natural delay
    if (
      curr.kind === "part" &&
      next.kind === "part" &&
      curr.chatIndex === next.chatIndex &&
      curr.messageIndex === next.messageIndex
    )
      continue;
    const currTs =
      curr.kind === "part"
        ? timestampForMessage(curr.message, curr.chat)
        : timestampForChat(curr.chat);
    const nextTs =
      next.kind === "part"
        ? timestampForMessage(next.message, next.chat)
        : timestampForChat(next.chat);
    const diff = nextTs - currTs;
    if (diff > 50 && diff < 300_000) result[i] = diff; // 50ms–5min
  }
  return result;
}

function eventLabel(part: unknown, role: RawMessage["role"]): string {
  if (!isObject(part) || typeof part.type !== "string") return role;
  if (part.type === "text") return role === "user" ? "User message" : "Friday text";
  if (part.type === "step-start") return "Assistant step";
  if (part.type === "data-credential-linked") return "Credential linked";
  if (part.type === "data-nested-chunk" || part.type === "data-delegate-chunk")
    return nestedLabel(part);
  if (part.type === "dynamic-tool" && typeof part.toolName === "string") return part.toolName;
  if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return part.type;
}

function eventDetail(part: unknown): string {
  if (!isObject(part)) return "";
  if (typeof part.text === "string") return filterText(part.text);
  if (part.type === "data-nested-chunk" || part.type === "data-delegate-chunk")
    return nestedLabel(part);
  if ("output" in part) return filterText(summarize(part.output));
  if ("input" in part) return filterText(summarize(part.input));
  if ("data" in part) return filterText(summarize(part.data));
  return "";
}

function nestedLabel(part: Record<string, unknown>): string {
  const data = isObject(part.data) ? part.data : undefined;
  const chunk = data && isObject(data.chunk) ? data.chunk : undefined;
  const chunkType = typeof chunk?.type === "string" ? chunk.type : "nested event";
  const chunkData = chunk && isObject(chunk.data) ? chunk.data : undefined;
  if (chunkType === "data-fsm-state-transition")
    return `${stringValue(chunkData?.jobName, "job")}: ${stringValue(chunkData?.fromState, "?")} → ${stringValue(chunkData?.toState, "?")}`;
  if (chunkType === "data-fsm-action-execution")
    return `${stringValue(chunkData?.jobName, "job")}.${stringValue(chunkData?.actionId, "action")} ${stringValue(chunkData?.status, "")}`;
  if (chunkType === "data-session-start")
    return `Session started ${stringValue(chunkData?.sessionId, "")}`;
  if (chunkType === "data-session-finish")
    return `Session finished ${stringValue(chunkData?.status, "")}`;
  if (chunkType === "tool-input-available" || chunkType === "tool-output-available")
    return `${chunkType.replaceAll("-", " ")}: ${stringValue(chunk?.toolName, "tool")}`;
  return chunkType.replaceAll("-", " ");
}

function buildVisibleMessages(value: Snapshot, index: number): ChatMessage[] {
  const result: ChatMessage[] = [];
  let eventCursor = -1;
  for (const [chatIndex, chat] of value.chats.entries()) {
    eventCursor += 1;
    for (const message of chat.messages) {
      const visibleParts: unknown[] = [];
      for (const part of message.parts) {
        eventCursor += 1;
        if (eventCursor <= index) visibleParts.push(part);
      }
      if (visibleParts.length === 0) continue;
      result.push({
        id: `${chatIndex}-${message.id}`,
        role: message.role,
        segments: buildSegments({ id: message.id, parts: visibleParts }),
        timestamp: timestampForMessage(message, chat),
        metadata: metadataForMessage(message),
      });
    }
  }
  return result;
}

function buildSegments(msg: MessageWithParts): Segment[] {
  if (!Array.isArray(msg.parts)) return [];
  const toolMap = flattenToolCalls(extractToolCalls(msg as unknown as AtlasUIMessage));
  const segments: Segment[] = [];
  let textBuffer = "";
  let toolBuffer: ToolCallDisplay[] = [];
  let reasoningBuffer = "";
  let burstIndex = 0;

  function flushText() {
    if (textBuffer.length > 0) {
      segments.push({ type: "text", content: textBuffer });
      textBuffer = "";
    }
  }

  function flushBurst() {
    if (toolBuffer.length > 0) {
      segments.push({
        type: "tool-burst",
        id: `${msg.id}-burst-${burstIndex++}`,
        calls: [...toolBuffer],
        reasoning: reasoningBuffer || undefined,
      });
      toolBuffer = [];
      reasoningBuffer = "";
    }
  }

  for (const part of msg.parts) {
    if (!isObject(part) || typeof part.type !== "string") continue;
    const type = part.type;
    if (type === "text" && typeof part.text === "string") {
      flushBurst();
      textBuffer += filterText(part.text);
      continue;
    }
    if (type === "reasoning" || type === "reasoning-delta") {
      const delta = filterText(
        type === "reasoning" ? stringValue(part.text, "") : stringValue(part.delta, ""),
      );
      if (toolBuffer.length > 0) reasoningBuffer += delta;
      else textBuffer += delta;
      continue;
    }
    if (type === "data-credential-linked") {
      const data = isObject(part.data) ? part.data : undefined;
      const displayName = stringValue(data?.displayName, "");
      if (displayName) {
        flushBurst();
        textBuffer += `Connected ${displayName}.`;
      }
      continue;
    }
    if (type.startsWith("tool-") || type === "dynamic-tool") {
      const display = toolMap.get(stringValue(part.toolCallId, ""));
      if (display) {
        flushText();
        toolBuffer.push(filterToolCall(sanitizeStaticToolCall(display)));
      }
    }
  }
  flushText();
  flushBurst();
  return segments;
}

function sanitizeStaticToolCall(call: ToolCallDisplay): ToolCallDisplay {
  const toolName = ["connect_service", "connect_communicator", "display_artifact"].includes(
    call.toolName,
  )
    ? `${call.toolName}_snapshot`
    : call.toolName;
  return { ...call, toolName, children: call.children?.map(sanitizeStaticToolCall) };
}

function metadataForMessage(message: RawMessage): ChatMessage["metadata"] {
  const metadata = message.metadata;
  if (!metadata) return undefined;
  return {
    agentId: stringOrUndefined(metadata.agentId),
    jobName: stringOrUndefined(metadata.jobName),
    provider: stringOrUndefined(metadata.provider),
    modelId: stringOrUndefined(metadata.modelId),
    sessionId: stringOrUndefined(metadata.sessionId),
  };
}

function timestampForChat(chat: RawChat): number {
  return Date.parse(chat.chat.createdAt ?? chat.chat.updatedAt ?? "") || Date.now();
}
function timestampForMessage(message: RawMessage, chat: RawChat): number {
  const m = message as Record<string, unknown>;
  const candidates = [
    message.metadata?.timestamp,
    message.metadata?.createdAt,
    m.createdAt,
    m.updatedAt,
    m.timestamp,
  ];
  for (const raw of candidates) {
    if (typeof raw === "string" && raw) {
      const ts = Date.parse(raw);
      if (ts > 0) return ts;
    }
    if (typeof raw === "number" && raw > 0) return raw;
  }
  return timestampForChat(chat);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function summarize(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.length > 180 ? `${value.slice(0, 180)}…` : value;
  const text = JSON.stringify(value);
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}
function eventIcon(event: ReplayEvent): string {
  if (event.kind === "workspace") return "↪";
  const part = event.message.parts[event.partIndex];
  if (isObject(part) && typeof part.type === "string") {
    if (part.type === "text") return "●";
    if (part.type.startsWith("tool-") || part.type === "dynamic-tool") return "⚙";
    if (part.type.includes("nested")) return "◇";
  }
  return "•";
}

function clampIndex(value: number): number {
  return Math.max(0, Math.min(value, Math.max(0, events.length - 1)));
}
function setIndex(value: number) {
  currentIndex = clampIndex(value);
}
function resetDelays() {
  eventDelays = {};
}
function stop() {
  playing = false;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
}
function effectiveDelay(index: number): number {
  const base =
    eventDelays[index] ?? (useSourceTiming ? naturalEventDelays[index] : undefined) ?? speedMs;
  return Math.max(0, Math.round(base / speedFactor));
}
function scheduleNext() {
  timer = window.setTimeout(() => {
    if (!playing) return;
    if (currentIndex >= events.length - 1) {
      stop();
    } else {
      currentIndex = clampIndex(currentIndex + 1);
      scheduleNext();
    }
  }, effectiveDelay(currentIndex));
}
function play() {
  stop();
  playing = true;
  scheduleNext();
}
function togglePlay() {
  playing ? stop() : play();
}
function stepSpeed(faster: boolean) {
  const idx = SPEED_PRESETS.findIndex((p) => p >= speedFactor);
  const safeIdx = idx === -1 ? SPEED_PRESETS.length - 1 : idx;
  const next = faster ? SPEED_PRESETS[safeIdx + 1] : SPEED_PRESETS[safeIdx - 1];
  if (next !== undefined) {
    speedFactor = next;
    if (playing) play();
  }
}
function speedLabel(): string {
  if (speedFactor % 1 === 0) return `${speedFactor}×`;
  if (speedFactor < 1) return `${speedFactor.toFixed(2).replace(/0+$/, "")}×`;
  return `${speedFactor.toFixed(1)}×`;
}
function handleAspectPreview() {
  if (aspectPreviewTimer !== undefined) window.clearTimeout(aspectPreviewTimer);
  if (chatAspect !== "full") {
    aspectPreviewActive = true;
    aspectPreviewTimer = window.setTimeout(() => {
      aspectPreviewActive = false;
      aspectPreviewTimer = undefined;
    }, 3000);
  } else {
    aspectPreviewActive = false;
  }
}
function currentChatTitle(): string {
  const event = currentEvent;
  if (!event) return "Chat replay";
  const title = event.chat.chat.title ?? event.chat.chat.workspaceId;
  return event.kind === "workspace" ? `Switched to ${title}` : title;
}
function loadSnapshot(value: Snapshot) {
  stop();
  snapshot = value;
  currentIndex = 0;
  loadError = null;
}

function chatUrlsFromLocation(): string[] {
  const params = new URLSearchParams(window.location.search);
  const repeated = params
    .getAll("chat")
    .map((value) => value.trim())
    .filter(Boolean);
  const joined =
    params
      .get("chats")
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  return [...repeated, ...joined];
}

function chatUrlsFromText(raw: string): string[] {
  return raw
    .replaceAll("[", "")
    .replaceAll("]", "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function writeQueryParams(urls: string[]) {
  const next = new URL(window.location.href);
  next.search = "";
  for (const url of urls) next.searchParams.append("chat", url);
  window.history.replaceState(null, "", next);
}

function apiUrlForChat(platformUrl: string): string {
  const url = new URL(platformUrl);
  const match = url.pathname.match(/^\/platform\/([^/]+)\/chat\/([^/]+)$/);
  if (!match) throw new Error(`Invalid chat URL: ${platformUrl}`);
  const workspaceId = match[1];
  const chatId = match[2];
  if (!workspaceId || !chatId) throw new Error(`Invalid chat URL: ${platformUrl}`);
  return `${url.origin}/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(chatId)}`;
}

async function loadUrls(urls: string[]) {
  loading = true;
  loadError = null;
  try {
    if (urls.length === 0) throw new Error("Enter at least one chat URL.");
    const chats: RawChat[] = [];
    for (const chatUrl of urls) {
      const response = await fetch(apiUrlForChat(chatUrl));
      if (!response.ok) throw new Error(`Failed to load ${chatUrl}: HTTP ${response.status}`);
      const parsed = RawChatSchema.parse(await response.json());
      chats.push({ ...parsed, _sourceUrl: chatUrl });
    }
    loadSnapshot({ capturedAt: new Date().toISOString(), chats });
    loadedUrls = urls;
    eventDelays = loadSavedDelays(urls);
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    snapshot = { capturedAt: new Date().toISOString(), chats: [] };
    currentIndex = 0;
  } finally {
    loading = false;
  }
}

async function scrollChatToBottom() {
  await tick();
  await tick();
  const list = document.querySelector<HTMLElement>(".replay-chat-body .message-list");
  if (!list) return;
  list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
}

$effect(() => {
  currentIndex;
  void scrollChatToBottom();
});

function handleSubmit() {
  const urls = chatUrlsFromText(urlText);
  writeQueryParams(urls);
  void loadUrls(urls);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    (target as HTMLElement).isContentEditable
  );
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && overlayOpen) {
    overlayOpen = false;
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    overlayOpen = !overlayOpen;
    return;
  }
  if (isEditableTarget(event.target)) return;
  if (event.key === " ") {
    event.preventDefault();
    togglePlay();
  } else if (event.key === "j") {
    event.preventDefault();
    setIndex(currentIndex - 1);
  } else if (event.key === "k") {
    event.preventDefault();
    setIndex(currentIndex + 1);
  } else if (event.shiftKey && event.code === "Equal") {
    event.preventDefault();
    stepSpeed(true);
  } else if (event.shiftKey && event.code === "Minus") {
    event.preventDefault();
    stepSpeed(false);
  }
}

const SETTINGS_KEY = "chat-replay-settings";
const DELAYS_KEY = "chat-replay-delays";

function loadSavedDelays(urls: string[]): Record<number, number> {
  try {
    const raw = localStorage.getItem(DELAYS_KEY);
    if (!raw) return {};
    const store = JSON.parse(raw) as Record<string, Record<string, number>>;
    const key = String(stableHash([...urls].sort().join(",")));
    const saved = store[key];
    if (!saved) return {};
    return Object.fromEntries(Object.entries(saved).map(([k, v]) => [Number(k), v]));
  } catch {
    return {};
  }
}

$effect(() => {
  if (!mounted) return;
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        piiEnabled,
        piiCategories: {
          email: piiCategories.email,
          phone: piiCategories.phone,
          ip: piiCategories.ip,
          uuid: piiCategories.uuid,
        },
        piiCustomTermsText,
        chatAspect,
        speedMs,
        speedFactor,
        inspectorOpen,
        useSourceTiming,
      }),
    );
  } catch {
    /* ignore */
  }
});

$effect(() => {
  if (!mounted || loadedUrls.length === 0) return;
  const snapshot = JSON.stringify(eventDelays); // read all props for deep tracking
  try {
    const raw = localStorage.getItem(DELAYS_KEY);
    const store: Record<string, unknown> = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const key = String(stableHash([...loadedUrls].sort().join(",")));
    const parsed = JSON.parse(snapshot) as Record<number, number>;
    if (Object.keys(parsed).length === 0) {
      delete store[key];
    } else {
      store[key] = parsed;
    }
    const storeKeys = Object.keys(store);
    for (const k of storeKeys.slice(0, Math.max(0, storeKeys.length - 10))) delete store[k];
    localStorage.setItem(DELAYS_KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
});

$effect(() => {
  if (!overlayOpen || !inspectorOpen) return;
  currentIndex; // track navigation changes
  void tick().then(() => {
    document
      .querySelector<HTMLElement>(".timeline-row-wrap.active")
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
});

onMount(() => {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Record<string, unknown>;
      if (typeof s.piiEnabled === "boolean") piiEnabled = s.piiEnabled;
      if (s.piiCategories && typeof s.piiCategories === "object") {
        const c = s.piiCategories as Record<string, unknown>;
        if (typeof c.email === "boolean") piiCategories.email = c.email;
        if (typeof c.phone === "boolean") piiCategories.phone = c.phone;
        if (typeof c.ip === "boolean") piiCategories.ip = c.ip;
        if (typeof c.uuid === "boolean") piiCategories.uuid = c.uuid;
      }
      if (typeof s.piiCustomTermsText === "string") piiCustomTermsText = s.piiCustomTermsText;
      if (typeof s.chatAspect === "string") chatAspect = s.chatAspect;
      if (typeof s.speedMs === "number") speedMs = s.speedMs;
      if (typeof s.speedFactor === "number") speedFactor = s.speedFactor;
      if (typeof s.inspectorOpen === "boolean") inspectorOpen = s.inspectorOpen;
      if (typeof s.useSourceTiming === "boolean") useSourceTiming = s.useSourceTiming;
    }
  } catch {
    /* ignore */
  }

  const urls = chatUrlsFromLocation();
  urlText = urls.join("\n");
  if (urls.length > 0) void loadUrls(urls);
  mounted = true;
});
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="replay-shell" onmousemove={showToggle}>
  <button class="overlay-toggle" class:hidden={playing || (!toggleVisible && !overlayOpen)} type="button" onclick={() => (overlayOpen = true)}>
    Controls <span>⌘K</span>
  </button>

  {#if overlayOpen}
    <div class="overlay-backdrop" role="presentation" onclick={() => (overlayOpen = false)}></div>
    <div class="overlay-modal" role="dialog" aria-modal="true" aria-label="Replay controls">
      <header class="overlay-head">
        <div>
          <div class="replay-title">Friday Chat Replay</div>
          <div class="replay-subtitle">Controls/config. Press ⌘K / Ctrl+K to toggle, Esc to close.</div>
        </div>
        <button type="button" onclick={() => (overlayOpen = false)}>Close</button>
      </header>

      <form class="replay-loader" aria-label="Replay source" onsubmit={(event) => { event.preventDefault(); handleSubmit(); }}>
        <div class="replay-loader-desc">
          <div class="replay-title" style="font-size: var(--font-size-3)">Replay source</div>
          <div class="replay-muted">Enter 1+ chat URLs. Spaces, commas, and newlines all work.</div>
          {#if loading}<div class="replay-muted" style="margin-block-start: var(--size-1)">Loading chats…</div>{/if}
          {#if loadError}<div class="replay-muted" style="color: var(--red-3); margin-block-start: var(--size-1)">{loadError}</div>{/if}
        </div>
        <div class="replay-loader-input">
          <textarea bind:value={urlText} required placeholder="http://localhost:5200/platform/user/chat/chat_...&#10;http://localhost:5200/platform/glazed_ink/chat/chat_..."></textarea>
          <button type="submit" class="replay-btn" disabled={loading}>Load replay</button>
        </div>
      </form>

      <section class="replay-controls" aria-label="Replay controls">
        <div class="ctrl-transport">
          <button class="replay-btn ctrl-icon" type="button" onclick={() => setIndex(currentIndex - 1)} aria-label="Previous (J)"><IconSmall.ChevronLeft /></button>
          <button class="replay-btn ctrl-icon ctrl-play" type="button" onclick={togglePlay} aria-label={playing ? "Pause (Space)" : "Play (Space)"}>
            {#if playing}<Icons.Pause />{:else}<Icons.TriangleRight />{/if}
          </button>
          <button class="replay-btn ctrl-icon" type="button" onclick={() => setIndex(currentIndex + 1)} aria-label="Next (K)"><IconSmall.ChevronRight /></button>
        </div>
        <div class="ctrl-scrubber">
          <input type="range" min="0" max={Math.max(0, events.length - 1)} value={currentIndex} oninput={(e) => setIndex(e.currentTarget.valueAsNumber)} />
          <span class="ctrl-pos">{events.length === 0 ? 0 : currentIndex + 1} / {events.length}</span>
        </div>
        <div class="ctrl-speed">
          <div class="ctrl-labeled">
            <span class="ctrl-label">Speed</span>
            <div class="ctrl-speed-row">
              <button class="replay-btn" type="button" onclick={() => stepSpeed(false)} aria-label="Slower">−</button>
              <span class="ctrl-speed-val">{speedLabel()}</span>
              <button class="replay-btn" type="button" onclick={() => stepSpeed(true)} aria-label="Faster">+</button>
            </div>
          </div>
          <div class="ctrl-labeled">
            <span class="ctrl-label">Base delay</span>
            <div class="ctrl-base-row">
              <input type="number" class="ctrl-global-input" bind:value={speedMs} min="0" max="60000" step="50" aria-label="Base delay (ms)" title="Base delay — 1× plays at this speed" oninput={() => { if (playing) play(); }} />
              <span class="ctrl-base-unit">ms</span>
            </div>
          </div>
        </div>
        <div class="ctrl-view">
          <label class="ctrl-source-timing" title="Use actual message timestamps as delays">
            <input type="checkbox" bind:checked={useSourceTiming} />
            Source timing
          </label>
          <select bind:value={chatAspect} aria-label="Chat aspect ratio" onchange={handleAspectPreview}>
            {#each ASPECT_OPTIONS as opt}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
          <button class="replay-btn" type="button" onclick={() => (inspectorOpen = !inspectorOpen)}>{inspectorOpen ? "Hide" : "Show"} timeline</button>
        </div>
      </section>

      <section class="replay-pii" aria-label="PII filter">
        <div class="pii-head">
          <label class="pii-master">
            <input type="checkbox" bind:checked={piiEnabled} />
            PII filter
          </label>
          <div class="pii-categories" class:pii-off={!piiEnabled}>
            <label><input type="checkbox" bind:checked={piiCategories.email} disabled={!piiEnabled} /> Emails</label>
            <label><input type="checkbox" bind:checked={piiCategories.phone} disabled={!piiEnabled} /> Phones</label>
            <label><input type="checkbox" bind:checked={piiCategories.ip} disabled={!piiEnabled} /> IPs</label>
            <label><input type="checkbox" bind:checked={piiCategories.uuid} disabled={!piiEnabled} /> UUIDs</label>
          </div>
        </div>
        {#if piiEnabled}
          <div class="pii-body">
            <span class="pii-terms-heading">Names &amp; phrases</span>
            <textarea class="pii-terms" bind:value={piiCustomTermsText} placeholder="Kenneth Kouot, Ken&#10;Acme Corp"></textarea>
            <p class="pii-hint">One identity per line · commas = aliases · add <code>→ Name</code> to pin the replacement</p>
          </div>
        {/if}
      </section>

      {#if inspectorOpen}
        <section class="replay-inspector">
          <aside class="replay-panel">
            <div class="replay-panel-title">
              <div class="timeline-title-row">
                <span>Timeline</span>
                <div class="timeline-title-actions">
                  <button type="button" class="timeline-filter-btn" onclick={() => { setIndex(0); timelineFilter = null; document.querySelector(".timeline-row-wrap")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }} title="Go to first event">↑ First</button>
                  <button type="button" class="timeline-filter-btn" onclick={resetDelays} title="Reset all delay overrides">Reset</button>
                </div>
              </div>
              <div class="timeline-filters">
                {#each ([null, 500, 1000, 3000, 5000] as const) as f}
                  <button type="button" class="timeline-filter-btn" class:active={timelineFilter === f} onclick={() => timelineFilter = f}>
                    {f === null ? "All" : f >= 1000 ? `>${f / 1000}s` : `>${f}ms`}
                  </button>
                {/each}
              </div>
            </div>
            <div class="replay-scroll">
              {#each events as event, index}
                {#if timelineFilter === null || editingDelayIndex === index || effectiveDelay(index) > timelineFilter}
                <div class="timeline-row-wrap" class:active={index === currentIndex} class:seen={index <= currentIndex} class:future={index > currentIndex}>
                  <button type="button" class="timeline-row" onclick={() => setIndex(index)}>
                    <span class="timeline-icon">{eventIcon(event)}</span>
                    <span>
                      <span class="timeline-label">{event.label}</span>
                      <span class="timeline-meta">
                        {event.workspaceId} · {event.kind}
                        <span class="timeline-delay"
                          class:is-override={eventDelays[index] !== undefined}
                          class:is-source={useSourceTiming && eventDelays[index] === undefined && naturalEventDelays[index] !== undefined}
                        >{effectiveDelay(index)}ms</span>
                      </span>
                    </span>
                  </button>
                  <input
                    type="number"
                    class="delay-input"
                    class:has-value={eventDelays[index] !== undefined}
                    placeholder="ms"
                    value={eventDelays[index] ?? ""}
                    min="0"
                    step="100"
                    title="Delay override for this event (ms)"
                    onfocus={() => { editingDelayIndex = index; }}
                    onblur={() => { editingDelayIndex = null; }}
                    oninput={(e) => {
                      const v = e.currentTarget.valueAsNumber;
                      if (isNaN(v) || v <= 0) delete eventDelays[index];
                      else eventDelays[index] = v;
                    }}
                  />
                </div>
                {/if}
              {/each}
            </div>
          </aside>

          <aside class="replay-panel raw-event">
            <div class="replay-panel-title">Current raw event</div>
            <div class="replay-scroll"><pre>{filterText(JSON.stringify(currentEvent ?? {}, null, 2))}</pre></div>
          </aside>
        </section>
      {/if}
    </div>
  {/if}

  <main class="replay-main" class:aspect-constrained={chatAspect !== "full"} style={chatMainStyle}>
    <section class="replay-panel replay-chat-panel" class:aspect-constrained={chatAspect !== "full"} style={chatPanelStyle}>
      {#if overlayOpen}
        <div class="replay-chat-head">
          <div class="replay-chat-title">{currentChatTitle()}</div>
          <div class="replay-muted">{currentEvent?.chat.chat.id ?? ""}</div>
        </div>
      {/if}
      <div class="replay-chat-body">
        <ChatMessageList messages={visibleMessages} />
      </div>
      {#if aspectPreviewActive}
        <div class="aspect-preview-badge">{ASPECT_OPTIONS.find(o => o.value === chatAspect)?.label ?? chatAspect}</div>
      {/if}
    </section>
  </main>
</div>

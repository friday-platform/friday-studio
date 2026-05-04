/**
 * Single source of truth for all JetStream resource limits.
 *
 * Server-level limits land in `nats-server.conf`; per-stream limits are
 * passed at stream creation time. Library code (chat backend, memory
 * adapter) receives the per-stream limits via their init APIs so the
 * `process.env` read stays in the daemon's startup path.
 */

import process from "node:process";

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

const SECONDS_NS = 1_000_000_000n;
const MINUTE_NS = 60n * SECONDS_NS;
const HOUR_NS = 60n * MINUTE_NS;
const DAY_NS = 24n * HOUR_NS;

/**
 * Parse strings like "10GB", "256MB", "1024", "8mb" into bytes.
 * Bare numbers are treated as bytes. Returns `fallback` on parse failure.
 */
function parseBytes(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = (m[2] ?? "b").toLowerCase();
  const mult =
    unit === "tb"
      ? 1024 * GIB
      : unit === "gb"
        ? GIB
        : unit === "mb"
          ? MIB
          : unit === "kb"
            ? KIB
            : 1;
  return Math.floor(n * mult);
}

/**
 * Parse strings like "30d", "24h", "5m", "300s" into nanoseconds.
 * Bare numbers are treated as seconds. "0" or empty = 0n (no expiry).
 */
function parseDurationNs(value: string | undefined, fallbackNs: bigint): bigint {
  if (!value) return fallbackNs;
  const trimmed = value.trim();
  if (trimmed === "0") return 0n;
  const m = trimmed.match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!m?.[1]) return fallbackNs;
  const n = BigInt(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult =
    unit === "d" ? DAY_NS : unit === "h" ? HOUR_NS : unit === "m" ? MINUTE_NS : SECONDS_NS;
  return n * mult;
}

function parseInt32(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface JetStreamServerLimits {
  /** `max_payload` in NATS server.conf. Caps raw publish size before any stream limit applies. */
  maxPayload: number;
  /** `jetstream.max_memory_store` — total across all memory-backed streams on this broker. */
  maxMemoryStore: number;
  /** `jetstream.max_file_store` — total across all file-backed streams on this broker. */
  maxFileStore: number;
  /** `limits.max_streams` — broker-wide stream count ceiling. */
  maxStreams: number;
  /** `limits.max_consumers` — broker-wide consumer count ceiling. */
  maxConsumers: number;
  /** Optional override for JetStream's on-disk store directory. */
  storeDir: string | undefined;
  /** Whether to expose the HTTP monitoring endpoint. */
  monitor: boolean;
}

export interface JetStreamStreamLimits {
  /** Default `max_msg_size` applied at stream creation when not overridden. */
  maxMsgSize: number;
  /** Default `max_age` (ns) applied at stream creation when not overridden. 0n = no expiry. */
  maxAgeNs: bigint;
  /** Default `duplicate_window` (ns) for broker-side dedup. */
  duplicateWindowNs: bigint;
}

export interface JetStreamConsumerLimits {
  /**
   * Default `max_ack_pending` for pull consumers. Primary flow-control knob:
   * suspends delivery to the consumer when this many messages are unacked.
   */
  maxAckPending: number;
  /** Default `max_deliver` before a message is dead-lettered. */
  maxDeliver: number;
  /** Default `ack_wait` (ns) before redelivery if the consumer hasn't acked. */
  ackWaitNs: bigint;
}

/**
 * One field of resolved config + provenance: the value, the env-var name
 * that *would* set it, and whether the current value came from the env
 * (`"env"`) or fell back to the built-in default (`"default"`).
 */
export interface ResolvedField<T> {
  value: T;
  envVar: string;
  source: "env" | "default";
}

export interface ResolvedJetStreamConfig {
  server: {
    maxPayload: ResolvedField<number>;
    maxMemoryStore: ResolvedField<number>;
    maxFileStore: ResolvedField<number>;
    storeDir: ResolvedField<string | undefined>;
    monitor: ResolvedField<boolean>;
    /** Provided by env but no longer written to server.conf — see plan. */
    maxStreams: ResolvedField<number>;
    maxConsumers: ResolvedField<number>;
  };
  stream: {
    maxMsgSize: ResolvedField<number>;
    maxAgeNs: ResolvedField<bigint>;
    duplicateWindowNs: ResolvedField<bigint>;
  };
  consumer: {
    maxAckPending: ResolvedField<number>;
    maxDeliver: ResolvedField<number>;
    ackWaitNs: ResolvedField<bigint>;
  };
}

function resolveBytes(envVar: string, fallback: number): ResolvedField<number> {
  const raw = process.env[envVar];
  return { value: parseBytes(raw, fallback), envVar, source: raw ? "env" : "default" };
}

function resolveDurationNs(envVar: string, fallbackNs: bigint): ResolvedField<bigint> {
  const raw = process.env[envVar];
  return { value: parseDurationNs(raw, fallbackNs), envVar, source: raw ? "env" : "default" };
}

function resolveInt32(envVar: string, fallback: number): ResolvedField<number> {
  const raw = process.env[envVar];
  return { value: parseInt32(raw, fallback), envVar, source: raw ? "env" : "default" };
}

function resolveString(envVar: string): ResolvedField<string | undefined> {
  const raw = process.env[envVar];
  return { value: raw, envVar, source: raw ? "env" : "default" };
}

function resolveBoolFlag(envVar: string, truthy: string): ResolvedField<boolean> {
  const raw = process.env[envVar];
  return { value: raw === truthy, envVar, source: raw ? "env" : "default" };
}

/**
 * Read all JetStream-related env vars into a resolved config object that
 * carries provenance for each field. Daemon startup logs the full
 * resolved view via `formatStartupLog()` so operators can see at a glance
 * what's set and from where.
 */
export function readJetStreamConfig(): ResolvedJetStreamConfig {
  return {
    server: {
      maxPayload: resolveBytes("FRIDAY_JETSTREAM_MAX_PAYLOAD", 8 * MIB),
      maxMemoryStore: resolveBytes("FRIDAY_JETSTREAM_MAX_MEMORY", 256 * MIB),
      maxFileStore: resolveBytes("FRIDAY_JETSTREAM_MAX_FILE", 10 * GIB),
      // Tracked for telemetry but NOT written to server.conf — `limits {}`
      // is not a portable nats-server top-level block, and stream/consumer
      // count caps belong on accounts. Operators who need them today
      // should configure an `accounts {}` block by hand.
      maxStreams: resolveInt32("FRIDAY_JETSTREAM_MAX_STREAMS", 10_000),
      maxConsumers: resolveInt32("FRIDAY_JETSTREAM_MAX_CONSUMERS", 100_000),
      storeDir: resolveString("FRIDAY_JETSTREAM_STORE_DIR"),
      monitor: resolveBoolFlag("FRIDAY_NATS_MONITOR", "1"),
    },
    stream: {
      maxMsgSize: resolveBytes("FRIDAY_JETSTREAM_MAX_MSG_SIZE", 8 * MIB),
      maxAgeNs: resolveDurationNs("FRIDAY_JETSTREAM_MAX_AGE", 0n),
      duplicateWindowNs: resolveDurationNs("FRIDAY_JETSTREAM_DUPLICATE_WINDOW", 24n * HOUR_NS),
    },
    consumer: {
      maxAckPending: resolveInt32("FRIDAY_JETSTREAM_MAX_ACK_PENDING", 256),
      maxDeliver: resolveInt32("FRIDAY_JETSTREAM_MAX_DELIVER", 5),
      ackWaitNs: resolveDurationNs("FRIDAY_JETSTREAM_ACK_WAIT", 5n * MINUTE_NS),
    },
  };
}

// ── Pretty formatting for the startup log ────────────────────────────────

function fmtBytes(n: number): string {
  if (n >= GIB) return `${(n / GIB).toFixed(n % GIB === 0 ? 0 : 2)}GB`;
  if (n >= MIB) return `${(n / MIB).toFixed(n % MIB === 0 ? 0 : 2)}MB`;
  if (n >= KIB) return `${(n / KIB).toFixed(n % KIB === 0 ? 0 : 2)}KB`;
  return `${n}B`;
}

function fmtDurationNs(ns: bigint): string {
  if (ns === 0n) return "0 (no expiry)";
  if (ns % DAY_NS === 0n) return `${ns / DAY_NS}d`;
  if (ns % HOUR_NS === 0n) return `${ns / HOUR_NS}h`;
  if (ns % MINUTE_NS === 0n) return `${ns / MINUTE_NS}m`;
  if (ns % SECONDS_NS === 0n) return `${ns / SECONDS_NS}s`;
  return `${ns}ns`;
}

function tag(field: ResolvedField<unknown>): string {
  return field.source === "env" ? `[${field.envVar}]` : "[default]";
}

/**
 * Render a multi-line summary of every JetStream knob. Each line shows
 * the resolved value followed by its source — either the env var that
 * set it or `[default]`.
 */
export function formatStartupLog(cfg: ResolvedJetStreamConfig): string {
  const s = cfg.server;
  const st = cfg.stream;
  const c = cfg.consumer;
  return [
    "JetStream configuration (env or [default]):",
    "  Server:",
    `    max_payload          = ${fmtBytes(s.maxPayload.value)}  ${tag(s.maxPayload)}`,
    `    max_memory_store     = ${fmtBytes(s.maxMemoryStore.value)}  ${tag(s.maxMemoryStore)}`,
    `    max_file_store       = ${fmtBytes(s.maxFileStore.value)}  ${tag(s.maxFileStore)}`,
    `    store_dir            = ${s.storeDir.value ?? "(daemon home / jetstream)"}  ${tag(s.storeDir)}`,
    `    monitor (HTTP :8222) = ${s.monitor.value}  ${tag(s.monitor)}`,
    `    max_streams (info)   = ${s.maxStreams.value}  ${tag(s.maxStreams)}  — not enforced; configure via accounts{} if needed`,
    `    max_consumers (info) = ${s.maxConsumers.value}  ${tag(s.maxConsumers)}  — not enforced; configure via accounts{} if needed`,
    "  Per-stream defaults:",
    `    max_msg_size         = ${fmtBytes(st.maxMsgSize.value)}  ${tag(st.maxMsgSize)}`,
    `    max_age              = ${fmtDurationNs(st.maxAgeNs.value)}  ${tag(st.maxAgeNs)}`,
    `    duplicate_window     = ${fmtDurationNs(st.duplicateWindowNs.value)}  ${tag(st.duplicateWindowNs)}`,
    "  Per-consumer defaults (SignalConsumer):",
    `    max_ack_pending      = ${c.maxAckPending.value}  ${tag(c.maxAckPending)}`,
    `    max_deliver          = ${c.maxDeliver.value}  ${tag(c.maxDeliver)}`,
    `    ack_wait             = ${fmtDurationNs(c.ackWaitNs.value)}  ${tag(c.ackWaitNs)}`,
  ].join("\n");
}

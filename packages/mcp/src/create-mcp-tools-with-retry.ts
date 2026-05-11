/**
 * Foreground wrapper around `createMCPTools` that turns a transient
 * "credential temporarily unavailable" disconnect into a user-facing
 * Retry/Cancel elicitation, then re-attempts only the affected servers.
 *
 * v8 design — `docs/plans/2026-05-11-oauth-refresh-resilience-design.v8.md`
 * decisions 13, 14, 15, 16, 18, 20, 23, 24.
 *
 * Trust contract for callers:
 * - No `credential_temporarily_unavailable` entry ever survives in the
 *   returned `disconnected[]` — it is either cleared by a successful
 *   Retry or causes an aggregate throw.
 * - Other disconnect kinds (`credential_not_found`, `credential_expired`,
 *   `credential_refresh_failed`, `no_default_credential`) pass through
 *   untouched and continue to ride the existing chip path.
 * - Without `interactiveCtx`, transients always throw
 *   `LinkCredentialUnavailableError({entries})`; the caller (workspace
 *   runtime / fsm-engine) routes that to FAILED.
 *
 * The polling primitive is local (no NATS plumbing) per v8 decision 23.
 *
 * @module
 */

import process from "node:process";
import type { MCPServerConfig } from "@atlas/config";
import type { Elicitation, ElicitationOption } from "@atlas/core/elicitations";
import { ElicitationStorage } from "@atlas/core/elicitations";
import { LinkCredentialUnavailableError } from "@atlas/core/mcp-registry/credential-resolver";
import type { Logger } from "@atlas/logger";
import { getOAuthMetrics, type OAuthMetricsSink } from "@atlas/logger/oauth-metrics";
import {
  type CreateMCPToolsOptions,
  createMCPTools,
  type DisconnectedIntegration,
  type MCPToolsResult,
} from "./create-mcp-tools.ts";

/** TTL cap per v8 decision 14: `min(jobTimeoutMs ?? Infinity, 120_000)`. */
const ELICITATION_TTL_CAP_MS = 2 * 60 * 1000;

/** Polling interval for the elicitation status read loop (v8 decision 23). */
const POLL_INTERVAL_MS = 250;

/** Fixed option set per v8 decision 13 — single elicitation, Retry / Cancel. */
const RETRY_CANCEL_OPTIONS: ElicitationOption[] = [
  { label: "Retry", value: "retry" },
  { label: "Cancel", value: "cancel" },
];

/**
 * Caller-supplied identity needed to surface an interactive elicitation. When
 * absent, the wrapper degrades to throw-on-transient (cron / non-chat paths).
 */
export type InteractiveContext = {
  workspaceId: string;
  sessionId: string;
  actionId?: string;
  jobTimeoutMs?: number;
  sessionAbortSignal?: AbortSignal;
};

/**
 * Drop-in replacement for `createMCPTools` for foreground sites (fsm-engine,
 * agent-context). Behavior:
 *
 *  - Delegates to `createMCPTools`.
 *  - If no transient entries: returns the result unchanged.
 *  - Transients + no `interactiveCtx`: disposes the partial result then throws
 *    aggregate `LinkCredentialUnavailableError`.
 *  - Transients + `interactiveCtx`: groups entries by provider family, emits
 *    one `auth-refresh` elicitation per family (deduped against existing
 *    pending rows), awaits all answers, then either re-runs `createMCPTools`
 *    for the retried families and merges, or throws aggregate covering all
 *    failed families. Loops until every family resolves to a terminal state.
 */
export async function createMCPToolsWithRetry(
  configs: Record<string, MCPServerConfig>,
  logger: Logger,
  opts: CreateMCPToolsOptions = {},
  interactiveCtx?: InteractiveContext,
): Promise<MCPToolsResult> {
  if (interactiveCtx?.sessionAbortSignal?.aborted) {
    throw abortError(interactiveCtx.sessionAbortSignal.reason);
  }

  let acc = await createMCPTools(configs, logger, opts);

  while (true) {
    const transients = acc.disconnected.filter(
      (entry) => entry.kind === "credential_temporarily_unavailable",
    );
    if (transients.length === 0) {
      return acc;
    }

    if (!interactiveCtx) {
      await safeDispose(acc, logger);
      throw new LinkCredentialUnavailableError({ entries: transients.map(toUnavailableEntry) });
    }

    const families = groupByFamily(transients);
    const familyOutcomes = await resolveFamilies({ families, logger, interactiveCtx });

    const failedFamilies = familyOutcomes.filter((o) => o.outcome === "failed");
    if (failedFamilies.length > 0) {
      const aggregate = failedFamilies.flatMap((f) => f.entries.map(toUnavailableEntry));
      await safeDispose(acc, logger);
      throw new LinkCredentialUnavailableError({ entries: aggregate });
    }

    const retryServerIds = familyOutcomes
      .filter((o) => o.outcome === "retry")
      .flatMap((o) => o.entries.map((e) => e.serverId));

    const retryConfigs: Record<string, MCPServerConfig> = {};
    for (const serverId of retryServerIds) {
      const cfg = configs[serverId];
      if (cfg) retryConfigs[serverId] = cfg;
    }

    if (Object.keys(retryConfigs).length === 0) {
      // All retry families had their entries already accounted for elsewhere —
      // nothing to re-attempt. Return what we have.
      return acc;
    }

    logger.info("createMCPToolsWithRetry retrying servers after user Retry", {
      operation: "mcp_retry",
      workspaceId: interactiveCtx.workspaceId,
      sessionId: interactiveCtx.sessionId,
      serverIds: retryServerIds,
    });

    const next = await createMCPTools(retryConfigs, logger, opts);

    // Classify each retried family. A family is `retry_succeeded` iff none of
    // its serverIds reappears as a transient in `next.disconnected`. Otherwise
    // it's `retry_failed`. Other disconnect kinds (e.g. `credential_not_found`
    // surfacing on the retry pass) aren't part of this distinction — the v8
    // counters track recovery from the transient state specifically.
    const nextTransientServerIds = new Set(
      next.disconnected
        .filter((entry) => entry.kind === "credential_temporarily_unavailable")
        .map((entry) => entry.serverId),
    );
    const metrics = getOAuthMetrics();
    for (const fo of familyOutcomes) {
      if (fo.outcome !== "retry") continue;
      const labels = {
        family: fo.family,
        workspaceId: interactiveCtx.workspaceId,
        sessionId: interactiveCtx.sessionId,
      };
      const stillTransient = fo.entries.some((e) => nextTransientServerIds.has(e.serverId));
      if (stillTransient) {
        metrics.recordElicitationRetryFailed(labels);
      } else {
        metrics.recordElicitationRetrySucceeded(labels);
      }
    }

    acc = mergeResults(acc, next, new Set(retryServerIds));
    // Loop again — fresh transients in `next` (if any) re-enter the retry path.
  }
}

/** Group transient entries by provider family. Default: `provider ?? serverId`. */
function groupByFamily(entries: DisconnectedIntegration[]): Map<string, DisconnectedIntegration[]> {
  const byFamily = new Map<string, DisconnectedIntegration[]>();
  for (const entry of entries) {
    const family = familyOf(entry);
    const bucket = byFamily.get(family) ?? [];
    bucket.push(entry);
    byFamily.set(family, bucket);
  }
  return byFamily;
}

/**
 * Provider-family classifier. v8 line 550 marks non-Google family
 * classification as out of scope; until that opens up, only the
 * `google-*` cluster is coalesced into a shared elicitation. Everything
 * else uses the provider id (or serverId fallback) as its own family.
 *
 * TODO: consult provider registry when family classification opens up
 * beyond Google.
 */
function familyOf(entry: DisconnectedIntegration): string {
  if (entry.provider?.startsWith("google-")) return "google";
  return entry.provider ?? entry.serverId;
}

/** Human-facing family name for the elicitation prompt. */
function displayNameForFamily(family: string): string {
  if (family.length === 0) return family;
  return family.charAt(0).toUpperCase() + family.slice(1);
}

/**
 * Deterministic prompt string for an `auth-refresh` elicitation. MUST be
 * a pure function of `family` — dedup matches by exact string equality
 * against an existing pending row's `question` field. Any per-call
 * variability (timestamps, randomness) would defeat dedup.
 */
export function questionForFamily(family: string): string {
  return `Friday couldn't reach ${displayNameForFamily(family)}. Retry?`;
}

type FamilyOutcome =
  | { family: string; outcome: "retry"; entries: DisconnectedIntegration[] }
  | { family: string; outcome: "failed"; entries: DisconnectedIntegration[] };

function resolveFamilies(input: {
  families: Map<string, DisconnectedIntegration[]>;
  logger: Logger;
  interactiveCtx: InteractiveContext;
}): Promise<FamilyOutcome[]> {
  const { families, logger, interactiveCtx } = input;
  const expiresAt = expiresAtFromJobTimeout(interactiveCtx.jobTimeoutMs);
  const metrics = getOAuthMetrics();

  return Promise.all(
    Array.from(families.entries()).map(async ([family, entries]) => {
      const { elicitation } = await findOrCreateElicitation({
        family,
        expiresAt,
        interactiveCtx,
        logger,
      });

      const createdAtMs = Date.parse(elicitation.createdAt);
      const labels = {
        family,
        workspaceId: interactiveCtx.workspaceId,
        sessionId: interactiveCtx.sessionId,
      };

      let terminal: TerminalAnswer;
      try {
        terminal = await waitForElicitationTerminal({
          id: elicitation.id,
          expiresAt: elicitation.expiresAt,
          signal: interactiveCtx.sessionAbortSignal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          metrics.recordElicitationAborted(labels);
          recordAnswerLatency(metrics, createdAtMs, { ...labels, status: "aborted" });
        }
        throw err;
      }

      logger.info("createMCPToolsWithRetry elicitation answered", {
        operation: "mcp_retry",
        workspaceId: interactiveCtx.workspaceId,
        sessionId: interactiveCtx.sessionId,
        family,
        elicitationId: elicitation.id,
        status: terminal.status,
        ...(terminal.status === "answered" ? { value: terminal.value } : {}),
      });

      if (terminal.status === "answered" && terminal.value === "retry") {
        metrics.recordElicitationAnsweredRetry(labels);
        recordAnswerLatency(metrics, createdAtMs, { ...labels, status: "answered_retry" });
        return { family, outcome: "retry", entries };
      }
      if (terminal.status === "answered" && terminal.value === "cancel") {
        metrics.recordElicitationAnsweredCancel(labels);
        recordAnswerLatency(metrics, createdAtMs, { ...labels, status: "answered_cancel" });
      } else if (terminal.status === "expired") {
        metrics.recordElicitationExpired(labels);
        recordAnswerLatency(metrics, createdAtMs, { ...labels, status: "expired" });
      }
      // `declined` is a back-door state from the storage layer; treat as
      // "failed" without a dedicated counter (not in the v8 list).
      return { family, outcome: "failed", entries };
    }),
  );
}

function recordAnswerLatency(
  metrics: OAuthMetricsSink,
  createdAtMs: number,
  attrs: {
    family: string;
    workspaceId: string;
    sessionId: string;
    status: "answered_retry" | "answered_cancel" | "expired" | "aborted";
  },
): void {
  if (!Number.isFinite(createdAtMs)) return;
  const elapsed = Date.now() - createdAtMs;
  if (elapsed < 0) return;
  metrics.recordAnswerLatencyMs(elapsed, attrs);
}

interface FindOrCreateResult {
  elicitation: Elicitation;
  /** True when we joined an existing pending row instead of creating a fresh one. */
  deduped: boolean;
}

async function findOrCreateElicitation(input: {
  family: string;
  expiresAt: string;
  interactiveCtx: InteractiveContext;
  logger: Logger;
}): Promise<FindOrCreateResult> {
  const { family, expiresAt, interactiveCtx, logger } = input;
  const question = questionForFamily(family);
  const metrics = getOAuthMetrics();

  const listed = await ElicitationStorage.list({
    workspaceId: interactiveCtx.workspaceId,
    sessionId: interactiveCtx.sessionId,
    status: "pending",
  });
  if (listed.ok) {
    const reusable = listed.data
      .filter((e) => e.kind === "auth-refresh" && e.question === question)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (reusable) {
      logger.info("createMCPToolsWithRetry reusing pending auth-refresh elicitation", {
        operation: "mcp_retry",
        workspaceId: interactiveCtx.workspaceId,
        sessionId: interactiveCtx.sessionId,
        family,
        elicitationId: reusable.id,
      });
      metrics.recordElicitationDeduped({
        family,
        workspaceId: interactiveCtx.workspaceId,
        sessionId: interactiveCtx.sessionId,
      });
      return { elicitation: reusable, deduped: true };
    }
  } else {
    logger.warn("createMCPToolsWithRetry: pending elicitation list failed; proceeding to create", {
      operation: "mcp_retry",
      workspaceId: interactiveCtx.workspaceId,
      sessionId: interactiveCtx.sessionId,
      family,
      error: listed.error,
    });
  }

  const created = await ElicitationStorage.create({
    workspaceId: interactiveCtx.workspaceId,
    sessionId: interactiveCtx.sessionId,
    ...(interactiveCtx.actionId ? { actionId: interactiveCtx.actionId } : {}),
    kind: "auth-refresh",
    question,
    options: RETRY_CANCEL_OPTIONS,
    expiresAt,
  });
  if (!created.ok) {
    throw new Error(`Failed to create auth-refresh elicitation: ${created.error}`);
  }

  logger.info("createMCPToolsWithRetry auth-refresh elicitation created", {
    operation: "mcp_retry",
    workspaceId: interactiveCtx.workspaceId,
    sessionId: interactiveCtx.sessionId,
    family,
    elicitationId: created.data.id,
  });
  metrics.recordElicitationCreated({
    family,
    workspaceId: interactiveCtx.workspaceId,
    sessionId: interactiveCtx.sessionId,
  });
  return { elicitation: created.data, deduped: false };
}

type TerminalAnswer = { status: "answered"; value: string } | { status: "declined" | "expired" };

async function waitForElicitationTerminal(input: {
  id: string;
  expiresAt: string;
  signal?: AbortSignal;
}): Promise<TerminalAnswer> {
  const { id, expiresAt, signal } = input;
  if (signal?.aborted) throw abortError(signal.reason);
  const deadlineMs = new Date(expiresAt).getTime();

  while (Date.now() < deadlineMs) {
    if (signal?.aborted) throw abortError(signal.reason);
    const got = await ElicitationStorage.get({ id });
    if (!got.ok) throw new Error(`Failed to read elicitation ${id}: ${got.error}`);
    const terminal = terminalAnswerFrom(got.data);
    if (terminal) return terminal;
    await sleepWithAbort(POLL_INTERVAL_MS, signal);
  }

  await ElicitationStorage.expirePending({ now: new Date(expiresAt), limit: 500 });
  return { status: "expired" };
}

function terminalAnswerFrom(e: Elicitation | null): TerminalAnswer | undefined {
  if (!e) return undefined;
  if (e.status === "answered" && e.answer) {
    return { status: "answered", value: e.answer.value };
  }
  if (e.status === "declined") return { status: "declined" };
  if (e.status === "expired") return { status: "expired" };
  return undefined;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const err = new Error(
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Aborted",
  );
  err.name = "AbortError";
  return err;
}

/**
 * Read `FRIDAY_ELICITATION_TTL_MS_OVERRIDE` as a positive integer. Returns
 * undefined when missing, blank, non-numeric, or ≤ 0. Dev/QA only — emits a
 * one-shot stderr warning the first time it observes the override so an
 * operator who accidentally left it set notices.
 */
let warnedAboutTtlOverride = false;
export function readElicitationTtlOverrideMs(): number | undefined {
  const raw = process.env.FRIDAY_ELICITATION_TTL_MS_OVERRIDE;
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  if (!warnedAboutTtlOverride) {
    warnedAboutTtlOverride = true;
    console.warn(
      `[mcp-retry] FRIDAY_ELICITATION_TTL_MS_OVERRIDE=${raw} is active — auth-refresh elicitation TTLs are capped at this value (dev/QA only).`,
    );
  }
  return parsed;
}

export function expiresAtFromJobTimeout(jobTimeoutMs?: number, now: Date = new Date()): string {
  const baseTtlMs = Math.min(jobTimeoutMs ?? Number.POSITIVE_INFINITY, ELICITATION_TTL_CAP_MS);
  const override = readElicitationTtlOverrideMs();
  const ttlMs = override !== undefined ? Math.min(baseTtlMs, override) : baseTtlMs;
  return new Date(now.getTime() + ttlMs).toISOString();
}

/** Pull the structured entry data out of a wire `DisconnectedIntegration`. */
function toUnavailableEntry(entry: DisconnectedIntegration): {
  credentialId: string;
  serverName?: string;
  provider?: string;
} {
  // The disconnected entry's `message` was built from the upstream error
  // which had `credentialId` baked in, but the wire shape doesn't carry
  // `credentialId` directly. Use `serverId` as a stable identifier so the
  // re-thrown aggregate error still names the right integration to the
  // user; provider survives untouched.
  return {
    credentialId: entry.serverId,
    serverName: entry.serverId,
    ...(entry.provider ? { provider: entry.provider } : {}),
  };
}

/**
 * Compose two `MCPToolsResult`s after a retry pass. `retriedServerIds`
 * is the set of serverIds that were re-attempted; entries from `prior`
 * matching those serverIds are dropped so a successfully-retried server
 * doesn't leave a stale chip-emitting disconnect record.
 */
function mergeResults(
  prior: MCPToolsResult,
  next: MCPToolsResult,
  retriedServerIds: Set<string>,
): MCPToolsResult {
  const tools = { ...prior.tools, ...next.tools };
  const toolsByServer = { ...prior.toolsByServer, ...next.toolsByServer };
  const disconnected = [
    ...prior.disconnected.filter((d) => !retriedServerIds.has(d.serverId)),
    ...next.disconnected,
  ];

  let disposed = false;
  return {
    tools,
    toolsByServer,
    disconnected,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      // Dispose both halves regardless of order; both are individually
      // idempotent so dispose-twice across the merge boundary is safe.
      await Promise.allSettled([prior.dispose(), next.dispose()]);
    },
  };
}

async function safeDispose(result: MCPToolsResult, logger: Logger): Promise<void> {
  try {
    await result.dispose();
  } catch (err) {
    logger.warn("createMCPToolsWithRetry: dispose during throw path failed", {
      operation: "mcp_retry",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

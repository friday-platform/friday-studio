/**
 * Credential tampering + metrics readback for OAuth resilience scenarios.
 *
 * The QA plan needs three primitives that aren't covered by the daemon or
 * mock helpers:
 *
 *   1. Tamper a stored credential's secret in-place — e.g. set `expires_at`
 *      30s in the past to force a refresh on the next use.
 *   2. Read back a credential after a scenario to assert it was NOT
 *      modified by the refresh code path (P1-02 regression seal).
 *   3. Read Prometheus-style metrics from Link and assert specific counters
 *      moved between two snapshots.
 *
 * All operations talk to Link's HTTP API. Link runs on a configurable port
 * (default 3100). In LINK_DEV_MODE the user id defaults to "dev" and JWT
 * verification is skipped, so the harness sends no auth header.
 */

import type { DaemonHandle } from "../live-daemon/harness.ts";

export interface HarnessConfig {
  /**
   * Base URL for Link's HTTP API. Defaults to `LINK_SERVICE_URL` env, then
   * `http://localhost:3100`. Override per call for ad-hoc daemons.
   */
  linkBaseUrl?: string;
  /** Optional daemon handle — kept for symmetry with future debug endpoints. */
  daemon?: DaemonHandle;
}

/**
 * Read an env var without taking a hard dependency on the Deno or Node
 * runtime — the harness is imported by both vitest (Node) and the Deno
 * runner. Returns undefined when nothing's set or when neither runtime is
 * present.
 *
 * We bounce through `Reflect.get` so neither runtime's namespace types
 * need to be in scope here.
 */
function readEnv(name: string): string | undefined {
  const denoEnv = readDenoEnvVia("Deno", name);
  if (denoEnv !== undefined) return denoEnv;
  return readNodeEnvVia("process", name);
}

function readDenoEnvVia(globalName: string, varName: string): string | undefined {
  const deno = Reflect.get(globalThis, globalName);
  if (!isPlainRecord(deno)) return undefined;
  const env = deno.env;
  if (!isPlainRecord(env)) return undefined;
  const get = env.get;
  if (typeof get !== "function") return undefined;
  const value: unknown = get.call(env, varName);
  return typeof value === "string" ? value : undefined;
}

function readNodeEnvVia(globalName: string, varName: string): string | undefined {
  const proc = Reflect.get(globalThis, globalName);
  if (!isPlainRecord(proc)) return undefined;
  const env = proc.env;
  if (!isPlainRecord(env)) return undefined;
  const value = env[varName];
  return typeof value === "string" ? value : undefined;
}

function linkBaseUrl(config: HarnessConfig): string {
  if (config.linkBaseUrl) return config.linkBaseUrl;
  return readEnv("LINK_SERVICE_URL") ?? "http://localhost:3100";
}

export interface CredentialSummary {
  id: string;
  type: "apikey" | "oauth";
  provider: string;
  userIdentifier: string;
  displayName?: string;
  default?: boolean;
}

export interface CredentialWithSecret extends CredentialSummary {
  secret: Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCredentialSummary(value: unknown): CredentialSummary {
  if (!isPlainRecord(value)) throw new Error("credential body is not an object");
  const id = value.id;
  const type = value.type;
  const provider = value.provider;
  const userIdentifier = value.userIdentifier;
  if (typeof id !== "string") throw new Error("credential.id missing");
  if (type !== "apikey" && type !== "oauth") throw new Error("credential.type invalid");
  if (typeof provider !== "string") throw new Error("credential.provider missing");
  if (typeof userIdentifier !== "string") throw new Error("credential.userIdentifier missing");
  const displayName = value.displayName;
  const isDefault = value.default;
  return {
    id,
    type,
    provider,
    userIdentifier,
    ...(typeof displayName === "string" ? { displayName } : {}),
    ...(typeof isDefault === "boolean" ? { default: isDefault } : {}),
  };
}

function parseCredentialWithSecret(value: unknown): CredentialWithSecret {
  const summary = parseCredentialSummary(value);
  if (!isPlainRecord(value)) throw new Error("credential body is not an object");
  const secret = value.secret;
  if (!isPlainRecord(secret)) throw new Error("credential.secret missing");
  return { ...summary, secret };
}

/**
 * Find the default credential id for a provider via Link's public list
 * route. Used as a discovery step before reading or tampering.
 */
async function findDefaultCredentialId(config: HarnessConfig, provider: string): Promise<string> {
  const url = `${linkBaseUrl(config)}/v1/credentials/type/oauth`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /v1/credentials/type/oauth failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  if (!Array.isArray(body)) {
    throw new Error("credentials list response was not an array");
  }
  for (const raw of body) {
    const summary = parseCredentialSummary(raw);
    if (summary.provider === provider) {
      return summary.id;
    }
  }
  throw new Error(`no credential found for provider ${provider}`);
}

/**
 * Read the current stored credential (including the encrypted secret as
 * returned by Link's internal route, post-decrypt). Used both to snapshot
 * "before" state for tamper-then-restore patterns and to assert "after"
 * state in regression scenarios.
 */
export async function readCredential(
  provider: string,
  config: HarnessConfig = {},
): Promise<CredentialWithSecret> {
  const id = await findDefaultCredentialId(config, provider);
  const url = `${linkBaseUrl(config)}/internal/v1/credentials/${encodeURIComponent(id)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET internal credential ${id} failed: ${res.status} ${text}`);
  }
  return parseCredentialWithSecret(await res.json());
}

/**
 * Patch the stored credential's secret in-place. The patch is shallow-merged
 * onto the existing secret object — the caller need only supply the fields
 * they want to override (e.g. `{ expires_at: now() - 60 }`).
 *
 * Returns the updated credential summary.
 */
export async function tamperCredential(
  provider: string,
  patch: Record<string, unknown>,
  config: HarnessConfig = {},
): Promise<CredentialSummary> {
  const current = await readCredential(provider, config);
  const nextSecret = { ...current.secret, ...patch };
  const url = `${linkBaseUrl(config)}/v1/credentials/${encodeURIComponent(current.id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: nextSecret }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH credential ${current.id} failed: ${res.status} ${text}`);
  }
  return parseCredentialSummary(await res.json());
}

export interface MetricSample {
  /** Counter or histogram name (the metric identifier before `{`). */
  name: string;
  /** Label set as parsed from the Prometheus exposition. */
  labels: Record<string, string>;
  /** Numeric value as exposed. */
  value: number;
}

/**
 * Fetch the Prometheus exposition from Link's `/metrics` endpoint and parse
 * it into a flat list of samples. Each `{label=value}` line is one sample.
 * Comments (`# HELP` / `# TYPE`) are skipped.
 */
export async function readMetrics(config: HarnessConfig = {}): Promise<MetricSample[]> {
  const res = await fetch(`${linkBaseUrl(config)}/metrics`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /metrics failed: ${res.status} ${text}`);
  }
  return parsePrometheus(await res.text());
}

/**
 * Tiny Prometheus exposition parser. Handles the subset the daemon/Link emit:
 *
 *   name 1.0
 *   name{label="value"} 1.0
 *   name{a="x",b="y"} 1.0
 *
 * Anything more exotic (histograms with quantiles, escape sequences in label
 * values) falls through unparsed and is returned as a sample with the raw
 * label string under a `__raw__` key so the test can still observe the line
 * if needed.
 */
export function parsePrometheus(text: string): MetricSample[] {
  const out: MetricSample[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const sample = parseSampleLine(line);
    if (sample !== null) out.push(sample);
  }
  return out;
}

function parseSampleLine(line: string): MetricSample | null {
  const braceIdx = line.indexOf("{");
  let name: string;
  let labelsPart: string | null;
  let rest: string;
  if (braceIdx === -1) {
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx === -1) return null;
    name = line.slice(0, spaceIdx);
    labelsPart = null;
    rest = line.slice(spaceIdx + 1).trim();
  } else {
    name = line.slice(0, braceIdx);
    const closeIdx = line.indexOf("}", braceIdx);
    if (closeIdx === -1) return null;
    labelsPart = line.slice(braceIdx + 1, closeIdx);
    rest = line.slice(closeIdx + 1).trim();
  }
  const valueStr = rest.split(/\s+/)[0];
  if (valueStr === undefined) return null;
  const value = Number(valueStr);
  if (!Number.isFinite(value)) return null;
  const labels = labelsPart === null ? {} : parseLabels(labelsPart);
  return { name, labels, value };
}

function parseLabels(input: string): Record<string, string> {
  const labels: Record<string, string> = {};
  // Walk char-by-char to handle commas inside quoted values robustly enough
  // for the daemon's emitted labels (no escape sequences expected).
  let i = 0;
  while (i < input.length) {
    const eq = input.indexOf("=", i);
    if (eq === -1) break;
    const key = input.slice(i, eq).trim();
    if (input[eq + 1] !== '"') break;
    const quoteEnd = input.indexOf('"', eq + 2);
    if (quoteEnd === -1) break;
    const value = input.slice(eq + 2, quoteEnd);
    labels[key] = value;
    i = quoteEnd + 1;
    if (input[i] === ",") i += 1;
  }
  return labels;
}

/**
 * Find samples whose `name` exactly matches and whose labels match every
 * key/value in `labelMatch` (extra labels on the sample are allowed).
 */
export function findSamples(
  samples: MetricSample[],
  name: string,
  labelMatch: Record<string, string> = {},
): MetricSample[] {
  return samples.filter((s) => {
    if (s.name !== name) return false;
    for (const [k, v] of Object.entries(labelMatch)) {
      if (s.labels[k] !== v) return false;
    }
    return true;
  });
}

/**
 * Sum the values of all samples for `name` that match `labelMatch`. Counters
 * that appear under multiple label sets aggregate into one number — useful
 * for "did the counter move at all" assertions where the label dimensions
 * aren't the focus.
 */
export function sumCounter(
  samples: MetricSample[],
  name: string,
  labelMatch: Record<string, string> = {},
): number {
  let total = 0;
  for (const s of findSamples(samples, name, labelMatch)) {
    total += s.value;
  }
  return total;
}

export interface AssertCounterIncrementedOptions {
  /** Counter labels to filter on. Extra labels on the sample are allowed. */
  labelMatch?: Record<string, string>;
  /** Minimum required delta. Default 1. */
  by?: number;
}

/**
 * Assert that the counter `name` moved between `before` and `after` snapshots.
 * Throws an Error (with the two values + expected delta) if the move was
 * less than `by`. Returns the actual delta on success.
 */
export function assertCounterIncremented(
  before: MetricSample[],
  after: MetricSample[],
  name: string,
  options: AssertCounterIncrementedOptions = {},
): number {
  const labelMatch = options.labelMatch ?? {};
  const by = options.by ?? 1;
  const beforeValue = sumCounter(before, name, labelMatch);
  const afterValue = sumCounter(after, name, labelMatch);
  const delta = afterValue - beforeValue;
  if (delta < by) {
    const labelStr = Object.entries(labelMatch)
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
    const where = labelStr.length > 0 ? `${name}{${labelStr}}` : name;
    throw new Error(
      `counter ${where} expected to increase by ≥${by} but moved from ${beforeValue} → ${afterValue} (delta ${delta})`,
    );
  }
  return delta;
}

#!/usr/bin/env -S deno run -A

/**
 * scripts/validate-image-models.ts
 *
 * Validates every entry in `IMAGE_OVERLAY` against live providers and writes
 * envelope-only fixtures to
 *   packages/bundled-agents/src/image-generation/__fixtures__/<provider>__<model>.json
 *
 * For each (model, transport ∈ {direct, proxy}):
 *   1. Generate: text-to-image with the entry's defaults + a fixed prompt.
 *   2. Edit (if capabilities.edit): structured prompt + a 1×1 PNG input.
 *
 * Captures envelope only — `warnings`, `providerMetadata`, `mediaType`,
 * `base64Length`, `imageCount`. No binary blobs in JSON.
 *
 * Thumbnails are intentionally NOT written: writing a ≤64×64 thumbnail (per
 * design v3 step 4) requires a PNG decoder + resampler, which is too much
 * dependency surface for a one-shot script. The `__fixtures__/_thumbnails/`
 * directory is still gitignored so a future operator can drop generated
 * PNGs there manually for visual sanity-checks without polluting the repo.
 *
 * Dual-transport mechanics: this script runs in a single process. Between
 * transports it mutates `process.env.LITELLM_API_KEY`, calls `resetRegistry()`
 * to evict cached provider clients, and re-runs each entry. Originals are
 * restored on exit.
 *
 * `lastValidatedAt` updates: the script PRINTS a unified diff for
 * `packages/llm/src/image-capabilities.ts` for the operator to apply
 * manually. Editing the source file from a one-shot script is fragile and
 * fights the formatter; a printable diff makes the manual step honest.
 *
 * Pre-flight cost preview + y/N gate before any network call. `MAX_CALLS = 24`
 * is a hard ceiling (6 models × 2 ops × 2 transports). Per-call failures are
 * collected and printed at the end; the run does not abort on a single
 * provider error.
 *
 * Exit code: 0 if at least one (model, transport, op) verified; 1 only if
 * everything failed.
 *
 * Usage:
 *   deno run -A scripts/validate-image-models.ts                # both transports
 *   deno run -A scripts/validate-image-models.ts --direct       # direct only
 *   deno run -A scripts/validate-image-models.ts --proxy        # proxy only
 *   deno run -A scripts/validate-image-models.ts --yes          # skip y/N gate
 *   deno run -A scripts/validate-image-models.ts --dry-run      # print plan, no calls
 *
 * Env (direct pass): GEMINI_API_KEY, OPENAI_API_KEY (per provider).
 * Env (proxy pass):  LITELLM_API_KEY (+ optional LITELLM_BASE_URL).
 */

import { parseArgs } from "jsr:@std/cli@^1.0.6/parse-args";
import { decodeBase64 } from "jsr:@std/encoding@^1/base64";
import { dirname, fromFileUrl, join, resolve } from "jsr:@std/path@^1";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import process from "node:process";
import { generateImage } from "npm:ai@^6.0.184";
import { z } from "npm:zod@^4.4.3";
import {
  buildRegistryModelId,
  type ImageOverlayEntry,
  isRegistryProvider,
  listImageEntries,
  type RegistryModelId,
  registry,
  resetRegistry,
} from "@atlas/llm";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const FIXTURE_DIR = join(REPO_ROOT, "packages/bundled-agents/src/image-generation/__fixtures__");
const OVERLAY_SOURCE = join(REPO_ROOT, "packages/llm/src/image-capabilities.ts");

const GENERATE_PROMPT = "a small red circle on white background";
const EDIT_TEXT = "add a small blue square next to the red circle";

/** Hard ceiling: 6 models × 2 ops × 2 transports. Guards against accidents. */
const MAX_CALLS = 24;

/**
 * 1×1 transparent PNG. The smallest valid PNG fixture for edit-mode inputs —
 * every provider we exercise treats input images as parseable bytes, not as
 * meaningful pixels for this no-op "add a square" prompt.
 */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Cost per call in USD, hand-curated from provider list prices at design time.
 * Used solely for the pre-flight preview; this is a sanity-check estimate,
 * not a billing system. If a price is unknown we use a conservative
 * round-up that won't surprise the operator.
 */
const COST_PER_CALL_USD: Readonly<Record<string, number>> = {
  "google:gemini-2.5-flash-image": 0.04,
  "google:imagen-4.0-generate-001": 0.04,
  "google:imagen-4.0-fast-generate-001": 0.02,
  "openai:gpt-image-1.5": 0.05,
  "openai:dall-e-3": 0.04,
  "openai:dall-e-2": 0.02,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Transport = "direct" | "proxy";

const EnvelopeSchema = z.object({
  warnings: z.array(z.unknown()),
  providerMetadata: z.unknown(),
  mediaType: z.string(),
  base64Length: z.number().int().nonnegative(),
  imageCount: z.number().int().nonnegative(),
});
type Envelope = z.infer<typeof EnvelopeSchema>;

const FixtureSchema = z.object({
  direct: EnvelopeSchema.nullable(),
  proxy: EnvelopeSchema.nullable(),
});
type Fixture = z.infer<typeof FixtureSchema>;

interface CallFailure {
  id: string;
  transport: Transport;
  operation: "generate" | "edit";
  error: string;
}

interface CliArgs {
  direct: boolean;
  proxy: boolean;
  yes: boolean;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Plain-text operator output
//
// Scripts in this repo use `console.*` (see lint-corpus.ts), but the
// codebase convention is `@atlas/logger`. The logger emits JSON which is
// hostile to operators reading an interactive CLI — so we write plain text
// directly to stdout/stderr instead. Neither `console.*` nor a logger that
// would wrap every line in JSON.
// ---------------------------------------------------------------------------

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function errLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseCliArgs(argv: string[]): CliArgs {
  const parsed = parseArgs(argv, {
    boolean: ["direct", "proxy", "yes", "dry-run"],
    default: { direct: false, proxy: false, yes: false, "dry-run": false },
  });
  // If neither --direct nor --proxy is set explicitly, run both. If only
  // one is set, the other is implicitly off. (--direct AND --proxy is the
  // same as the default.)
  const transportsExplicitlyRequested = parsed.direct || parsed.proxy;
  return {
    direct: transportsExplicitlyRequested ? parsed.direct : true,
    proxy: transportsExplicitlyRequested ? parsed.proxy : true,
    yes: parsed.yes,
    dryRun: parsed["dry-run"],
  };
}

// ---------------------------------------------------------------------------
// Fixture I/O
// ---------------------------------------------------------------------------

function fixturePath(id: string): string {
  // `provider:model` → `provider__model.json`. Double underscore because `:`
  // is unsafe on macOS/Windows filesystems and naked underscores can be
  // valid provider-id characters in some ecosystems.
  return join(FIXTURE_DIR, `${id.replace(":", "__")}.json`);
}

async function readExistingFixture(path: string): Promise<Fixture | null> {
  try {
    await stat(path);
  } catch {
    return null;
  }
  const raw = await readFile(path, "utf-8");
  const parsed = FixtureSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    errLine(`! ${path}: existing fixture failed schema parse — overwriting`);
    return null;
  }
  return parsed.data;
}

async function writeFixture(path: string, fixture: Fixture): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Pretty-print so reviewers can scan diffs of envelope drift between runs.
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf-8");
}

/**
 * Merge a new envelope into the existing fixture for one transport.
 * Preserves the other transport's value untouched. New `null` is a real
 * value — "we ran this transport and it failed" — and overwrites the
 * prior value rather than being skipped.
 */
function mergeFixture(
  prior: Fixture | null,
  transport: Transport,
  envelope: Envelope | null,
): Fixture {
  const base: Fixture = prior ?? { direct: null, proxy: null };
  return { ...base, [transport]: envelope };
}

// ---------------------------------------------------------------------------
// Envelope extraction
// ---------------------------------------------------------------------------

function envelopeFrom(result: Awaited<ReturnType<typeof generateImage>>): Envelope {
  const first = result.images[0];
  if (!first) {
    // Treat "no image" as a failure-shaped envelope. The caller surfaces this
    // up to the failures collector by short-circuiting on the throw below;
    // an empty result is not a useful fixture to write.
    throw new Error("generateImage returned zero images");
  }
  return {
    warnings: result.warnings ?? [],
    providerMetadata: result.providerMetadata ?? {},
    mediaType: first.mediaType,
    base64Length: first.base64.length,
    imageCount: result.images.length,
  };
}

// ---------------------------------------------------------------------------
// Operation parameters per entry
// ---------------------------------------------------------------------------

/**
 * Validate an aspect ratio string into the template-literal type the AI SDK
 * requires. The overlay stores `aspectRatio: string`, but `generateImage`
 * wants `${number}:${number}`. `z.custom<T>` with a type-guard predicate
 * narrows to the template-literal shape with no `as` cast.
 */
const AspectRatioSchema = z.custom<`${number}:${number}`>(
  (v: unknown): v is `${number}:${number}` => typeof v === "string" && /^\d+:\d+$/.test(v),
  { message: "aspectRatio must look like '1:1'" },
);

interface CallSpec {
  prompt: string | { images: Uint8Array[]; text: string };
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
}

function generateSpec(entry: ImageOverlayEntry): CallSpec {
  const spec: CallSpec = { prompt: GENERATE_PROMPT };
  if (entry.defaults.controlAxis === "size") {
    spec.size = entry.defaults.size;
  } else {
    spec.aspectRatio = AspectRatioSchema.parse(entry.defaults.aspectRatio);
  }
  return spec;
}

function editSpec(entry: ImageOverlayEntry, inputImage: Uint8Array): CallSpec {
  const base = generateSpec(entry);
  return { ...base, prompt: { images: [inputImage], text: EDIT_TEXT } };
}

// ---------------------------------------------------------------------------
// Transport env handling
// ---------------------------------------------------------------------------

/**
 * Snapshot of the env vars this script mutates. Captured at start and
 * restored on exit so a partial run can't leak proxy creds into the user's
 * subsequent shell sessions.
 */
interface EnvSnapshot {
  litellmApiKey: string | undefined;
}

function snapshotEnv(): EnvSnapshot {
  return { litellmApiKey: process.env.LITELLM_API_KEY };
}

function restoreEnv(snap: EnvSnapshot): void {
  if (snap.litellmApiKey === undefined) {
    delete process.env.LITELLM_API_KEY;
  } else {
    process.env.LITELLM_API_KEY = snap.litellmApiKey;
  }
  resetRegistry();
}

function applyTransportEnv(transport: Transport, snap: EnvSnapshot): void {
  if (transport === "direct") {
    delete process.env.LITELLM_API_KEY;
  } else {
    if (!snap.litellmApiKey) {
      throw new Error("LITELLM_API_KEY is not set — cannot exercise the proxy transport");
    }
    process.env.LITELLM_API_KEY = snap.litellmApiKey;
  }
  resetRegistry();
}

/**
 * For the direct transport, each provider needs its own env var. Returning
 * the missing var (if any) lets us skip cleanly with a clear reason rather
 * than burn a budgeted call on a guaranteed 401.
 */
function missingDirectCredential(id: string): string | null {
  const provider = id.split(":")[0];
  if (provider === "google") return process.env.GEMINI_API_KEY ? null : "GEMINI_API_KEY";
  if (provider === "openai") return process.env.OPENAI_API_KEY ? null : "OPENAI_API_KEY";
  // Other providers don't currently appear in the overlay; reject defensively
  // so a future overlay addition surfaces a missing-creds skip explicitly.
  return `unknown-provider:${provider}`;
}

// ---------------------------------------------------------------------------
// Cost preview
// ---------------------------------------------------------------------------

interface PlannedCall {
  id: string;
  transport: Transport;
  operation: "generate" | "edit";
}

function planCalls(transports: Transport[]): PlannedCall[] {
  const calls: PlannedCall[] = [];
  for (const entry of listImageEntries()) {
    for (const transport of transports) {
      calls.push({ id: entry.id, transport, operation: "generate" });
      if (entry.capabilities.edit) {
        calls.push({ id: entry.id, transport, operation: "edit" });
      }
    }
  }
  return calls;
}

function estimatedCostUsd(call: PlannedCall): number {
  // If pricing is unknown, fall back to the highest per-call price we
  // know of so the preview never under-promises the spend.
  const known = COST_PER_CALL_USD[call.id];
  if (known !== undefined) return known;
  return Math.max(...Object.values(COST_PER_CALL_USD));
}

function printCostPreview(plan: PlannedCall[]): void {
  const total = plan.reduce((sum, c) => sum + estimatedCostUsd(c), 0);
  out("Validation harness — projected spend");
  out("====================================");
  out(`Total planned calls: ${String(plan.length)} (cap: ${String(MAX_CALLS)})`);
  out(`Estimated cost: ~$${total.toFixed(2)} USD`);
  out("");
  out("Per (model, transport, op):");
  for (const call of plan) {
    out(
      `  - ${call.id} · ${call.transport} · ${call.operation} (~$${estimatedCostUsd(call).toFixed(2)})`,
    );
  }
  out("");
  out("Costs are list-price estimates and may differ from your actual bill.");
}

// ---------------------------------------------------------------------------
// Y/N gate
// ---------------------------------------------------------------------------

function confirmYesNo(question: string): boolean {
  // Use the DOM `prompt` global that Deno provides — simpler than wiring
  // stdin readers for a one-shot script. Empty / non-y answers count as N.
  const answer = prompt(question);
  if (answer === null) return false;
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "y" || trimmed === "yes";
}

// ---------------------------------------------------------------------------
// `lastValidatedAt` diff
// ---------------------------------------------------------------------------

/**
 * Print a unified diff for `image-capabilities.ts` updating
 * `lastValidatedAt` for each verified entry. The operator applies it by
 * hand — see file header for the rationale (no fragile source-mutating
 * codemod in a one-shot script).
 */
async function printLastValidatedAtDiff(verified: ReadonlySet<string>): Promise<void> {
  if (verified.size === 0) return;
  const source = await readFile(OVERLAY_SOURCE, "utf-8");
  const lines = source.split("\n");
  const today = new Date().toISOString().slice(0, 10);

  out("");
  out("Suggested diff for packages/llm/src/image-capabilities.ts");
  out("=========================================================");
  out("Apply by hand. Each block updates one entry's lastValidatedAt.");
  out("");

  let currentEntryId: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const idMatch = line.match(/^\s*"([^"]+:[^"]+)":\s*\{/);
    if (idMatch?.[1]) {
      currentEntryId = idMatch[1];
      continue;
    }
    const stampMatch = line.match(/^(\s*)lastValidatedAt:\s*"([^"]+)"(,?)\s*$/);
    if (stampMatch && currentEntryId && verified.has(currentEntryId)) {
      const [, indent = "", priorDate = "", trailingComma = ""] = stampMatch;
      if (priorDate === today) continue;
      out(`--- a/packages/llm/src/image-capabilities.ts`);
      out(`+++ b/packages/llm/src/image-capabilities.ts`);
      out(`@@ entry "${currentEntryId}" @@`);
      out(`-${indent}lastValidatedAt: "${priorDate}"${trailingComma}`);
      out(`+${indent}lastValidatedAt: "${today}"${trailingComma}`);
      out("");
    }
  }
}

// ---------------------------------------------------------------------------
// Single-call execution
// ---------------------------------------------------------------------------

/**
 * Build a typed registry model id from an overlay entry id. Returns null
 * if the provider half isn't in `REGISTRY_PROVIDERS` — the harness skips
 * those entries with a clear failure rather than casting through `as`.
 */
function toRegistryModelId(id: string): RegistryModelId | null {
  const colon = id.indexOf(":");
  if (colon <= 0 || colon === id.length - 1) return null;
  const provider = id.slice(0, colon);
  const model = id.slice(colon + 1);
  if (!isRegistryProvider(provider)) return null;
  return buildRegistryModelId(provider, model);
}

async function runOneCall(
  id: string,
  entry: ImageOverlayEntry,
  transport: Transport,
  operation: "generate" | "edit",
  inputImage: Uint8Array,
  failures: CallFailure[],
): Promise<Envelope | null> {
  const registryId = toRegistryModelId(id);
  if (!registryId) {
    failures.push({
      id,
      transport,
      operation,
      error: `id '${id}' does not name a registered provider`,
    });
    errLine(`✗ ${id} · ${transport} · ${operation}: invalid registry id`);
    return null;
  }
  const spec = operation === "generate" ? generateSpec(entry) : editSpec(entry, inputImage);
  try {
    const model = registry.imageModel(registryId);
    const result = await generateImage({
      model,
      prompt: spec.prompt,
      size: spec.size,
      aspectRatio: spec.aspectRatio,
    });
    const envelope = envelopeFrom(result);
    out(`✓ ${id} · ${transport} · ${operation}`);
    return envelope;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ id, transport, operation, error: message });
    errLine(`✗ ${id} · ${transport} · ${operation}: ${message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  const transports: Transport[] = [];
  if (args.direct) transports.push("direct");
  if (args.proxy) transports.push("proxy");

  if (transports.length === 0) {
    errLine("Nothing to do: both --direct and --proxy disabled.");
    return 1;
  }

  const plan = planCalls(transports);
  if (plan.length > MAX_CALLS) {
    errLine(
      `Planned ${String(plan.length)} calls exceeds MAX_CALLS=${String(MAX_CALLS)}. ` +
        "Refusing to run — adjust the overlay size or this constant.",
    );
    return 1;
  }

  printCostPreview(plan);

  if (args.dryRun) {
    out("");
    out("--dry-run set; exiting without making network calls.");
    return 0;
  }

  if (!args.yes) {
    const ok = confirmYesNo("Proceed with live calls? [y/N] ");
    if (!ok) {
      out("Aborted by operator.");
      return 0;
    }
  }

  const inputImage = decodeBase64(TINY_PNG_BASE64);
  const failures: CallFailure[] = [];
  const verified = new Set<string>();

  const envSnap = snapshotEnv();
  try {
    for (const transport of transports) {
      out("");
      out(`== Transport: ${transport} ==`);
      applyTransportEnv(transport, envSnap);

      for (const entry of listImageEntries()) {
        // Pre-flight credential check per (entry, transport): the proxy
        // transport satisfies every provider via LITELLM_API_KEY (already
        // verified by applyTransportEnv); the direct transport needs the
        // per-provider env var.
        if (transport === "direct") {
          const missing = missingDirectCredential(entry.id);
          if (missing) {
            errLine(`- ${entry.id} · direct · skipped (no ${missing})`);
            failures.push({
              id: entry.id,
              transport,
              operation: "generate",
              error: `missing credential: ${missing}`,
            });
            const priorFixture = await readExistingFixture(fixturePath(entry.id));
            const merged = mergeFixture(priorFixture, transport, null);
            await writeFixture(fixturePath(entry.id), merged);
            continue;
          }
        }

        // Generate is always exercised. If it succeeds, the envelope is the
        // fixture for this (entry, transport). Edit runs after for
        // capability validation only — its success/failure is reported but
        // doesn't replace the captured envelope (one shape per transport,
        // per design v3).
        const genEnvelope = await runOneCall(
          entry.id,
          entry,
          transport,
          "generate",
          inputImage,
          failures,
        );
        if (genEnvelope) verified.add(entry.id);

        if (entry.capabilities.edit) {
          const editEnvelope = await runOneCall(
            entry.id,
            entry,
            transport,
            "edit",
            inputImage,
            failures,
          );
          if (editEnvelope) verified.add(entry.id);
        }

        // Persist after each entry so a mid-run crash still preserves
        // partial progress for subsequent re-runs.
        const priorFixture = await readExistingFixture(fixturePath(entry.id));
        const merged = mergeFixture(priorFixture, transport, genEnvelope);
        await writeFixture(fixturePath(entry.id), merged);
      }
    }
  } finally {
    restoreEnv(envSnap);
  }

  // ---- Failure summary ---------------------------------------------------
  if (failures.length > 0) {
    out("");
    out("Failures");
    out("========");
    for (const f of failures) {
      out(`- ${f.id} · ${f.transport} · ${f.operation}: ${f.error}`);
    }
  }

  // ---- Diff for lastValidatedAt -----------------------------------------
  await printLastValidatedAtDiff(verified);

  // ---- Final verdict -----------------------------------------------------
  out("");
  if (verified.size === 0) {
    errLine("FAIL: no overlay entries verified any declared capability.");
    return 1;
  }
  out(
    `OK: ${String(verified.size)}/${String(listImageEntries().length)} entries verified at least one capability.`,
  );
  return 0;
}

process.exit(await main());

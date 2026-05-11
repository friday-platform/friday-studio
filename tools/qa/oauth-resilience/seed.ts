/**
 * Credential seeding for OAuth refresh-resilience QA.
 *
 * The QA plan assumes the daemon starts "logged in" to Google — a
 * pre-recorded delegated OAuth credential already in storage for
 * `google-calendar` and `google-gmail`. Without this, Friday's MCP
 * tool resolution can't even request a refresh; the scenarios would
 * fail at "no credential found for provider" instead of exercising
 * the refresh code path.
 *
 * Seed JSON templates live under `tools/qa/fixtures/oauth-refresh-qa/
 * credentials/`. They contain literal `$EXPIRES_AT` / `$CREATED_AT` /
 * `$UPDATED_AT` placeholders that this module substitutes with the
 * absolute timestamps at seed time. The substituted file is written
 * to `<FRIDAY_HOME>/credentials/dev/<id>.json` — matching what
 * `FileSystemStorageAdapter` reads at runtime.
 *
 * `expires_at` defaults to "now + 3600s" (a healthy access_token).
 * Scenarios that need an expired or expiring token use
 * `harness.tamperCredential` after the daemon is up.
 */
import { join } from "jsr:@std/path@1";

/** Absolute path to the seed templates directory. */
const SEED_DIR = (() => {
  // tools/qa/oauth-resilience/seed.ts → ../fixtures/oauth-refresh-qa/credentials
  const here = new URL(".", import.meta.url).pathname;
  return new URL("../fixtures/oauth-refresh-qa/credentials/", `file://${here}`).pathname;
})();

/** Filenames inside SEED_DIR — one per provider. Order is stable. */
const SEED_FILES: ReadonlyArray<string> = ["google-calendar.json", "google-gmail.json"];

export interface SeedCredentialsOptions {
  /** Absolute path to FRIDAY_HOME. Required — no fallback to the host env. */
  fridayHome: string;
  /**
   * User id under which to seed. Default `"dev"` — matches the
   * LINK_DEV_MODE userId.
   */
  userId?: string;
  /**
   * `expires_at` offset (seconds from now) for the seeded
   * access_token. Default `3600` — within the 5-min proactive refresh
   * window only when the scenario tampers it down. The healthy default
   * lets scenarios opt-in to expiry via `tamperCredential`.
   */
  expiresInSeconds?: number;
  /**
   * Override the seed template directory. Tests use this; production
   * leaves it undefined.
   */
  seedDir?: string;
}

export interface SeededCredential {
  id: string;
  provider: string;
  path: string;
}

/**
 * Materialize the credential JSON templates into `<FRIDAY_HOME>/
 * credentials/<userId>/`. Returns one entry per seeded file with the
 * absolute path it landed at, so callers (or tests) can assert.
 */
export async function seedCredentials(
  options: SeedCredentialsOptions,
): Promise<SeededCredential[]> {
  const userId = options.userId ?? "dev";
  const expiresInSeconds = options.expiresInSeconds ?? 3600;
  const seedDir = options.seedDir ?? SEED_DIR;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = nowSeconds + expiresInSeconds;
  const nowIso = new Date(nowSeconds * 1000).toISOString();

  const userDir = join(options.fridayHome, "credentials", userId);
  await Deno.mkdir(userDir, { recursive: true });

  const seeded: SeededCredential[] = [];
  for (const filename of SEED_FILES) {
    const templatePath = join(seedDir, filename);
    const raw = await Deno.readTextFile(templatePath);
    const substituted = substitutePlaceholders(raw, {
      EXPIRES_AT: expiresAt,
      CREATED_AT: nowIso,
      UPDATED_AT: nowIso,
    });
    const parsed = parseCredential(substituted, templatePath);
    const targetPath = join(userDir, `${parsed.id}.json`);
    await Deno.writeTextFile(targetPath, `${JSON.stringify(parsed, null, 2)}\n`);
    seeded.push({ id: parsed.id, provider: parsed.provider, path: targetPath });
  }
  return seeded;
}

interface SeededCredentialJSON {
  id: string;
  provider: string;
  // The full structure is wider than this, but the seeder only inspects
  // these two fields for output bookkeeping. The rest is round-tripped
  // verbatim so Link reads exactly the JSON the test author wrote.
  [key: string]: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCredential(raw: string, sourcePath: string): SeededCredentialJSON {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`seed template ${sourcePath} is not valid JSON: ${stringifyError(err)}`);
  }
  if (!isPlainRecord(parsed)) {
    throw new Error(`seed template ${sourcePath} did not produce an object`);
  }
  const id = parsed.id;
  const provider = parsed.provider;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`seed template ${sourcePath} missing string "id"`);
  }
  if (typeof provider !== "string" || provider.length === 0) {
    throw new Error(`seed template ${sourcePath} missing string "provider"`);
  }
  return { ...parsed, id, provider };
}

interface PlaceholderValues {
  EXPIRES_AT: number;
  CREATED_AT: string;
  UPDATED_AT: string;
}

/**
 * Replace `$EXPIRES_AT` (a numeric placeholder — quotes get stripped so
 * the result is a JSON number, not a string), `$CREATED_AT`, and
 * `$UPDATED_AT` (string placeholders inside their existing quotes).
 *
 * The substitution is intentionally string-level: it preserves whatever
 * formatting the template author chose, and the resulting JSON is
 * parsed once before being written out so a malformed substitution
 * fails the seed instead of corrupting the daemon's storage.
 */
export function substitutePlaceholders(template: string, values: PlaceholderValues): string {
  return template
    .replaceAll('"$EXPIRES_AT"', String(values.EXPIRES_AT))
    .replaceAll("$CREATED_AT", values.CREATED_AT)
    .replaceAll("$UPDATED_AT", values.UPDATED_AT);
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

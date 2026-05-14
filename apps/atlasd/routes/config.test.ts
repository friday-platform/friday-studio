/**
 * Integration tests for the daemon-level /config/env routes.
 *
 * Regression guard for the env-var quoting bug: prior to the fix,
 * @std/dotenv's stringify wrapped any value containing a non-word
 * character in single quotes, so an API key like `sk-ant-foo` landed
 * on disk as `ANTHROPIC_API_KEY='sk-ant-foo'`. The launcher's
 * loadDotEnv (tools/friday-launcher/project.go) then forwarded the
 * literal-quoted value to spawned services, breaking authentication.
 *
 * These tests assert the on-disk shape (unquoted for simple values,
 * quoted only when the value would otherwise be ambiguous) AND that
 * PUT → GET round-trips preserve the original value semantically.
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The PUT /env handler busts two caches in @atlas/llm after writing
// the new env vars to `process.env`. Hoisted spies let the in-memory
// sync tests observe those calls — without them, a regression that
// drops either reset call would still ship green.
const mockResetRegistry = vi.hoisted(() => vi.fn<() => void>());
const mockInvalidateCatalog = vi.hoisted(() => vi.fn<() => void>());

vi.mock("@atlas/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/llm")>()),
  resetRegistry: mockResetRegistry,
  invalidateCatalog: mockInvalidateCatalog,
}));

const { configRoutes, HOT_RELOAD_DENYLIST } = await import("./config.ts");

interface PutEnvResponse {
  success: boolean;
  error?: string;
}

interface GetEnvResponse {
  success: boolean;
  envVars?: Record<string, string>;
  envPath?: string;
  error?: string;
}

let tempHome: string;
let originalFridayHome: string | undefined;
let originalFridayEnv: string | undefined;
// process.env keys the sync tests mutate — snapshotted so they don't
// leak across tests. Includes every denylist entry so the parameterized
// denylist test (which sets each key to a sentinel pre-PUT) can't leak
// to the real environment.
const SYNC_TEST_KEYS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "DEPRECATED_KEY",
  "KEPT_KEY",
  ...HOT_RELOAD_DENYLIST,
];
const syncTestSnapshot: Record<string, string | undefined> = {};

beforeEach(async () => {
  tempHome = join(tmpdir(), `atlasd-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tempHome, { recursive: true });
  originalFridayHome = process.env.FRIDAY_HOME;
  process.env.FRIDAY_HOME = tempHome;
  // `/env` is gated behind dev mode in production; the test exercises
  // the happy path (read/write the env file) so set FRIDAY_ENV=dev for
  // these cases. The dev-only gate itself is covered separately.
  originalFridayEnv = process.env.FRIDAY_ENV;
  process.env.FRIDAY_ENV = "dev";
  for (const k of SYNC_TEST_KEYS) syncTestSnapshot[k] = process.env[k];
  mockResetRegistry.mockClear();
  mockInvalidateCatalog.mockClear();
});

afterEach(async () => {
  if (originalFridayHome === undefined) {
    delete process.env.FRIDAY_HOME;
  } else {
    process.env.FRIDAY_HOME = originalFridayHome;
  }
  if (originalFridayEnv === undefined) {
    delete process.env.FRIDAY_ENV;
  } else {
    process.env.FRIDAY_ENV = originalFridayEnv;
  }
  for (const k of SYNC_TEST_KEYS) {
    const orig = syncTestSnapshot[k];
    if (orig === undefined) delete process.env[k];
    else process.env[k] = orig;
  }
  await rm(tempHome, { recursive: true, force: true });
});

function createApp() {
  const app = new Hono();
  app.route("/", configRoutes);
  return app;
}

async function putEnv(envVars: Record<string, string>): Promise<PutEnvResponse> {
  const app = createApp();
  const res = await app.request("/env", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envVars }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PutEnvResponse;
}

async function getEnv(): Promise<GetEnvResponse> {
  const app = createApp();
  const res = await app.request("/env");
  expect(res.status).toBe(200);
  return (await res.json()) as GetEnvResponse;
}

describe("PUT /env on-disk format", () => {
  test("API key with hyphens lands unquoted (the original bug)", async () => {
    await putEnv({ ANTHROPIC_API_KEY: "sk-ant-api03-foo-bar" });

    const onDisk = await readFile(join(tempHome, ".env"), "utf-8");
    expect(onDisk).toBe("ANTHROPIC_API_KEY=sk-ant-api03-foo-bar");
    expect(onDisk).not.toContain("'");
    expect(onDisk).not.toContain('"');
  });

  test("URL with slashes/colons lands unquoted", async () => {
    await putEnv({ FRIDAYD_URL: "http://localhost:18080" });

    const onDisk = await readFile(join(tempHome, ".env"), "utf-8");
    expect(onDisk).toBe("FRIDAYD_URL=http://localhost:18080");
  });

  test("value with whitespace gets single-quoted", async () => {
    await putEnv({ GREETING: "hello world" });

    const onDisk = await readFile(join(tempHome, ".env"), "utf-8");
    expect(onDisk).toBe("GREETING='hello world'");
  });

  test("value with $ gets single-quoted to avoid expansion", async () => {
    await putEnv({ KEY: "abc$def" });

    const onDisk = await readFile(join(tempHome, ".env"), "utf-8");
    expect(onDisk).toBe("KEY='abc$def'");
  });

  test("value with embedded single quote uses double quotes", async () => {
    await putEnv({ MSG: "it's fine" });

    const onDisk = await readFile(join(tempHome, ".env"), "utf-8");
    expect(onDisk).toBe(`MSG="it's fine"`);
  });

  test("newline-bearing values are rejected at the boundary", async () => {
    // The Go launcher's unquoteEnvValue strips outer quotes only; it
    // doesn't expand `\n`, so KEY="line1\nline2" would reach spawned
    // services with a literal backslash-n. Reject up front instead.
    const app = createApp();
    const res = await app.request("/env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envVars: { BLOCK: "line1\nline2" } }),
    });
    expect(res.status).toBe(400);
  });

  test("newline-bearing keys are rejected at the boundary", async () => {
    // A key with `\n` would let one PUT entry split into two on-disk
    // lines, smuggling additional env vars into spawned services on
    // the next launcher import. Schema enforces POSIX identifiers.
    const app = createApp();
    const res = await app.request("/env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envVars: { "FOO\nBAR": "baz" } }),
    });
    expect(res.status).toBe(400);
  });

  test("multiple keys are joined by newlines, no trailing newline", async () => {
    await putEnv({ ANTHROPIC_API_KEY: "sk-ant-foo", OPENAI_API_KEY: "sk-proj-bar" });

    const onDisk = await readFile(join(tempHome, ".env"), "utf-8");
    expect(onDisk).toBe("ANTHROPIC_API_KEY=sk-ant-foo\nOPENAI_API_KEY=sk-proj-bar");
  });
});

describe("PUT → GET round-trip", () => {
  test("preserves values across the full set of edge cases", async () => {
    // Newlines are rejected at the boundary (see "newline-bearing values
    // are rejected"), so the round-trip set covers every other shape the
    // Settings UI can send.
    const cases = {
      ANTHROPIC_API_KEY: "sk-ant-api03-foo-bar",
      OPENAI_URL: "https://api.openai.com/v1",
      WITH_SPACE: "hello world",
      WITH_DOLLAR: "abc$def",
      WITH_HASH: "abc#def",
      WITH_SQUOTE: "it's ok",
      WITH_DQUOTE: 'say "hi"',
      EMPTY: "",
    };

    await putEnv(cases);
    const got = await getEnv();

    expect(got.success).toBe(true);
    expect(got.envVars).toEqual(cases);
  });

  test("legacy quoted value (pre-fix .env on disk) is read unquoted by GET", async () => {
    // Simulate a .env file written by the buggy stringify that wrapped
    // hyphenated values in single quotes. @std/dotenv's parse strips
    // the quotes, so GET should already return the clean value — the
    // launcher-side fix handles forwarding to spawned services.
    const envPath = join(tempHome, ".env");
    await mkdir(tempHome, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(envPath, "ANTHROPIC_API_KEY='sk-ant-legacy-quoted'\n", "utf-8");

    const got = await getEnv();
    expect(got.envVars?.ANTHROPIC_API_KEY).toBe("sk-ant-legacy-quoted");
  });

  test("re-saving a legacy quoted .env rewrites it unquoted", async () => {
    const envPath = join(tempHome, ".env");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(envPath, "ANTHROPIC_API_KEY='sk-ant-legacy'\n", "utf-8");

    const before = await getEnv();
    expect(before.envVars?.ANTHROPIC_API_KEY).toBe("sk-ant-legacy");

    // Round-trip back through PUT — the value parsed cleanly, the
    // re-write must NOT re-introduce the quotes.
    if (!before.envVars) throw new Error("envVars missing from GET response");
    await putEnv(before.envVars);

    const onDisk = await readFile(envPath, "utf-8");
    expect(onDisk).toBe("ANTHROPIC_API_KEY=sk-ant-legacy");
  });
});

describe("PUT /env in-memory sync (hot reload)", () => {
  test("adds new keys to process.env so they're usable without restart", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await putEnv({ ANTHROPIC_API_KEY: "sk-ant-hot-reload" });
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-hot-reload");
  });

  test("removes keys absent from the new payload from process.env", async () => {
    await putEnv({ DEPRECATED_KEY: "old-value" });
    expect(process.env.DEPRECATED_KEY).toBe("old-value");

    await putEnv({ KEPT_KEY: "kept" });
    expect(process.env.DEPRECATED_KEY).toBeUndefined();
    expect(process.env.KEPT_KEY).toBe("kept");
  });

  // Every denylist entry: PUT writes the new value to .env, but
  // `process.env[key]` must retain its pre-PUT value. Parameterized so
  // any future addition to HOT_RELOAD_DENYLIST gets coverage for free.
  // FRIDAY_HOME / FRIDAY_ENV are load-bearing for the test harness
  // itself (route lookup, dev-only gate), so we keep their beforeEach
  // values rather than overwriting with a fresh sentinel.
  const KEYS_PRESERVED_FROM_BEFORE_EACH = new Set(["FRIDAY_HOME", "FRIDAY_ENV"]);
  test.each([
    ...HOT_RELOAD_DENYLIST,
  ])("denylist key %s is written to .env but not mutated on process.env", async (key) => {
    if (!KEYS_PRESERVED_FROM_BEFORE_EACH.has(key)) {
      process.env[key] = `pre-put-sentinel-${key}`;
    }
    const expected = process.env[key];

    await putEnv({ [key]: `/totally/different/${key}` });

    const onDisk = await readFile(join(tempHome, ".env"), "utf-8");
    expect(onDisk).toContain(`${key}=/totally/different/${key}`);
    expect(process.env[key]).toBe(expected);
  });

  test("busts both the provider registry and the model catalog cache", async () => {
    // Deno's `--env-file` reads once at startup, and both `@atlas/llm`
    // caches memoize `process.env` reads — without the resets, a
    // freshly-saved API key would stay invisible to the running
    // daemon until restart. Assert the calls so dropping either one
    // from the handler trips a test.
    await putEnv({ ANTHROPIC_API_KEY: "sk-ant-cache-bust" });

    expect(mockResetRegistry).toHaveBeenCalledTimes(1);
    expect(mockInvalidateCatalog).toHaveBeenCalledTimes(1);
  });
});

describe("per-key /env/:key routes", () => {
  async function putKey(key: string, value: string): Promise<Response> {
    return await createApp().request(`/env/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  }

  test("PUT then GET round-trips one key", async () => {
    expect((await putKey("MY_SETTING", "hello world")).status).toBe(200);
    const res = await createApp().request("/env/MY_SETTING");
    expect(res.status).toBe(200);
    expect((await res.json()) as { value?: string }).toMatchObject({
      success: true,
      key: "MY_SETTING",
      value: "hello world",
    });
  });

  test("PUT preserves comments and unrelated keys", async () => {
    const envPath = join(tempHome, ".env");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(envPath, "# operator notes\nKEEP_ME=untouched\n", "utf-8");

    expect((await putKey("NEW_KEY", "new-value")).status).toBe(200);

    const onDisk = await readFile(envPath, "utf-8");
    expect(onDisk).toBe("# operator notes\nKEEP_ME=untouched\nNEW_KEY=new-value\n");
  });

  test("GET on an absent key is 404", async () => {
    const res = await createApp().request("/env/NOT_SET");
    expect(res.status).toBe(404);
  });

  test("DELETE removes the key and reports removed", async () => {
    await putKey("DOOMED", "x");
    const del = await createApp().request("/env/DOOMED", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()) as { removed?: boolean }).toMatchObject({ removed: true });
    expect((await createApp().request("/env/DOOMED")).status).toBe(404);
  });

  test("DELETE on an absent key reports removed: false", async () => {
    const del = await createApp().request("/env/NEVER_EXISTED", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()) as { removed?: boolean }).toMatchObject({ removed: false });
  });

  test("PUT hot-reloads process.env and busts the caches", async () => {
    // KEPT_KEY is in SYNC_TEST_KEYS, so afterEach restores it.
    delete process.env.KEPT_KEY;
    await putKey("KEPT_KEY", "live-value");
    expect(process.env.KEPT_KEY).toBe("live-value");
    expect(mockResetRegistry).toHaveBeenCalled();
    expect(mockInvalidateCatalog).toHaveBeenCalled();
  });

  test("PUT on a denylist key writes to disk but does not mutate process.env", async () => {
    const before = process.env.FRIDAY_UV_PATH;
    await putKey("FRIDAY_UV_PATH", "/totally/different/uv");
    const onDisk = await readFile(join(tempHome, ".env"), "utf-8");
    expect(onDisk).toContain("FRIDAY_UV_PATH=/totally/different/uv");
    expect(process.env.FRIDAY_UV_PATH).toBe(before);
  });

  test("per-key routes are dev-gated", async () => {
    process.env.FRIDAY_ENV = "production";
    expect((await createApp().request("/env/ANYTHING")).status).toBe(403);
    expect((await putKey("ANYTHING", "x")).status).toBe(403);
    expect((await createApp().request("/env/ANYTHING", { method: "DELETE" })).status).toBe(403);
  });
});

describe("/env dev-only gate", () => {
  // The /env endpoints (read + write of the daemon's .env) are
  // operator-level — they expose every credential the daemon has and
  // accept arbitrary writes. In non-dev modes (cloud, multi-user
  // deployments) they must 403 so a logged-in caller can't extract
  // or rewrite global credentials.
  test("GET /env returns 403 when FRIDAY_ENV is not 'dev'", async () => {
    process.env.FRIDAY_ENV = "production";
    const app = createApp();
    const res = await app.request("/env", { method: "GET" });
    expect(res.status).toBe(403);
  });

  test("PUT /env returns 403 when FRIDAY_ENV is not 'dev'", async () => {
    process.env.FRIDAY_ENV = "production";
    const app = createApp();
    const res = await app.request("/env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envVars: { FOO: "bar" } }),
    });
    expect(res.status).toBe(403);
  });

  test("GET /env returns 403 when FRIDAY_ENV is unset (fail-closed)", async () => {
    delete process.env.FRIDAY_ENV;
    const app = createApp();
    const res = await app.request("/env", { method: "GET" });
    expect(res.status).toBe(403);
  });
});

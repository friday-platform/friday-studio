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
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { configRoutes } from "./config.ts";

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

beforeEach(async () => {
  tempHome = join(tmpdir(), `atlasd-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tempHome, { recursive: true });
  originalFridayHome = process.env.FRIDAY_HOME;
  process.env.FRIDAY_HOME = tempHome;
});

afterEach(async () => {
  if (originalFridayHome === undefined) {
    delete process.env.FRIDAY_HOME;
  } else {
    process.env.FRIDAY_HOME = originalFridayHome;
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

  test("multi-line value uses double quotes with escaped newlines", async () => {
    await putEnv({ BLOCK: "line1\nline2" });

    const onDisk = await readFile(join(tempHome, ".env"), "utf-8");
    expect(onDisk).toBe(`BLOCK="line1\\nline2"`);
  });

  test("multiple keys are joined by newlines, no trailing newline", async () => {
    await putEnv({ ANTHROPIC_API_KEY: "sk-ant-foo", OPENAI_API_KEY: "sk-proj-bar" });

    const onDisk = await readFile(join(tempHome, ".env"), "utf-8");
    expect(onDisk).toBe("ANTHROPIC_API_KEY=sk-ant-foo\nOPENAI_API_KEY=sk-proj-bar");
  });
});

describe("PUT → GET round-trip", () => {
  test("preserves values across the full set of edge cases", async () => {
    const cases = {
      ANTHROPIC_API_KEY: "sk-ant-api03-foo-bar",
      OPENAI_URL: "https://api.openai.com/v1",
      WITH_SPACE: "hello world",
      WITH_DOLLAR: "abc$def",
      WITH_HASH: "abc#def",
      WITH_SQUOTE: "it's ok",
      WITH_DQUOTE: 'say "hi"',
      WITH_NEWLINE: "line1\nline2",
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

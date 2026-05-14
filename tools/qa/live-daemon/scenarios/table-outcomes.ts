#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * Table-view rendering evals.
 *
 * For every mimeType the dedicated `/artifacts/[id]/table` route
 * claims to render, this suite drives a representative content
 * fixture through the real daemon, asserts the artifact stores +
 * returns with the right metadata, and verifies the content endpoint
 * serves the bytes the table view would parse.
 *
 * Scenarios:
 *   - csv-artifact-roundtrip    — text/csv artifact creates, stores
 *                                 with right mime, returns intact.
 *   - tsv-artifact-roundtrip    — text/tab-separated-values.
 *   - json-array-roundtrip      — application/json (array-of-objects).
 *   - html-table-roundtrip      — text/html containing a <table>.
 *   - markdown-table-roundtrip  — text/markdown table block.
 *   - prose-not-mistagged       — large prose with commas POSTed as
 *                                 text/plain stays text/plain (the
 *                                 daemon should not silently re-sniff
 *                                 a caller-specified mime).
 *
 * Why direct POST instead of chat-driven: the table view is a
 * playground-side route that consumes daemon artifact endpoints.
 * LLM-in-the-loop content generation is nondeterministic (size
 * thresholds, tool picks) and noise wins. Direct POST tests the
 * daemon's storage + retrieval contract — exactly what the route's
 * loader depends on — without flaky LLM behavior.
 */

import { dirname, join } from "jsr:@std/path@1";
import {
  currentGitSha,
  type DaemonHandle,
  ensureCredentialsLoaded,
  HARNESS_PATHS,
  startDaemon,
  stopDaemon,
} from "../harness.ts";

interface EvalResult {
  id: string;
  pass: boolean;
  notes: string[];
  metrics: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────────
// Fixtures — one representative content sample per mime the table view
// claims to render. Sample sizes are small (under the lift threshold)
// because we're testing the daemon's storage contract, not the
// scrubber's sniff threshold. Each fixture is intentionally tabular
// but synthetic — no real customer data.
// ────────────────────────────────────────────────────────────────────────

interface Fixture {
  id: string;
  mime: string;
  filename: string;
  content: string;
  /** A substring expected back from the /content endpoint round-trip. */
  echo: string;
}

const FIXTURES: Fixture[] = [
  {
    id: "csv-artifact-roundtrip",
    mime: "text/csv",
    filename: "employees.csv",
    content: [
      "id,name,city",
      "1,Alice,Seattle",
      "2,Bob,Austin",
      `3,"Carol Anne","Portland, OR"`,
    ].join("\n"),
    echo: "Carol Anne",
  },
  {
    id: "tsv-artifact-roundtrip",
    mime: "text/tab-separated-values",
    filename: "employees.tsv",
    content: ["id\tname\tcity", "1\tAlice\tSeattle", "2\tBob\tAustin"].join("\n"),
    echo: "Bob\tAustin",
  },
  {
    id: "json-array-roundtrip",
    mime: "application/json",
    filename: "employees.json",
    content: JSON.stringify([
      { id: 1, name: "Alice", city: "Seattle" },
      { id: 2, name: "Bob", city: "Austin" },
    ]),
    echo: `"name":"Alice"`,
  },
  {
    id: "html-table-roundtrip",
    mime: "text/html",
    filename: "employees.html",
    content:
      `<table><thead><tr><th>id</th><th>name</th></tr></thead>` +
      `<tbody><tr><td>1</td><td>Alice</td></tr><tr><td>2</td><td>Bob</td></tr></tbody></table>`,
    echo: "<td>Alice</td>",
  },
  {
    id: "markdown-table-roundtrip",
    mime: "text/markdown",
    filename: "employees.md",
    content: [
      "| id | name | city |",
      "| --- | --- | --- |",
      "| 1 | Alice | Seattle |",
      "| 2 | Bob | Austin |",
    ].join("\n"),
    echo: "| 1 | Alice | Seattle |",
  },
  {
    id: "prose-not-mistagged",
    mime: "text/plain",
    filename: "notes.txt",
    content:
      "Once upon a time, in a kingdom far, far away, there lived a baker. " +
      "She baked, she sang, she danced. Every morning, she rose early.",
    echo: "kingdom far",
  },
];

// ────────────────────────────────────────────────────────────────────────
// Helpers — POST a fixture, fetch back metadata + content, return both
// for the scenario's assertion stage.
// ────────────────────────────────────────────────────────────────────────

interface ArtifactRecord {
  id: string;
  mimeType?: string;
  originalName?: string;
  size?: number;
  contents?: string;
}

async function createArtifact(d: DaemonHandle, fx: Fixture): Promise<string> {
  const res = await fetch(`${d.baseUrl}/api/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: { type: "file", content: fx.content, mimeType: fx.mime, originalName: fx.filename },
      title: fx.id,
      summary: `Eval fixture for ${fx.mime}.`,
      workspaceId: "user",
      lifecycle: { kind: "durable" },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`create-artifact failed: HTTP ${res.status} ${text}`);
  }
  const body = (await res.json()) as { artifact?: { id?: string } };
  const id = body.artifact?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`create-artifact returned no id: ${JSON.stringify(body)}`);
  }
  return id;
}

async function fetchArtifactMeta(d: DaemonHandle, id: string): Promise<ArtifactRecord> {
  const res = await fetch(`${d.baseUrl}/api/artifacts/${encodeURIComponent(id)}`);
  if (!res.ok) {
    throw new Error(`get-artifact failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    artifact?: { id?: string; data?: { mimeType?: string; originalName?: string; size?: number } };
    contents?: string;
  };
  const a = body.artifact;
  if (!a?.id) throw new Error(`get-artifact missing id field`);
  return {
    id: a.id,
    mimeType: a.data?.mimeType,
    originalName: a.data?.originalName,
    size: a.data?.size,
    contents: body.contents,
  };
}

async function fetchArtifactContent(
  d: DaemonHandle,
  id: string,
): Promise<{ status: number; mime: string; body: string }> {
  const res = await fetch(`${d.baseUrl}/api/artifacts/${encodeURIComponent(id)}/content`);
  return {
    status: res.status,
    mime: res.headers.get("content-type") ?? "",
    body: await res.text(),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Per-fixture scenario — every fixture exercises the same 4 assertions:
//
//   1. The artifact is created and assigned a stable id.
//   2. /api/artifacts/<id> returns the mime + originalName we POSTed.
//   3. /api/artifacts/<id>/content returns the bytes verbatim with the
//      same Content-Type. Tools downstream (parseTabular in the page
//      loader, the export route's HTML packaging) depend on the
//      Content-Type round-tripping faithfully.
//   4. A representative byte sequence from the fixture's content
//      survives the round-trip — guards against accidental
//      transformation (line-ending munging, charset re-encoding) at
//      the storage layer.
// ────────────────────────────────────────────────────────────────────────

async function runFixture(d: DaemonHandle, fx: Fixture): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = { mime: fx.mime, filename: fx.filename };

  let createdId: string;
  try {
    createdId = await createArtifact(d, fx);
    notes.push(`created artifact ${createdId}`);
    metrics.artifactId = createdId;
  } catch (err) {
    return {
      id: fx.id,
      pass: false,
      notes: [`create failed: ${err instanceof Error ? err.message : String(err)}`],
      metrics,
    };
  }

  const meta = await fetchArtifactMeta(d, createdId);
  metrics.storedMime = meta.mimeType;
  metrics.storedOriginalName = meta.originalName;

  const content = await fetchArtifactContent(d, createdId);
  metrics.contentStatus = content.status;
  metrics.contentMime = content.mime;

  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [
    {
      name: "stored mime matches POSTed",
      ok: meta.mimeType === fx.mime,
      detail: `${meta.mimeType} == ${fx.mime}`,
    },
    {
      name: "stored originalName matches",
      ok: meta.originalName === fx.filename,
      detail: `${meta.originalName} == ${fx.filename}`,
    },
    {
      name: "content endpoint 200",
      ok: content.status === 200,
      detail: `status ${content.status}`,
    },
    {
      name: "content mime header matches",
      ok: content.mime.split(";")[0]?.trim() === fx.mime,
      detail: `header ${content.mime}`,
    },
    {
      name: "content body contains echo string",
      ok: content.body.includes(fx.echo),
      detail: `expected substring ${JSON.stringify(fx.echo)}`,
    },
  ];

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    notes.push(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  }

  return { id: fx.id, pass: failed.length === 0, notes, metrics };
}

// ────────────────────────────────────────────────────────────────────────
// Entry point — mirrors tool-suite-management.ts shape.
// ────────────────────────────────────────────────────────────────────────

async function main() {
  await ensureCredentialsLoaded();

  const sha = await currentGitSha();
  const startedAt = new Date().toISOString();
  const writeResult = Deno.args.includes("--write-result");
  const jsonOutputArgIndex = Deno.args.indexOf("--json-output");
  const jsonOutputPath = jsonOutputArgIndex >= 0 ? Deno.args[jsonOutputArgIndex + 1] : undefined;
  const onlyArgIndex = Deno.args.indexOf("--only");
  const onlyId = onlyArgIndex >= 0 ? Deno.args[onlyArgIndex + 1] : undefined;
  if (jsonOutputArgIndex >= 0 && !jsonOutputPath) {
    console.error("--json-output requires a path");
    Deno.exit(2);
  }
  console.log(`▶ table-outcomes eval @ ${sha}`);

  const fridayHome = await Deno.makeTempDir({ prefix: "friday-qa-table-outcomes-" });
  const daemon = await startDaemon({ fridayHome, healthTimeoutMs: 90_000 });
  const results: EvalResult[] = [];
  try {
    console.log(`✓ daemon up: ${daemon.baseUrl}`);
    for (const fx of FIXTURES) {
      if (onlyId && fx.id !== onlyId) continue;
      console.log(`\n── ${fx.id} ──`);
      try {
        results.push(await runFixture(daemon, fx));
      } catch (err) {
        results.push({
          id: fx.id,
          pass: false,
          notes: [`scenario threw: ${err instanceof Error ? err.message : String(err)}`],
          metrics: {},
        });
      }
    }
  } finally {
    await stopDaemon(daemon, { keepHome: true });
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n══ table-outcomes summary: ${passed}/${results.length} passed ══`);
  for (const r of results) {
    console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);
    for (const note of r.notes) console.log(`    ${note}`);
  }

  const report = { gitSha: sha, startedAt, passed, failed, results };
  if (writeResult || jsonOutputPath) {
    const outPath = jsonOutputPath ?? join(HARNESS_PATHS.resultsDir, `${sha}-table-outcomes.json`);
    await Deno.mkdir(dirname(outPath), { recursive: true });
    await Deno.writeTextFile(outPath, JSON.stringify(report, null, 2));
    console.log(`\n→ ${outPath}`);
  }

  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}

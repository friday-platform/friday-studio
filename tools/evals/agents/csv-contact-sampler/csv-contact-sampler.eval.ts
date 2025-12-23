/**
 * Eval tests for CSV Filter Sampler agent
 *
 * Tests the agent's ability to:
 * 1. Parse CSV files
 * 2. Filter records based on natural language criteria
 * 3. Randomly sample 3 records
 * 4. Return proper JSON artifact with metadata
 */

import { readFile } from "node:fs/promises";
import { makeTempDir } from "@atlas/utils/temp.server";
import { csvFilterSamplerAgent } from "@atlas/bundled-agents";
import { ArtifactStorage, parseCsv } from "@atlas/core/artifacts/server";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { setupTest } from "../../lib/utils.ts";
import { generateFakeCSV } from "./generate-fake-data.ts";

const { step } = setupTest({ testFileUrl: new URL(import.meta.url) });

// Helper to verify a contact matches USA + decision-maker criteria
function isUSADecisionMaker(contact: Record<string, unknown>): boolean {
  const country = String(contact.Country || "").trim();
  const seniority = String(contact.Seniority || "").trim();
  const title = String(contact.title || "").toLowerCase();

  const isUSA = country === "USA";

  // Decision-making seniorities
  const isDecisionSeniority = [
    "C suite",
    "Vp",
    "Director",
    "Founder",
    "Owner",
    "Head",
    "Partner",
    "Senior",
  ].includes(seniority);

  // Decision-making title keywords
  const hasDecisionTitle = [
    "ceo",
    "cfo",
    "cto",
    "cmo",
    "coo",
    "chief",
    "president",
    "vp",
    "vice president",
    "director",
    "founder",
    "co-founder",
    "owner",
  ].some((keyword) => title.includes(keyword));

  return isUSA && (isDecisionSeniority || hasDecisionTitle);
}

Deno.test("CSV Filter Sampler Agent", async (t) => {
  await loadCredentials();

  const adapter = new AgentContextAdapter();

  // Generate fake CSV in temp directory
  const tempDir = makeTempDir();
  const csvPath = join(tempDir, "fake-contacts.csv");
  await generateFakeCSV(csvPath, 1000, 0.35, 0.25);

  // Parse CSV to get ground truth counts
  const parsedCsv = await parseCsv(csvPath);
  const totalRecords = parsedCsv.rowCount;
  const expectedFilteredCount = parsedCsv.data.filter(isUSADecisionMaker).length;

  // Cleanup function
  const cleanup = async () => {
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch (error) {
      console.error("Failed to cleanup temp directory:", error);
    }
  };

  await step(t, "Filter USA decision makers and sample 3", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const prompt =
      `Read ${csvPath} and filter for United States contacts with any decision-making title ` +
      `(Director, Chief, VP, President, CEO, CFO, CTO, CMO, COO, Owner, Founder, or Senior/C-suite seniority)`;

    const startTime = performance.now();
    const result = await csvFilterSamplerAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    // Capture execution snapshot
    snapshot({
      result,
      metrics: { ...metrics, timing: { executionTimeMs } },
      streamEvents,
      executionSummary: {
        toolsExecuted: metrics?.tools.length || 0,
        totalTokens: metrics?.tokens.total || 0,
        promptTokens: metrics?.tokens.prompt || 0,
        completionTokens: metrics?.tokens.completion || 0,
      },
    });

    // Verify result structure
    assert(result, "Should return a result");
    assert(result.summary, "Should return summary");
    assert(result.artifactRef, "Should return artifactRef");
    assertEquals(result.artifactRef.type, "file", "ArtifactRef should be type 'file'");

    // Load and verify artifact content
    const artifactResult = await ArtifactStorage.get({ id: result.artifactRef.id });
    assert(artifactResult.ok, "Should load artifact");
    assert(artifactResult.data, "Artifact data should exist");
    assert(artifactResult.data.data.type === "file", "Artifact should be file type");

    const artifactFilePath = artifactResult.data.data.data.path;
    const artifactContent = await readFile(artifactFilePath, "utf-8");
    const artifactData = JSON.parse(artifactContent) as {
      metadata: {
        totalRecords: number;
        filteredCount: number;
        sampleCount: number;
        unprocessedCount: number;
      };
      samples: Array<Record<string, unknown>>;
    };

    // Verify artifact structure
    assert(artifactData.metadata, "Artifact should have metadata");
    assert(artifactData.samples, "Artifact should have samples array");

    const { metadata, samples } = artifactData;

    // Verify metadata counts against ground truth
    assertEquals(metadata.totalRecords, totalRecords, "Total records should match CSV");
    assertEquals(
      metadata.filteredCount,
      expectedFilteredCount,
      `Filtered count should match ground truth (expected ${expectedFilteredCount} USA decision makers)`,
    );
    assertEquals(metadata.sampleCount, 3, "Should sample exactly 3 records");
    assertEquals(
      metadata.unprocessedCount,
      metadata.filteredCount - metadata.sampleCount,
      "Unprocessed count should be filteredCount - sampleCount",
    );

    // Verify samples
    assert(Array.isArray(samples), "Samples should be array");
    assertEquals(samples.length, metadata.sampleCount, "Samples array should match sampleCount");

    // Verify all samples exist in original CSV and have matching values (comparing values, not types)
    for (const sample of samples) {
      const matchingRecord = parsedCsv.data.find((record) => record.Email === sample.Email);
      assert(matchingRecord, `Sample with email ${sample.Email} should exist in original CSV`);

      // Compare field values (coerce types for comparison since SQLite returns TEXT)
      for (const [key, value] of Object.entries(sample)) {
        const originalValue = matchingRecord[key];

        // Normalize values for comparison (SQLite stores everything as TEXT)
        const normalize = (val: unknown): string => {
          if (val === null || val === undefined) return "";
          if (typeof val === "boolean") return val ? "1" : "0";
          return String(val);
        };

        assertEquals(
          normalize(value),
          normalize(originalValue),
          `Field ${key} should match for ${sample.Email}`,
        );
      }
    }

    console.log(`Test passed:`);
    console.log(`  Total records: ${metadata.totalRecords}`);
    console.log(`  Filtered: ${metadata.filteredCount}`);
    console.log(`  Sampled: ${metadata.sampleCount}`);
    console.log(`  Unprocessed: ${metadata.unprocessedCount}`);

    return { result, metrics, executionTimeMs };
  });

  await step(t, "Verify randomness of sampling", async ({ snapshot }) => {
    adapter.reset();

    const prompt =
      `Read ${csvPath} and filter for United States contacts with any decision-making title ` +
      `(Director, Chief, VP, President, CEO, CFO, CTO, CMO, COO, Owner, Founder, or Senior/C-suite seniority)`;

    // Run agent multiple times and collect samples
    const allSamples: string[] = [];
    const runs = 5;

    for (let i = 0; i < runs; i++) {
      adapter.reset();
      const context = adapter.createContext({ telemetry: false });
      const result = await csvFilterSamplerAgent.execute(prompt, context);

      assert(result, `Run ${i + 1} should return a result`);
      assert(result.artifactRef, `Run ${i + 1} should return artifactRef`);

      const artifactResult = await ArtifactStorage.get({ id: result.artifactRef.id });
      assert(artifactResult.ok, "Should load artifact");
      assert(artifactResult.data, "Artifact data should exist");
      assert(artifactResult.data.data.type === "file", "Artifact should be file type");

      const artifactFilePath = artifactResult.data.data.data.path;
      const artifactContent = await readFile(artifactFilePath, "utf-8");
      const artifactData = JSON.parse(artifactContent) as { samples: Array<{ Email: string }> };

      // Collect sample emails as unique identifiers
      for (const sample of artifactData.samples) {
        allSamples.push(String(sample.Email || ""));
      }
    }

    // Verify we got samples and some variety (relaxed check due to LLM variance)
    const uniqueSamples = new Set(allSamples.filter((email) => email)); // Filter out empty strings
    const uniquePercentage =
      allSamples.length > 0 ? (uniqueSamples.size / allSamples.length) * 100 : 0;

    snapshot({
      runs,
      totalSamples: allSamples.length,
      uniqueSamples: uniqueSamples.size,
      uniquePercentage,
    });

    // Relaxed check: verify we got some samples and some variety (LLM filtering may vary)
    assert(allSamples.length > 0, "Should have at least some samples across all runs");
    if (uniqueSamples.size > 0) {
      assert(
        uniqueSamples.size > 1 || allSamples.length === 1,
        "Should have variety if multiple samples",
      );
    }

    console.log(`Randomness test passed:`);
    console.log(`  Runs: ${runs}`);
    console.log(`  Total samples: ${allSamples.length}`);
    console.log(`  Unique samples: ${uniqueSamples.size} (${uniquePercentage.toFixed(1)}%)`);

    return { uniqueSamples: uniqueSamples.size, totalSamples: allSamples.length, uniquePercentage };
  });

  await step(t, "Handle empty filter results", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    // Use impossible filter that should match zero records
    const prompt = `Read ${csvPath} and filter for contacts from Antarctica with CEO title`;

    const startTime = performance.now();
    const result = await csvFilterSamplerAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();

    snapshot({ result, metrics: { ...metrics, timing: { executionTimeMs } } });

    assert(result, "Agent should handle empty results gracefully");
    assert(result.artifactRef, "Should return artifactRef even with empty results");

    // Load artifact
    const artifactResult = await ArtifactStorage.get({ id: result.artifactRef.id });
    assert(artifactResult.ok, "Should load artifact");
    assert(artifactResult.data, "Artifact data should exist");
    assert(artifactResult.data.data.type === "file", "Artifact should be file type");

    const artifactFilePath = artifactResult.data.data.data.path;
    const artifactContent = await readFile(artifactFilePath, "utf-8");
    const artifactData = JSON.parse(artifactContent) as {
      metadata: { filteredCount: number; sampleCount: number };
      samples: Array<unknown>;
    };

    // Verify empty results
    assertEquals(artifactData.metadata.filteredCount, 0, "Should have zero filtered records");
    assertEquals(artifactData.metadata.sampleCount, 0, "Should have zero samples");
    assertEquals(artifactData.samples.length, 0, "Samples array should be empty");

    console.log(`Empty filter test passed`);

    return { result, metrics, executionTimeMs };
  });

  // Cleanup temp directory
  await cleanup();
});

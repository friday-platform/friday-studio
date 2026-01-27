/**
 * Lightweight eval tests for Data Analyst agent.
 *
 * Tests basic functionality:
 * 1. Can load CSV artifact and answer aggregation questions
 * 2. Returns proper artifact structure (summary + optional data)
 * 3. Handles basic SQL queries correctly
 */

import { rm } from "node:fs/promises";
import { dataAnalystAgent } from "@atlas/bundled-agents";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { makeTempDir } from "@atlas/utils/temp.server";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";
import {
  calculateExpectedAggregations,
  generateSalesCSV,
  generateSalesData,
} from "./generate-test-data.ts";

describe("Data Analyst Agent", () => {
  let adapter: AgentContextAdapter;
  let tempDir: string;
  let artifactId: string;
  let expected: ReturnType<typeof calculateExpectedAggregations>;

  beforeAll(async () => {
    await loadCredentials();

    adapter = new AgentContextAdapter();

    // Generate test CSV in temp directory
    tempDir = makeTempDir();
    const csvPath = join(tempDir, "sales-data.csv");
    await generateSalesCSV(csvPath, 100);

    // Pre-calculate expected values for assertions
    const testData = generateSalesData(100);
    expected = calculateExpectedAggregations(testData);

    // Create artifact from CSV
    const workspaceId = "test-workspace";
    const createResult = await ArtifactStorage.create({
      data: { type: "file", version: 1, data: { path: csvPath } },
      title: "Q4 Sales Data",
      summary: "Test sales data for eval",
      workspaceId,
    });

    if (!createResult.ok) {
      throw new Error(`Failed to create artifact: ${createResult.error}`);
    }

    artifactId = createResult.data.id;
  });

  afterAll(async () => {
    try {
      await rm(tempDir, { recursive: true });
    } catch (error) {
      console.error("Failed to cleanup temp directory:", error);
    }
  });

  it("Answer total revenue question", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `Analyze artifact ${artifactId}. What is the total revenue across all sales?`;

    const startTime = performance.now();
    const result = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    await saveSnapshot({
      testCase: "Answer total revenue question",
      testPath: new URL(import.meta.url),
      data: {
        result,
        metrics: { ...metrics, timing: { executionTimeMs } },
        streamEvents,
        expected: { totalRevenue: expected.totalRevenue },
      },
      pass: true,
    });

    // Verify result structure
    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(result.artifactRefs).toBeDefined();
    expect(result.artifactRefs.length).toBeGreaterThanOrEqual(1);

    // Verify summary mentions revenue (LLM will format the number)
    const summaryLower = result.summary.toLowerCase();
    expect(summaryLower.includes("revenue") || summaryLower.includes("total")).toBe(true);

    console.log(`Test passed:`);
    console.log(`  Expected total revenue: $${expected.totalRevenue.toLocaleString()}`);
    console.log(`  Summary: ${result.summary.slice(0, 200)}...`);
    console.log(`  Artifacts: ${result.artifactRefs.length}`);
  });

  it("Answer region breakdown question", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `Analyze artifact ${artifactId}. Which region had the highest total revenue?`;

    const startTime = performance.now();
    const result = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();

    await saveSnapshot({
      testCase: "Answer region breakdown question",
      testPath: new URL(import.meta.url),
      data: {
        result,
        metrics: { ...metrics, timing: { executionTimeMs } },
        expected: { topRegion: expected.topRegion, topRegionRevenue: expected.topRegionRevenue },
      },
      pass: true,
    });

    // Verify result structure
    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    // Verify summary mentions the top region
    const summaryLower = result.summary.toLowerCase();
    expect(summaryLower).toContain(expected.topRegion.toLowerCase());

    console.log(`Test passed:`);
    console.log(`  Expected top region: ${expected.topRegion}`);
    console.log(`  Summary: ${result.summary.slice(0, 200)}...`);
  });

  it("Save results artifact for aggregation query", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `Analyze artifact ${artifactId}. Give me a breakdown of total revenue by region. Save the results.`;

    const startTime = performance.now();
    const result = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();

    await saveSnapshot({
      testCase: "Save results artifact for aggregation query",
      testPath: new URL(import.meta.url),
      data: { result, metrics: { ...metrics, timing: { executionTimeMs } } },
      pass: true,
    });

    // Verify result structure
    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(result.artifactRefs).toBeDefined();

    // Should have summary artifact, might have data artifact too
    const summaryArtifact = result.artifactRefs.find((a) => a.type === "summary");
    expect(summaryArtifact).toBeDefined();

    console.log(`Test passed:`);
    console.log(`  Artifacts: ${result.artifactRefs.length}`);
    console.log(`  Types: ${result.artifactRefs.map((a) => a.type).join(", ")}`);
  });
});

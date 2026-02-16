/**
 * Eval tests for Data Analyst agent using daily_flash_20250112.csv
 *
 * Large dataset (~1.84M rows, 362MB) testing real-world ad performance analysis.
 * See: docs/plans/2026-01-03-data-analyst-agent-eval-plan.md
 */

import {
  type DataAnalystResult,
  dataAnalystAgent,
  type QueryExecution,
} from "@atlas/bundled-agents";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { join } from "@std/path";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

/**
 * Unwraps AgentResult, throwing on failure.
 * Simplifies test code by allowing direct access to result fields.
 */
function unwrapResult(
  result: Awaited<ReturnType<typeof dataAnalystAgent.execute>>,
): DataAnalystResult {
  if (!result.ok) {
    throw new Error(`Agent execution failed: ${result.error.reason}`);
  }
  return result.data;
}

// Path to the daily flash CSV (checked into repo under data/)
const evalDir = import.meta.dirname ?? ".";
const CSV_PATH = join(evalDir, "data", "daily_flash_20250112.csv");

// Ground truth values (verified via wc -l and sqlite)
// Note: SQL uses CAST(REVENUE AS REAL) which treats empty strings as 0
const EXPECTED = {
  rowCount: 1_841_034, // wc -l minus header
  uniqueCampaigns: 7_079, // COUNT(DISTINCT CAMPAIGNS)
  totalImpressions: 66_947_718,
  totalRevenue: 4_767_017.13, // SUM(CAST(REVENUE AS REAL))
  totalClicks: 1_021_779, // SUM(CLICKS)
  revenueByAdType: {
    "Sponsored Product": 3_907_864.81,
    "Sponsored Brand": 608_613.71,
    "Sponsored Brand Video": 250_538.61,
  },
  // Time-series: date range is Jan 3-11, 2026 (9 days)
  dateRange: { start: "2026-01-03", end: "2026-01-11", days: 9 },
  // CTR = clicks / impressions
  overallCtr: 1_021_779 / 66_947_718, // ~0.0153 or 1.53%
};

/**
 * Logs executed queries in a readable format
 */
function logQueries(queries: QueryExecution[]): void {
  console.log(`\n--- Executed ${queries.length} queries ---`);
  for (const q of queries) {
    const status = q.success ? "✓" : "✗";
    const rows = q.rowCount !== undefined ? `${q.rowCount} rows` : q.error;
    const duration = q.durationMs.toFixed(0);
    // Truncate long queries for readability
    const sqlPreview = q.sql.length > 100 ? `${q.sql.slice(0, 100)}...` : q.sql;
    console.log(`  ${status} [${q.tool}] (${duration}ms, ${rows}): ${sqlPreview}`);
  }
  console.log("---\n");
}

/**
 * Check if summary contains a number within tolerance of expected value.
 * Handles comma-formatted numbers and percentage tolerance.
 */
function summaryContainsValue(summary: string, expected: number, tolerancePercent = 0.01): boolean {
  const numbers = summary.match(/[\d,]+\.?\d*/g) ?? [];
  return numbers.some((n) => {
    const parsed = parseFloat(n.replace(/,/g, ""));
    if (Number.isNaN(parsed)) return false;
    const tolerance = expected * tolerancePercent;
    return Math.abs(parsed - expected) <= tolerance;
  });
}

describe("Data Analyst - Daily Flash Dataset", () => {
  let adapter: AgentContextAdapter;
  let artifactId: string;

  beforeAll(async () => {
    await loadCredentials();

    adapter = new AgentContextAdapter();

    // Create artifact from CSV (one-time setup)
    const workspaceId = "test-workspace";
    const createResult = await ArtifactStorage.create({
      data: { type: "file", version: 1, data: { path: CSV_PATH } },
      title: "Daily Flash Report 2025-01-12",
      summary: "Ad performance data - 1.84M rows",
      workspaceId,
    });

    if (!createResult.ok) {
      throw new Error(`Failed to create artifact: ${createResult.error}`);
    }

    artifactId = createResult.data.id;
    console.log(`Created artifact ${artifactId} for ${CSV_PATH}`);
  });

  // === Simple Aggregations ===

  it("Simple: Row count", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `Analyze artifact ${artifactId}. How many rows are in the dataset?`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Simple: Row count",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
        expected: { rowCount: EXPECTED.rowCount },
      },
      pass: true,
    });

    const foundExpected = summaryContainsValue(result.summary, EXPECTED.rowCount, 0.001);

    console.log(`Expected: ${EXPECTED.rowCount.toLocaleString()} rows`);
    console.log(`Summary: ${result.summary.slice(0, 300)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(foundExpected).toBe(true);
  });

  it("Simple: Total revenue", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `Analyze artifact ${artifactId}. What was the total revenue across all campaigns?`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Simple: Total revenue",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
        expected: { totalRevenue: EXPECTED.totalRevenue },
      },
      pass: true,
    });

    // Check for revenue value (allow 1% tolerance for rounding)
    const foundExpected = summaryContainsValue(result.summary, EXPECTED.totalRevenue, 0.01);

    console.log(`Expected: $${EXPECTED.totalRevenue.toLocaleString()}`);
    console.log(`Summary: ${result.summary.slice(0, 300)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(foundExpected).toBe(true);
  });

  it("Simple: Unique campaigns count", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `Analyze artifact ${artifactId}. How many unique campaigns are in the dataset?`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Simple: Unique campaigns count",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
        expected: { uniqueCampaigns: EXPECTED.uniqueCampaigns },
      },
      pass: true,
    });

    const foundExpected = summaryContainsValue(result.summary, EXPECTED.uniqueCampaigns, 0.01);

    console.log(`Expected: ${EXPECTED.uniqueCampaigns.toLocaleString()} campaigns`);
    console.log(`Summary: ${result.summary.slice(0, 300)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(foundExpected).toBe(true);
  });

  // === Filtering + Grouping ===

  it("Grouping: Revenue by ad type", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `Analyze artifact ${artifactId}. What was total revenue by ad type?`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Grouping: Revenue by ad type",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
        expected: { revenueByAdType: EXPECTED.revenueByAdType },
      },
      pass: true,
    });

    // Check that summary mentions the top ad type
    const summaryLower = result.summary.toLowerCase();
    expect(summaryLower).toContain("sponsored product");

    // Check that Sponsored Product revenue is approximately correct
    const foundSPRevenue = summaryContainsValue(
      result.summary,
      EXPECTED.revenueByAdType["Sponsored Product"],
      0.02,
    );

    console.log(
      `Expected top: Sponsored Product @ $${EXPECTED.revenueByAdType["Sponsored Product"].toLocaleString()}`,
    );
    console.log(`Summary: ${result.summary.slice(0, 400)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(foundSPRevenue).toBe(true);
  });

  // === Time-Series Analysis ===

  it("Time-series: Daily revenue trend", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `Analyze artifact ${artifactId}. How did daily revenue trend over the date range? Show me revenue by day.`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Time-series: Daily revenue trend",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
        expected: { dateRange: EXPECTED.dateRange },
      },
      pass: true,
    });

    // Should mention the date column and show a trend
    const summaryLower = result.summary.toLowerCase();
    const hasDailyBreakdown =
      summaryLower.includes("day") ||
      summaryLower.includes("daily") ||
      summaryLower.includes("date") ||
      summaryLower.includes("jan");

    console.log(`Summary: ${result.summary.slice(0, 500)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(hasDailyBreakdown).toBe(true);
  });

  // === Top-N Queries ===

  it("Top-N: Top 10 manufacturers by revenue", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `Analyze artifact ${artifactId}. What are the top 10 manufacturers by revenue?`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Top-N: Top 10 manufacturers by revenue",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
      },
      pass: true,
    });

    // Check that queries used ORDER BY and LIMIT
    const hasTopNPattern = result.queries.some(
      (q) =>
        q.sql.toUpperCase().includes("ORDER BY") &&
        (q.sql.toUpperCase().includes("LIMIT") || q.sql.toUpperCase().includes("DESC")),
    );

    console.log(`Summary: ${result.summary.slice(0, 500)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(hasTopNPattern).toBe(true);
  });

  // === Calculated Metrics ===

  it("Calculated: Click-through rate (CTR)", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `Analyze artifact ${artifactId}. What's the overall click-through rate (CTR)? CTR = clicks / impressions.`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Calculated: Click-through rate (CTR)",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
        expected: { overallCtr: EXPECTED.overallCtr },
      },
      pass: true,
    });

    // CTR should be ~1.5% (0.0153)
    const summaryLower = result.summary.toLowerCase();
    const mentionsCtr = summaryLower.includes("ctr") || summaryLower.includes("click");
    // Check for percentage around 1.5%
    const hasReasonableCtr =
      summaryContainsValue(result.summary, 1.5, 0.5) || // 1.5% ± 0.5
      summaryContainsValue(result.summary, 0.015, 0.005); // 0.015 ± 0.005

    console.log(`Expected CTR: ~${(EXPECTED.overallCtr * 100).toFixed(2)}%`);
    console.log(`Summary: ${result.summary.slice(0, 400)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(mentionsCtr).toBe(true);
    expect(hasReasonableCtr).toBe(true);
  });

  // === Multi-Dimensional Analysis ===

  it("Multi-dim: Revenue by ad type AND page type", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `Analyze artifact ${artifactId}. Break down revenue by both ad type and page type.`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Multi-dim: Revenue by ad type AND page type",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
      },
      pass: true,
    });

    // Check that queries used multiple GROUP BY columns
    const hasMultiGroupBy = result.queries.some((q) => {
      const upper = q.sql.toUpperCase();
      // Look for GROUP BY with comma (multiple columns)
      const groupByMatch = upper.match(/GROUP BY\s+([^;]+)/);
      return groupByMatch?.[1]?.includes(",") ?? false;
    });

    // Summary should mention both dimensions
    const summaryLower = result.summary.toLowerCase();
    const mentionsAdType = summaryLower.includes("ad type") || summaryLower.includes("sponsored");
    const mentionsPageType =
      summaryLower.includes("page type") ||
      summaryLower.includes("search") ||
      summaryLower.includes("browse");

    console.log(`Summary: ${result.summary.slice(0, 600)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(hasMultiGroupBy).toBe(true);
    expect(mentionsAdType).toBe(true);
    expect(mentionsPageType).toBe(true);
  });

  // === HARD MODE ===

  it("Hard: Pareto analysis - what % of campaigns make 80% of revenue", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    // This requires: window functions OR cumulative calculation, understanding Pareto principle
    // Ground truth: ~14% of campaigns generate 80% of revenue (1007 of 7079)
    const prompt = `Analyze artifact ${artifactId}. What percentage of campaigns generate 80% of total revenue? This is a Pareto/concentration analysis.`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Hard: Pareto analysis - what % of campaigns make 80% of revenue",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
        expected: { paretoPercent: 14.23 },
      },
      pass: true,
    });

    // Should mention a percentage roughly around 14-20%
    const summaryLower = result.summary.toLowerCase();
    const mentionsConcentration =
      summaryLower.includes("pareto") ||
      summaryLower.includes("concentration") ||
      summaryLower.includes("80%") ||
      summaryLower.includes("percent");

    console.log(`Expected: ~14% of campaigns generate 80% of revenue`);
    console.log(`Summary: ${result.summary.slice(0, 600)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(mentionsConcentration).toBe(true);
  });

  it("Hard: Cross-category advertisers - parent companies in both Dog AND Cat", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    // Requires: GROUP BY with HAVING COUNT(DISTINCT category) = 2
    // Ground truth: NESTLE PURINA top at $825K, followed by HILL'S PET NUTRITION
    const prompt = `Analyze artifact ${artifactId}. Which parent companies advertise in BOTH the Dog AND Cat categories (CATEGORY_LEVEL1)? Rank them by their combined revenue across both categories.`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Hard: Cross-category advertisers - parent companies in both Dog AND Cat",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
        expected: { topCrossCategory: "NESTLE PURINA", revenue: 825305.3 },
      },
      pass: true,
    });

    // Should use HAVING with COUNT(DISTINCT)
    const hasHavingDistinct = result.queries.some((q) => {
      const upper = q.sql.toUpperCase();
      return upper.includes("HAVING") && upper.includes("COUNT") && upper.includes("DISTINCT");
    });

    // Should mention Nestle Purina as top
    const summaryLower = result.summary.toLowerCase();
    const mentionsNestle = summaryLower.includes("nestle") || summaryLower.includes("purina");

    console.log(`Expected top: NESTLE PURINA @ $825,305`);
    console.log(`Summary: ${result.summary.slice(0, 600)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(hasHavingDistinct).toBe(true);
    expect(mentionsNestle).toBe(true);
  });

  it("Hard: Market share within subcategory - Vitamins & Supplements leader", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    // Requires: Filter to subcategory, calculate percentage of total within that filter
    const prompt = `Analyze artifact ${artifactId}. In the "Vitamins & Supplements" subcategory (CATEGORY_LEVEL3), which manufacturer has the highest market share by revenue? What percentage of that subcategory's revenue do they capture?`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Hard: Market share within subcategory - Vitamins & Supplements leader",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
      },
      pass: true,
    });

    // Should filter by Vitamins & Supplements
    const hasSubcategoryFilter = result.queries.some(
      (q) =>
        q.sql.toLowerCase().includes("vitamins") || q.sql.toLowerCase().includes("supplements"),
    );

    // Should calculate a percentage/share
    const summaryLower = result.summary.toLowerCase();
    const mentionsShare =
      summaryLower.includes("share") ||
      summaryLower.includes("percent") ||
      summaryLower.includes("%");

    console.log(`Summary: ${result.summary.slice(0, 600)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(hasSubcategoryFilter).toBe(true);
    expect(mentionsShare).toBe(true);
  });

  it("Hard: Wasted impressions - rows with views but no revenue by ad type", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    // Requires: CASE expressions, null/empty handling, percentage calculation
    const prompt = `Analyze artifact ${artifactId}. For each ad type, what percentage of rows have impressions > 0 but revenue = 0 or missing? Call this the "wasted impression" rate. Which ad type wastes the most impressions?`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Hard: Wasted impressions - rows with views but no revenue by ad type",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
      },
      pass: true,
    });

    // Should use CASE or conditional logic
    const hasConditionalLogic = result.queries.some((q) => {
      const upper = q.sql.toUpperCase();
      return (
        upper.includes("CASE") ||
        (upper.includes("WHERE") &&
          (upper.includes("= 0") || upper.includes("IS NULL") || upper.includes("= ''")))
      );
    });

    // Should mention percentages for each ad type
    const summaryLower = result.summary.toLowerCase();
    const mentionsWaste =
      summaryLower.includes("wasted") ||
      summaryLower.includes("no revenue") ||
      summaryLower.includes("zero revenue") ||
      summaryLower.includes("%");

    console.log(`Summary: ${result.summary.slice(0, 600)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(hasConditionalLogic).toBe(true);
    expect(mentionsWaste).toBe(true);
  });

  it("Hard: Revenue consistency - campaigns active all 9 days with lowest variance", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    // Requires: GROUP BY with HAVING COUNT(DISTINCT date) = 9, then variance/stddev calculation
    // SQLite has no built-in STDDEV so agent needs to compute manually or use proxy (min/max range)
    // Ground truth: 3,804 campaigns active all 9 days
    const prompt = `Analyze artifact ${artifactId}. Find campaigns that were active (had revenue) on ALL 9 days in the dataset. Among those, which campaigns had the most CONSISTENT daily revenue - meaning lowest variance or standard deviation in their day-to-day revenue? Show me the top 5 most consistent campaigns that also had meaningful total revenue (>$1000).`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Hard: Revenue consistency - campaigns active all 9 days with lowest variance",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
        expected: { campaignsAllDays: 3804 },
      },
      pass: true,
    });

    // Should use HAVING with COUNT(DISTINCT date)
    const hasDateFiltering = result.queries.some((q) => {
      const upper = q.sql.toUpperCase();
      return (
        (upper.includes("HAVING") && upper.includes("COUNT") && upper.includes("9")) ||
        (upper.includes("HAVING") && upper.includes("= 9"))
      );
    });

    // Should attempt some variance/consistency calculation
    const summaryLower = result.summary.toLowerCase();
    const mentionsConsistency =
      summaryLower.includes("consistent") ||
      summaryLower.includes("variance") ||
      summaryLower.includes("deviation") ||
      summaryLower.includes("stable") ||
      summaryLower.includes("steady");

    console.log(`Expected: 3,804 campaigns active all 9 days`);
    console.log(`Summary: ${result.summary.slice(0, 700)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(hasDateFiltering).toBe(true);
    expect(mentionsConsistency).toBe(true);
  });

  it("Hard: Revenue vs impression rank mismatch - who's undermonetizing?", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    // Requires: Two separate rankings, comparison, business interpretation
    // This is genuinely hard - needs to rank by two metrics and find discrepancies
    const prompt = `Analyze artifact ${artifactId}. Find manufacturers where their revenue rank is much worse than their impression rank. For example, a manufacturer ranked #5 by impressions but #50 by revenue is undermonetizing. Which manufacturers have the biggest gap between impression rank and revenue rank?`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Hard: Revenue vs impression rank mismatch - who's undermonetizing?",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
      },
      pass: true,
    });

    // This is hard - just check that multiple queries were run and ranking was attempted
    const hasRankingLogic = result.queries.some((q) => {
      const upper = q.sql.toUpperCase();
      return upper.includes("ORDER BY") || upper.includes("RANK") || upper.includes("ROW_NUMBER");
    });

    // Should identify specific manufacturers
    const summaryLower = result.summary.toLowerCase();
    const mentionsManufacturers =
      result.queries.length >= 2 || // At least tried multiple approaches
      summaryLower.includes("manufacturer") ||
      summaryLower.includes("rank");

    console.log(`Summary: ${result.summary.slice(0, 800)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(hasRankingLogic).toBe(true);
    expect(mentionsManufacturers).toBe(true);
  });

  // === Filtering ===

  it("Filtering: Revenue for Sponsored Products only", async () => {
    adapter.reset();
    adapter.enableTelemetry();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `Analyze artifact ${artifactId}. What's the total revenue for Sponsored Products only?`;

    const startTime = performance.now();
    const rawResult = await dataAnalystAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;
    const result = unwrapResult(rawResult);

    const metrics = adapter.getMetrics();

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();

    await saveSnapshot({
      testCase: "Filtering: Revenue for Sponsored Products only",
      testPath: new URL(import.meta.url),
      data: {
        summary: result.summary,
        queries: result.queries,
        metrics: { ...metrics, timing: { executionTimeMs } },
        expected: { sponsoredProductRevenue: EXPECTED.revenueByAdType["Sponsored Product"] },
      },
      pass: true,
    });

    // Should filter with WHERE clause
    const hasWhereFilter = result.queries.some(
      (q) =>
        q.sql.toUpperCase().includes("WHERE") && q.sql.toLowerCase().includes("sponsored product"),
    );

    // Check revenue value
    const foundExpected = summaryContainsValue(
      result.summary,
      EXPECTED.revenueByAdType["Sponsored Product"],
      0.02,
    );

    console.log(`Expected: $${EXPECTED.revenueByAdType["Sponsored Product"].toLocaleString()}`);
    console.log(`Summary: ${result.summary.slice(0, 400)}...`);
    console.log(`Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);
    logQueries(result.queries);

    expect(hasWhereFilter).toBe(true);
    expect(foundExpected).toBe(true);
  });
});

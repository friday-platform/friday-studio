/**
 * Data Analyst Agent Eval
 *
 * Uses a 10K row ad performance dataset (ad_data_anonymized.csv) converted to
 * a SQLite database artifact. Tests the full spectrum: simple aggregations,
 * grouping, filtering, time-series, top-N, calculated metrics,
 * multi-dimensional analysis, conditional logic, and error handling.
 *
 * Ground truth values computed independently via sqlite3 CLI.
 */

import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext } from "@atlas/agent-sdk";
import {
  type DataAnalystResult,
  dataAnalystAgent,
  type QueryExecution,
} from "@atlas/bundled-agents";
import { convertCsvToSqlite } from "@atlas/core/artifacts/converters";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { assertEquals } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

await loadCredentials();
const adapter = new AgentContextAdapter();

// Ground truth (verified via sqlite3 CLI against ad_data_anonymized.csv)
const EXPECTED = {
  rowCount: 10_000,
  totalRevenue: 34_668.02,
  uniqueCampaigns: 3_554,
  ctrPercent: 2.04, // 11250 clicks / 550502 impressions ≈ 2.04%
  revenueByAdType: {
    "Sponsored Product": 27_827.26,
    "Sponsored Brand": 4_724.97,
    "Sponsored Brand Video": 2_115.79,
  },
  topManufacturer: "Starlight Co",
  topCrossCategoryParent: "Evergreen Brands",
};

/** Checks if summary contains a number within tolerance of expected value. */
function summaryContainsValue(summary: string, expected: number, tolerancePercent = 0.01): boolean {
  const numbers = summary.match(/[\d,]+\.?\d*/g) ?? [];
  return numbers.some((n) => {
    const parsed = parseFloat(n.replace(/,/g, ""));
    if (Number.isNaN(parsed)) return false;
    const tolerance = expected * tolerancePercent;
    return Math.abs(parsed - expected) <= tolerance;
  });
}

/** Runs the data-analyst agent and unwraps the result. */
async function executeAgent(prompt: string, context: AgentContext): Promise<DataAnalystResult> {
  const raw = await dataAnalystAgent.execute(prompt, context);
  if (!raw.ok) {
    return { summary: `Error: ${raw.error.reason}`, queries: [] };
  }
  return raw.data;
}

// --- Setup: convert CSV to database artifact (top-level await) ---

const evalDir = import.meta.dirname ?? ".";
const csvPath = join(evalDir, "ad_data_anonymized.csv");

const tmpDir = join(tmpdir(), `data-analyst-eval-${Date.now()}`);
await mkdir(tmpDir, { recursive: true });
const dbPath = join(tmpDir, "ad_data.db");

const { schema } = await convertCsvToSqlite(csvPath, dbPath, "ad_data");

const createResult = await ArtifactStorage.create({
  data: {
    type: "database",
    version: 1,
    data: { path: dbPath, sourceFileName: "ad_data_anonymized.csv", schema },
  },
  title: "Ad Performance Data",
  summary: `${schema.rowCount.toLocaleString()} rows, ${schema.columns.length} columns`,
  workspaceId: "eval-workspace",
});

if (!createResult.ok) throw new Error(`Failed to create artifact: ${createResult.error}`);
const artifactId = createResult.data.id;

// --- Test cases ---

interface DataAnalystCase extends Omit<BaseEvalCase, "input"> {
  /** Template that receives the setup artifact ID to produce the input string. */
  inputTemplate: (artifactId: string) => string;
  assert: (result: DataAnalystResult) => void;
  score: (result: DataAnalystResult) => ReturnType<typeof createScore>[];
  metadata?: Record<string, unknown>;
}

const cases: DataAnalystCase[] = [
  // === Simple aggregations ===
  {
    id: "row-count",
    name: "simple - row count",
    inputTemplate: (id) => `Analyze artifact ${id}. How many rows are in the dataset?`,
    assert: (r) => {
      assertEquals(
        summaryContainsValue(r.summary, EXPECTED.rowCount, 0.001),
        true,
        `Expected ~${EXPECTED.rowCount.toLocaleString()} rows, got: ${r.summary.slice(0, 300)}`,
      );
    },
    score: (r) => [
      createScore("accuracy", summaryContainsValue(r.summary, EXPECTED.rowCount, 0.001) ? 1 : 0),
    ],
    metadata: { expected: EXPECTED.rowCount },
  },
  {
    id: "total-revenue",
    name: "simple - total revenue",
    inputTemplate: (id) => `Analyze artifact ${id}. What was the total revenue across all rows?`,
    assert: (r) => {
      assertEquals(
        summaryContainsValue(r.summary, EXPECTED.totalRevenue, 0.01),
        true,
        `Expected ~$${EXPECTED.totalRevenue.toLocaleString()}, got: ${r.summary.slice(0, 300)}`,
      );
    },
    score: (r) => [
      createScore("accuracy", summaryContainsValue(r.summary, EXPECTED.totalRevenue, 0.01) ? 1 : 0),
    ],
    metadata: { expected: EXPECTED.totalRevenue },
  },
  {
    id: "unique-campaigns",
    name: "simple - unique campaigns",
    inputTemplate: (id) => `Analyze artifact ${id}. How many unique campaigns are in the dataset?`,
    assert: (r) => {
      assertEquals(
        summaryContainsValue(r.summary, EXPECTED.uniqueCampaigns, 0.01),
        true,
        `Expected ~${EXPECTED.uniqueCampaigns.toLocaleString()} campaigns, got: ${r.summary.slice(0, 300)}`,
      );
    },
    score: (r) => [
      createScore(
        "accuracy",
        summaryContainsValue(r.summary, EXPECTED.uniqueCampaigns, 0.01) ? 1 : 0,
      ),
    ],
    metadata: { expected: EXPECTED.uniqueCampaigns },
  },

  // === Filtering + Grouping ===
  {
    id: "revenue-by-ad-type",
    name: "grouping - revenue by ad type",
    inputTemplate: (id) => `Analyze artifact ${id}. What was total revenue by ad type?`,
    assert: (r) => {
      const lower = r.summary.toLowerCase();
      assertEquals(
        lower.includes("sponsored product"),
        true,
        "Expected mention of Sponsored Product",
      );
      assertEquals(
        summaryContainsValue(r.summary, EXPECTED.revenueByAdType["Sponsored Product"], 0.02),
        true,
        `Expected SP revenue ~$${EXPECTED.revenueByAdType["Sponsored Product"].toLocaleString()}`,
      );
    },
    score: (r) => {
      const lower = r.summary.toLowerCase();
      return [
        createScore("mentions-top-type", lower.includes("sponsored product") ? 1 : 0),
        createScore(
          "sp-revenue-accuracy",
          summaryContainsValue(r.summary, EXPECTED.revenueByAdType["Sponsored Product"], 0.02)
            ? 1
            : 0,
        ),
      ];
    },
    metadata: { expected: EXPECTED.revenueByAdType },
  },
  {
    id: "sp-revenue-filter",
    name: "filtering - sponsored products revenue",
    inputTemplate: (id) =>
      `Analyze artifact ${id}. What's the total revenue for Sponsored Products only?`,
    assert: (r) => {
      const hasWhereFilter = r.queries.some(
        (q: QueryExecution) =>
          q.sql.toUpperCase().includes("WHERE") &&
          q.sql.toLowerCase().includes("sponsored product"),
      );
      assertEquals(hasWhereFilter, true, "Expected WHERE filter on sponsored product");
      assertEquals(
        summaryContainsValue(r.summary, EXPECTED.revenueByAdType["Sponsored Product"], 0.02),
        true,
        `Expected SP revenue ~$${EXPECTED.revenueByAdType["Sponsored Product"].toLocaleString()}`,
      );
    },
    score: (r) => [
      createScore(
        "accuracy",
        summaryContainsValue(r.summary, EXPECTED.revenueByAdType["Sponsored Product"], 0.02)
          ? 1
          : 0,
      ),
    ],
    metadata: { expected: EXPECTED.revenueByAdType["Sponsored Product"] },
  },

  // === Time-series ===
  {
    id: "daily-revenue-trend",
    name: "time-series - daily revenue trend",
    inputTemplate: (id) =>
      `Analyze artifact ${id}. How did daily revenue trend over the date range? Show me revenue by day.`,
    assert: (r) => {
      // Must GROUP BY a date column
      const hasDateGroupBy = r.queries.some((q: QueryExecution) => {
        const upper = q.sql.toUpperCase();
        return upper.includes("GROUP BY") && upper.includes("DT_AGG");
      });
      assertEquals(hasDateGroupBy, true, "Expected GROUP BY on DT_AGG date column");
      // Summary should show multiple date values
      const dateMatches = r.summary.match(/2026-01-\d{2}/g) ?? [];
      assertEquals(dateMatches.length >= 2, true, "Expected multiple dates in summary");
    },
    score: (r) => {
      const dateMatches = r.summary.match(/2026-01-\d{2}/g) ?? [];
      return [createScore("daily-breakdown", Math.min(dateMatches.length / 5, 1))];
    },
  },

  // === Top-N ===
  {
    id: "top-manufacturers",
    name: "top-N - top 10 manufacturers by revenue",
    inputTemplate: (id) => `Analyze artifact ${id}. What are the top 10 manufacturers by revenue?`,
    assert: (r) => {
      const hasTopNPattern = r.queries.some(
        (q: QueryExecution) =>
          q.sql.toUpperCase().includes("ORDER BY") &&
          (q.sql.toUpperCase().includes("LIMIT") || q.sql.toUpperCase().includes("DESC")),
      );
      assertEquals(hasTopNPattern, true, "Expected ORDER BY + LIMIT/DESC pattern");
      assertEquals(
        r.summary.toLowerCase().includes("starlight"),
        true,
        `Expected top manufacturer ${EXPECTED.topManufacturer}, got: ${r.summary.slice(0, 300)}`,
      );
    },
    score: (r) => [
      createScore("top-manufacturer", r.summary.toLowerCase().includes("starlight") ? 1 : 0),
    ],
  },

  // === Calculated metrics ===
  {
    id: "ctr",
    name: "calculated - click-through rate",
    inputTemplate: (id) =>
      `Analyze artifact ${id}. What's the overall click-through rate (CTR)? CTR = clicks / impressions.`,
    assert: (r) => {
      const lower = r.summary.toLowerCase();
      assertEquals(
        lower.includes("ctr") || lower.includes("click-through"),
        true,
        "Expected CTR mention in summary",
      );
      // ~2.04% as percentage or ~0.0204 as decimal
      const reasonable =
        summaryContainsValue(r.summary, EXPECTED.ctrPercent, 0.15) ||
        summaryContainsValue(r.summary, EXPECTED.ctrPercent / 100, 0.15);
      assertEquals(
        reasonable,
        true,
        `Expected CTR ~${EXPECTED.ctrPercent}%, got: ${r.summary.slice(0, 400)}`,
      );
    },
    score: (r) => {
      const lower = r.summary.toLowerCase();
      const mentionsCtr = lower.includes("ctr") || lower.includes("click-through");
      const reasonable =
        summaryContainsValue(r.summary, EXPECTED.ctrPercent, 0.15) ||
        summaryContainsValue(r.summary, EXPECTED.ctrPercent / 100, 0.15);
      return [
        createScore("mentions-ctr", mentionsCtr ? 1 : 0),
        createScore("ctr-accuracy", reasonable ? 1 : 0),
      ];
    },
  },

  // === Multi-dimensional ===
  {
    id: "multi-dim-revenue",
    name: "multi-dim - revenue by ad type AND page type",
    inputTemplate: (id) =>
      `Analyze artifact ${id}. Break down revenue by both ad type and page type.`,
    assert: (r) => {
      const hasMultiGroupBy = r.queries.some((q: QueryExecution) => {
        const upper = q.sql.toUpperCase();
        const groupByMatch = upper.match(/GROUP BY\s+([^;]+)/);
        return groupByMatch?.[1]?.includes(",") ?? false;
      });
      assertEquals(hasMultiGroupBy, true, "Expected multi-column GROUP BY");
      const lower = r.summary.toLowerCase();
      assertEquals(
        lower.includes("sponsored") || lower.includes("ad type"),
        true,
        "Expected mention of ad type",
      );
      assertEquals(
        lower.includes("search") || lower.includes("browse") || lower.includes("page type"),
        true,
        "Expected mention of page type",
      );
    },
    score: (r) => {
      const lower = r.summary.toLowerCase();
      return [
        createScore(
          "mentions-ad-type",
          lower.includes("ad type") || lower.includes("sponsored") ? 1 : 0,
        ),
        createScore(
          "mentions-page-type",
          lower.includes("page type") || lower.includes("search") || lower.includes("browse")
            ? 1
            : 0,
        ),
      ];
    },
  },

  // === Hard mode ===
  {
    id: "wasted-impressions",
    name: "hard - wasted impressions",
    inputTemplate: (id) =>
      `Analyze artifact ${id}. For each ad type, what percentage of rows have impressions > 0 but revenue = 0 or missing? Call this the "wasted impression" rate. Which ad type wastes the most impressions?`,
    assert: (r) => {
      const hasConditionalLogic = r.queries.some((q: QueryExecution) => {
        const upper = q.sql.toUpperCase();
        return (
          upper.includes("CASE") ||
          (upper.includes("WHERE") &&
            (upper.includes("= 0") || upper.includes("IS NULL") || upper.includes("= ''")))
        );
      });
      assertEquals(hasConditionalLogic, true, "Expected CASE or conditional logic");
      const lower = r.summary.toLowerCase();
      // Must mention the concept AND reference ad types
      const mentionsWaste =
        lower.includes("wasted") || lower.includes("no revenue") || lower.includes("zero revenue");
      const mentionsAdTypes = lower.includes("sponsored");
      assertEquals(mentionsWaste, true, "Expected wasted impression analysis");
      assertEquals(mentionsAdTypes, true, "Expected breakdown by ad type");
    },
    score: (r) => {
      const lower = r.summary.toLowerCase();
      const mentionsWaste =
        lower.includes("wasted") || lower.includes("no revenue") || lower.includes("zero revenue");
      const mentionsAdTypes = lower.includes("sponsored");
      return [
        createScore("wasted-analysis", mentionsWaste ? 1 : 0),
        createScore("by-ad-type", mentionsAdTypes ? 1 : 0),
      ];
    },
  },
  {
    id: "cross-category",
    name: "hard - cross-category parent companies",
    inputTemplate: (id) =>
      `Analyze artifact ${id}. Which parent companies advertise across the most CATEGORY_LEVEL1 categories? Show me the top 5 by number of distinct categories, along with their total revenue.`,
    assert: (r) => {
      assertEquals(
        r.summary.toLowerCase().includes("evergreen"),
        true,
        `Expected ${EXPECTED.topCrossCategoryParent} as top cross-category, got: ${r.summary.slice(0, 300)}`,
      );
    },
    score: (r) => [
      createScore("evergreen-identified", r.summary.toLowerCase().includes("evergreen") ? 1 : 0),
    ],
  },

  // === Error handling ===
  {
    id: "error-handling",
    name: "error - invalid artifact ID",
    inputTemplate: () => `Analyze 00000000-0000-0000-0000-000000000000. What is the total revenue?`,
    assert: (r) => {
      assertEquals(r.summary.startsWith("Error:"), true, "Expected error for invalid artifact ID");
    },
    score: (r) => [createScore("error-handling", r.summary.startsWith("Error:") ? 1 : 0)],
    metadata: { shouldFail: true },
  },
];

export const evals: EvalRegistration[] = cases.map((c) =>
  defineEval({
    name: `data-analyst/${c.id}`,
    adapter,
    config: {
      input: c.inputTemplate(artifactId),
      run: (input, ctx) => executeAgent(input, ctx),
      assert: c.assert,
      score: c.score,
      metadata: { case: c.id, ...c.metadata },
    },
  }),
);

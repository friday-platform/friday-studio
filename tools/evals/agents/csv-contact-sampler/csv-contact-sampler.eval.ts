/**
 * Eval tests for CSV Filter Sampler agent.
 *
 * Tests the agent's ability to:
 * 1. Read CSV artifacts
 * 2. Filter records based on natural language criteria
 * 3. Randomly sample 3 records
 * 4. Return proper JSON artifact with metadata
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { csvFilterSamplerAgent } from "@atlas/bundled-agents";
import type { CsvCell } from "@atlas/core/artifacts/server";
import { ArtifactStorage, parseCsvContent } from "@atlas/core/artifacts/server";
import { makeTempDir } from "@atlas/utils/temp.server";
import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { generateFakeCSV } from "./generate-fake-data.ts";

await loadCredentials();

const adapter = new AgentContextAdapter();

const ArtifactOutputSchema = z.object({
  metadata: z.object({
    totalRecords: z.number(),
    filteredCount: z.number(),
    sampleCount: z.number(),
    unprocessedCount: z.number(),
  }),
  samples: z.array(z.record(z.string(), z.unknown())),
});

/** Checks whether a contact matches USA + decision-maker criteria. */
function isUSADecisionMaker(contact: Record<string, unknown>): boolean {
  const country = String(contact.Country || "").trim();
  const seniority = String(contact.Seniority || "").trim();
  const title = String(contact.title || "").toLowerCase();

  const isUSA = country === "USA";

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

// --- Setup: generate fake CSV and create artifact (top-level await) ---

const tempDir = makeTempDir();
const csvPath = join(tempDir, "fake-contacts.csv");
await generateFakeCSV(csvPath, 1000, 0.35, 0.25);

const workspaceId = "test-workspace";
const createResult = await ArtifactStorage.create({
  data: { type: "file", version: 1, data: { path: csvPath } },
  title: "fake-contacts.csv",
  summary: "Test CSV file for eval",
  workspaceId,
});

if (!createResult.ok) {
  throw new Error(`Failed to create artifact: ${createResult.error}`);
}

const artifactId = createResult.data.id;

// Read artifact content and parse CSV for ground truth counts
const contentsResult = await ArtifactStorage.readFileContents({ id: artifactId });
if (!contentsResult.ok) {
  throw new Error(`Failed to read artifact: ${contentsResult.error}`);
}
const parsedCsv = parseCsvContent(contentsResult.data, artifactId);
const totalRecords = parsedCsv.rowCount;
const expectedFilteredCount = parsedCsv.data.filter(isUSADecisionMaker).length;

const filterPrompt =
  `Read artifact ${artifactId} and filter for United States contacts with any decision-making title ` +
  `(Director, Chief, VP, President, CEO, CFO, CTO, CMO, COO, Owner, Founder, or Senior/C-suite seniority)`;

// --- Registrations ---

export const evals: EvalRegistration[] = [
  defineEval({
    name: "csv-contact-sampler/filter-and-sample",
    adapter,
    config: {
      input: filterPrompt,
      run: (input, context) => csvFilterSamplerAgent.execute(input, context),
      assert: async (result) => {
        assert(result, "Should return a result");
        assert(result.ok, "Should return ok: true");
        assert(result.data.response, "Should return response");

        const artifactRefs = result.artifactRefs ?? [];
        assert(artifactRefs.length > 0, "Should return artifactRefs");
        const artifactRef = artifactRefs[0];
        assert(artifactRef, "First artifactRef should exist");
        assertEquals(artifactRef.type, "file", "ArtifactRef should be type 'file'");

        // Load and verify artifact content
        const artifactResult = await ArtifactStorage.get({ id: artifactRef.id });
        assert(artifactResult.ok, "Should load artifact");
        assert(artifactResult.data, "Artifact data should exist");
        assert(artifactResult.data.data.type === "file", "Artifact should be file type");

        const artifactFilePath = artifactResult.data.data.data.path;
        const artifactContent = await readFile(artifactFilePath, "utf-8");
        const artifactData = ArtifactOutputSchema.parse(JSON.parse(artifactContent));

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

        assert(Array.isArray(samples), "Samples should be array");
        assertEquals(
          samples.length,
          metadata.sampleCount,
          "Samples array should match sampleCount",
        );

        // Verify all samples exist in original CSV with matching values
        for (const sample of samples) {
          const matchingRecord = parsedCsv.data.find(
            (record: Record<string, CsvCell>) => record.Email === sample.Email,
          );
          assert(matchingRecord, `Sample with email ${sample.Email} should exist in original CSV`);

          for (const [key, value] of Object.entries(sample)) {
            const originalValue = matchingRecord[key];
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
      },
      metadata: { totalRecords, expectedFilteredCount },
    },
  }),

  defineEval({
    name: "csv-contact-sampler/randomness",
    adapter,
    config: {
      input: filterPrompt,
      run: async (input) => {
        const allSamples: string[] = [];
        const runs = 5;

        for (let i = 0; i < runs; i++) {
          const { context: runContext } = adapter.createContext();
          const result = await csvFilterSamplerAgent.execute(input, runContext);

          assert(result, `Run ${i + 1} should return a result`);
          assert(result.ok, `Run ${i + 1} should return ok: true`);
          const runArtifactRefs = result.artifactRefs ?? [];
          assert(runArtifactRefs.length > 0, `Run ${i + 1} should return artifactRefs`);

          const runArtifactRef = runArtifactRefs[0];
          assert(runArtifactRef, `Run ${i + 1} first artifactRef should exist`);
          const artifactResult = await ArtifactStorage.get({ id: runArtifactRef.id });
          assert(artifactResult.ok, "Should load artifact");
          assert(artifactResult.data, "Artifact data should exist");
          assert(artifactResult.data.data.type === "file", "Artifact should be file type");

          const artifactFilePath = artifactResult.data.data.data.path;
          const artifactContent = await readFile(artifactFilePath, "utf-8");
          const artifactData = ArtifactOutputSchema.parse(JSON.parse(artifactContent));

          for (const sample of artifactData.samples) {
            allSamples.push(String(sample.Email || ""));
          }
        }

        const uniqueSamples = new Set(allSamples.filter((email) => email));
        return { runs, totalSamples: allSamples.length, uniqueCount: uniqueSamples.size };
      },
      assert: (result) => {
        assert(result.totalSamples > 0, "Should have at least some samples across all runs");
        if (result.uniqueCount > 0) {
          assert(
            result.uniqueCount > 1 || result.totalSamples === 1,
            "Should have variety if multiple samples",
          );
        }
      },
    },
  }),

  defineEval({
    name: "csv-contact-sampler/empty-filter",
    adapter,
    config: {
      input: `Read artifact ${artifactId} and filter for contacts from Antarctica with CEO title`,
      run: (input, context) => csvFilterSamplerAgent.execute(input, context),
      assert: async (result) => {
        assert(result, "Agent should handle empty results gracefully");
        assert(result.ok, "Should return ok: true even with empty results");

        const emptyArtifactRefs = result.artifactRefs ?? [];
        assert(emptyArtifactRefs.length > 0, "Should return artifactRefs even with empty results");

        const emptyArtifactRef = emptyArtifactRefs[0];
        assert(emptyArtifactRef, "First artifactRef should exist");
        const artifactResult = await ArtifactStorage.get({ id: emptyArtifactRef.id });
        assert(artifactResult.ok, "Should load artifact");
        assert(artifactResult.data, "Artifact data should exist");
        assert(artifactResult.data.data.type === "file", "Artifact should be file type");

        const artifactFilePath = artifactResult.data.data.data.path;
        const artifactContent = await readFile(artifactFilePath, "utf-8");
        const artifactData = ArtifactOutputSchema.parse(JSON.parse(artifactContent));

        assertEquals(artifactData.metadata.filteredCount, 0, "Should have zero filtered records");
        assertEquals(artifactData.metadata.sampleCount, 0, "Should have zero samples");
        assertEquals(artifactData.samples.length, 0, "Samples array should be empty");
      },
    },
  }),
];

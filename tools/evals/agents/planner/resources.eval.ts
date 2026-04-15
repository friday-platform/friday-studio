/**
 * Planner resource declaration eval.
 *
 * Tests that `generatePlan()` correctly declares resource types (document, prose,
 * artifact_ref, external_ref), distinguishes "link to existing" (ref present)
 * from "create new" (ref absent) for external refs, and scores exact subtype
 * match. Documents can have hierarchical schemas with nested properties.
 *
 * Each case runs in both "task" and "workspace" modes.
 */

import {
  formatUserMessage,
  generatePlan,
  getSystemPrompt,
  type Phase1Resource,
  type PlanMode,
} from "../../../../packages/workspace-builder/planner/plan.ts";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { createPlannerEvalPlatformModels } from "../../lib/planner-models.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

await loadCredentials();

const adapter = new AgentContextAdapter();
const platformModels = createPlannerEvalPlatformModels();

// ---------------------------------------------------------------------------
// Case type
// ---------------------------------------------------------------------------

/** Broad category for binary resource-types scoring (backward compat). */
type ResourceCategory = "document" | "external-ref";

/** All Phase1Resource.type values, kebab-cased for eval display. */
type ResourceSubtype = "document" | "prose" | "artifact-ref" | "external-ref";

interface ResourceCase extends BaseEvalCase {
  /** Expected resource declarations in the plan output. */
  expectedResources: Array<{
    /** Exact resource subtype for scoring. */
    type: ResourceSubtype;
    /** Expected provider value for external-ref resources. */
    provider?: string;
    /** Whether the ref field should be populated (link existing) or absent (create new). */
    hasRef?: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: ResourceCase[] = [
  // -------------------------------------------------------------------------
  // Document resources — Friday built-in storage
  // -------------------------------------------------------------------------
  {
    id: "grocery-tracker-table",
    name: "document - grocery list in Friday",
    input:
      "Create a workspace that manages my grocery list. I want to track items " +
      "with name, quantity, category, and whether I've purchased them. Store everything in Friday.",
    expectedResources: [{ type: "document" }],
  },
  {
    id: "reading-log-table",
    name: "document - reading log with no external service",
    input:
      "Build a workspace to track books I'm reading. Store title, author, " +
      "rating, and status (reading, finished, abandoned).",
    expectedResources: [{ type: "document" }],
  },

  // -------------------------------------------------------------------------
  // Prose resources — markdown string content
  // -------------------------------------------------------------------------
  {
    id: "prose-meeting-notes",
    name: "prose - running meeting notes",
    input:
      "Keep running meeting notes that I can review and edit. After each " +
      "calendar meeting, pull the agenda and attendees and append a summary " +
      "in markdown. I want one living document I can always go back to.",
    expectedResources: [{ type: "prose" }],
  },
  {
    id: "prose-weekly-report",
    name: "prose - weekly engineering report",
    input:
      "Maintain a weekly engineering report as a markdown document. Each " +
      "Friday, summarize what shipped, what's in progress, and blockers. " +
      "Overwrite the previous week so I always have the latest version ready to share.",
    expectedResources: [{ type: "prose" }],
  },

  // -------------------------------------------------------------------------
  // Document resources with hierarchical schemas
  // -------------------------------------------------------------------------
  {
    id: "document-nested-meeting-with-items",
    name: "document (hierarchical) - meetings with attendees and action items",
    input:
      "Track meetings with attendees and action items per topic. Each " +
      "meeting has a date, a list of topics discussed, and under each topic " +
      "a list of action items with assignee and due date.",
    expectedResources: [{ type: "document" }],
  },
  {
    id: "document-nested-research-brief",
    name: "document (hierarchical) - research brief with sections and sources",
    input:
      "Build a research brief tracker. Each brief has a title, an executive " +
      "summary, and multiple sections. Each section has a heading, body text, " +
      "and a list of source URLs with annotations.",
    expectedResources: [{ type: "document" }],
  },

  // -------------------------------------------------------------------------
  // External ref — link to existing resource (ref should be present)
  // -------------------------------------------------------------------------
  {
    id: "notion-link-existing",
    name: "external-ref link - existing Notion doc",
    input:
      "Set up a workspace that syncs my meeting action items to my Notion page " +
      "at https://www.notion.so/Meeting-Notes-abc123. Pull action items from " +
      "my calendar and add them there.",
    expectedResources: [{ type: "external-ref", provider: "notion", hasRef: true }],
  },
  {
    id: "sheets-link-existing",
    name: "external-ref link - existing Google Sheet",
    input:
      "I track my monthly budget in a Google Sheet at " +
      "https://docs.google.com/spreadsheets/d/abc123. Set up a workspace " +
      "that reads my bank transactions and updates the sheet.",
    expectedResources: [{ type: "external-ref", provider: "google-sheets", hasRef: true }],
  },

  // -------------------------------------------------------------------------
  // External ref — create new resource (ref should be absent)
  // -------------------------------------------------------------------------
  {
    id: "notion-create-new",
    name: "external-ref create - new Notion database",
    input:
      "Build a workspace that tracks my reading notes. Store the notes in " +
      "Notion — create a new database for it.",
    expectedResources: [{ type: "external-ref", provider: "notion", hasRef: false }],
  },
  {
    id: "sheets-create-new",
    name: "external-ref create - new Google Sheet",
    input:
      "Set up a workspace that tracks competitor pricing. Put the data in a " +
      "Google Sheet so I can share it with my team.",
    expectedResources: [{ type: "external-ref", provider: "google-sheets", hasRef: false }],
  },

  // -------------------------------------------------------------------------
  // Mixed — document + external ref together (dual-intent)
  // -------------------------------------------------------------------------
  {
    id: "dual-table-and-notion-create",
    name: "mixed - document for state + new Notion for output",
    input:
      "Track my stock portfolio in Friday (holdings, shares, buy price) and " +
      "sync a weekly performance summary to Notion.",
    expectedResources: [
      { type: "document" },
      { type: "external-ref", provider: "notion", hasRef: false },
    ],
  },
  {
    id: "dual-table-and-notion-link",
    name: "mixed - document for state + existing Notion doc",
    input:
      "Track my stock portfolio in Friday (holdings, shares, buy price) and " +
      "sync a weekly performance summary to my Notion page at " +
      "https://www.notion.so/Portfolio-Reports-def456.",
    expectedResources: [
      { type: "document" },
      { type: "external-ref", provider: "notion", hasRef: true },
    ],
  },

  // -------------------------------------------------------------------------
  // No resources needed
  // -------------------------------------------------------------------------
  {
    id: "no-resources-monitoring",
    name: "none - pure monitoring pipeline",
    input:
      "Monitor Hacker News for posts about AI agents and send me a Slack " +
      "message when something gets over 100 points.",
    expectedResources: [],
  },
];

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/** Classify a Phase1Resource into its exact subtype (kebab-case for display). */
function classifySubtype(r: Phase1Resource): ResourceSubtype {
  const map: Record<Phase1Resource["type"], ResourceSubtype> = {
    document: "document",
    prose: "prose",
    artifact_ref: "artifact-ref",
    external_ref: "external-ref",
  };
  return map[r.type];
}

/** Broad category for backward-compatible resource-types scoring. */
function classifyCategory(r: Phase1Resource): ResourceCategory {
  return r.type === "external_ref" ? "external-ref" : "document";
}

/** Map a ResourceSubtype to its broad category. */
function subtypeToCategory(t: ResourceSubtype): ResourceCategory {
  return t === "external-ref" || t === "artifact-ref" ? "external-ref" : "document";
}

const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean"]);

function isSchemaObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Validate that a Phase1Resource's schema matches its declared type.
 * Returns `{ valid: true }` or `{ valid: false, reason: string }`.
 */
function validateSchema(r: Phase1Resource): { valid: boolean; reason: string } {
  const schema = r.schema;

  switch (r.type) {
    case "document": {
      if (!schema) return { valid: false, reason: "document missing schema" };
      if (schema.type !== "object")
        return {
          valid: false,
          reason: `document schema.type is "${schema.type}", expected "object"`,
        };
      const props = schema.properties;
      if (!isSchemaObject(props))
        return { valid: false, reason: "document schema missing properties" };
      for (const [key, val] of Object.entries(props)) {
        if (!isSchemaObject(val)) {
          return { valid: false, reason: `document property "${key}" is not a schema object` };
        }
        // Document schemas allow both scalar and nested types (array, object)
        const ALLOWED_TYPES = new Set([...SCALAR_TYPES, "array", "object"]);
        if (typeof val.type !== "string" || !ALLOWED_TYPES.has(val.type)) {
          return {
            valid: false,
            reason: `document property "${key}" has unsupported type "${val.type}"`,
          };
        }
      }
      return { valid: true, reason: "object with valid property types" };
    }

    case "prose": {
      if (schema && schema.type === "string") return { valid: true, reason: "string schema" };
      if (!schema) return { valid: true, reason: "no schema (acceptable for prose)" };
      return {
        valid: false,
        reason: `prose schema.type is "${schema.type}", expected "string" or absent`,
      };
    }

    case "artifact_ref":
    case "external_ref":
      return { valid: true, reason: "no schema requirement for ref types" };
  }
}

// ---------------------------------------------------------------------------
// Registrations — each case x 2 modes
// ---------------------------------------------------------------------------

const modes: PlanMode[] = ["task", "workspace"];

export const evals: EvalRegistration[] = cases.flatMap((testCase) =>
  modes.map((mode) =>
    defineEval({
      name: `resources/${mode}/${testCase.id}`,
      adapter,
      config: {
        input: testCase.input,
        run: async () => {
          return await generatePlan(testCase.input, { platformModels }, { mode });
        },
        score: (result) => {
          const scores = [];
          const actual = result.resources;
          const expected = testCase.expectedResources;

          // Score 1: correct resource count
          const countMatch = actual.length === expected.length;
          scores.push(
            createScore(
              "resource-count",
              countMatch ? 1 : 0,
              `expected ${expected.length}, got ${actual.length}`,
            ),
          );

          if (expected.length === 0) {
            // No resources expected — score 1 if none declared
            return scores;
          }

          // Score 2: correct broad resource categories (document vs external-ref)
          const actualCategories = actual.map(classifyCategory);
          const expectedCategories = expected.map((e) => subtypeToCategory(e.type));
          const categoriesMatch =
            expectedCategories.every((t) => actualCategories.includes(t)) &&
            actualCategories.every((t) => expectedCategories.includes(t));
          scores.push(
            createScore(
              "resource-types",
              categoriesMatch ? 1 : 0,
              `expected [${expectedCategories.join(", ")}], got [${actualCategories.join(", ")}]`,
            ),
          );

          // Score 3: exact subtype match (document, prose, nested, artifact-ref, external-ref)
          const actualSubtypes = actual.map(classifySubtype).sort();
          const expectedSubtypes = expected.map((e) => e.type).sort();
          const subtypesMatch =
            actualSubtypes.length === expectedSubtypes.length &&
            actualSubtypes.every((t, i) => t === expectedSubtypes[i]);
          scores.push(
            createScore(
              "resource-subtype",
              subtypesMatch ? 1 : 0,
              `expected [${expectedSubtypes.join(", ")}], got [${actualSubtypes.join(", ")}]`,
            ),
          );

          // Score 4: schema matches declared type
          for (const resource of actual) {
            const result = validateSchema(resource);
            scores.push(
              createScore(
                `schema-valid-${resource.slug ?? resource.name}`,
                result.valid ? 1 : 0,
                result.reason,
              ),
            );
          }

          // Score 5: correct providers for external refs
          const expectedExternals = expected.filter((e) => e.type === "external-ref");
          const actualExternals = actual.filter((r) => r.provider);
          if (expectedExternals.length > 0) {
            const expectedProviders = expectedExternals
              .map((e) => e.provider)
              .filter(Boolean)
              .sort();
            const actualProviders = actualExternals
              .map((r) => r.provider)
              .filter(Boolean)
              .sort();
            const providersMatch =
              expectedProviders.length === actualProviders.length &&
              expectedProviders.every((p, i) => actualProviders[i] === p);
            scores.push(
              createScore(
                "correct-providers",
                providersMatch ? 1 : 0,
                `expected [${expectedProviders.join(", ")}], got [${actualProviders.join(", ")}]`,
              ),
            );
          }

          // Score 6: ref presence/absence for link vs create
          for (const expectedRef of expectedExternals) {
            if (expectedRef.hasRef === undefined) continue;
            const matching = actualExternals.find((r) => r.provider === expectedRef.provider);
            if (!matching) continue;

            const hasRef = Boolean(matching.ref);
            const refCorrect = expectedRef.hasRef === hasRef;
            scores.push(
              createScore(
                `ref-intent-${expectedRef.provider}`,
                refCorrect ? 1 : 0,
                expectedRef.hasRef
                  ? `expected link-to-existing (ref present), ${hasRef ? `ref: ${matching.ref}` : "ref missing"}`
                  : `expected create-new (no ref), ${hasRef ? `unexpected ref: ${matching.ref}` : "correctly no ref"}`,
              ),
            );
          }

          return scores;
        },
        metadata: {
          mode,
          expectedResources: testCase.expectedResources,
          promptSnapshot: getSystemPrompt(mode),
          userMessage: formatUserMessage(testCase.input, mode),
        },
      },
    }),
  ),
);

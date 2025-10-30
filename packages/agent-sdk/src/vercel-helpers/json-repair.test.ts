import { assertEquals } from "jsr:@std/assert@^1";
import { JSONParseError } from "ai";
import { z } from "zod";
import { repairJson } from "./json-repair.ts";

// Test schemas matching actual workspace-planner usage
const WorkspacePlanSchema = z.object({
  workspace: z.object({ name: z.string(), purpose: z.string() }),
  signals: z.array(z.object({ name: z.string(), description: z.string() })),
  agents: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      needs: z.array(z.string()),
      configuration: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

const WorkspacePlanResponseSchema = z.object({ plan: WorkspacePlanSchema });

Deno.test("repairJson - repairs stringified JSON in object fields", async () => {
  // Actual error case from workspace-planner
  const malformedJson = `{
  "plan": "{\\n  \\"workspace\\": {\\n    \\"name\\": \\"LinkedIn Connection Outreach Automation\\",\\n    \\"purpose\\": \\"Automates daily research and email reminders for networking with LinkedIn connections. Each weekday morning, the system selects three people from New York-based companies with 50+ employees, researches both the individuals and their companies, and sends a structured email with actionable outreach insights. This eliminates manual research work and ensures consistent, varied networking touchpoints.\\"\\n  },\\n  \\"signals\\": [\\n    {\\n      \\"name\\": \\"Daily Weekday Morning Trigger\\",\\n      \\"description\\": \\"Fires every weekday at 8 AM to initiate the daily selection and research workflow. Morning timing ensures the email arrives at the start of the workday when it's most actionable.\\"\\n    }\\n  ],\\n  \\"agents\\": [\\n    {\\n      \\"name\\": \\"CSV Connection Loader\\",\\n      \\"description\\": \\"Reads LinkedIn connections from the CSV file and extracts contact information for downstream processing.\\",\\n      \\"needs\\": [],\\n      \\"configuration\\": {\\n        \\"csv_path\\": \\"/Users/odk/Downloads/Connections.csv\\"\\n      }\\n    },\\n    {\\n      \\"name\\": \\"Company Researcher\\",\\n      \\"description\\": \\"Researches companies to determine location and employee count, filtering for New York-based companies with 50+ employees. Maintains a database of researched companies to avoid duplicate research.\\",\\n      \\"needs\\": [],\\n      \\"configuration\\": {}\\n    },\\n    {\\n      \\"name\\": \\"Contact Selector\\",\\n      \\"description\\": \\"Randomly selects 3 people from the filtered list of qualified connections each day. Tracks selection history to ensure variety over time and avoid repeated selections.\\",\\n      \\"needs\\": [],\\n      \\"configuration\\": {}\\n    },\\n    {\\n      \\"name\\": \\"Person Researcher\\",\\n      \\"description\\": \\"Researches selected individuals to gather detailed information about their background, experience, and professional profile for personalized outreach.\\",\\n      \\"needs\\": [],\\n      \\"configuration\\": {}\\n    },\\n    {\\n      \\"name\\": \\"Outreach Content Generator\\",\\n      \\"description\\": \\"Synthesizes research data to generate structured outreach materials: 4-sentence company summaries, 5 bullet points about each person, and 3 potential intro message ideas tailored to each individual.\\",\\n      \\"needs\\": [],\\n      \\"configuration\\": {}\\n    },\\n    {\\n      \\"name\\": \\"Email Sender\\",\\n      \\"description\\": \\"Sends the daily structured email containing all researched profiles and outreach suggestions to the specified recipient.\\",\\n      \\"needs\\": [\\"email\\"],\\n      \\"configuration\\": {\\n        \\"recipient\\": \\"michal@tempest.team\\"\\n      }\\n    }\\n  ]\\n}"
}`;

  const result = await repairJson({
    text: malformedJson,
    error: new JSONParseError({ text: malformedJson, cause: new Error("Invalid type") }),
  });

  assertEquals(result !== null, true);

  // Validate with Zod schema
  const parsed = WorkspacePlanResponseSchema.parse(JSON.parse(result!));
  assertEquals(parsed.plan.workspace.name, "LinkedIn Connection Outreach Automation");
  assertEquals(parsed.plan.signals.length, 1);
  assertEquals(parsed.plan.agents.length, 6);
});

Deno.test("repairJson - handles nested stringified JSON", async () => {
  const NestedSchema = z.object({ outer: z.object({ inner: z.object({ deep: z.string() }) }) });

  const nested = `{
  "outer": "{\\"inner\\": \\"{\\\\\\"deep\\\\\\": \\\\\\"value\\\\\\"}\\"}"
}`;

  const result = await repairJson({
    text: nested,
    error: new JSONParseError({ text: nested, cause: new Error("test") }),
  });

  assertEquals(result !== null, true);

  const parsed = NestedSchema.parse(JSON.parse(result!));
  assertEquals(parsed.outer.inner.deep, "value");
});

Deno.test("repairJson - returns null for unparseable JSON", async () => {
  const invalidJson = "not json at all";

  const result = await repairJson({
    text: invalidJson,
    error: new JSONParseError({ text: invalidJson, cause: new Error("test") }),
  });

  assertEquals(result, null);
});

Deno.test("repairJson - handles arrays with stringified JSON elements", async () => {
  const ArrayCaseSchema = z.object({ items: z.array(z.object({ name: z.string() })) });

  const arrayCase = `{
  "items": ["{\\"name\\": \\"item1\\"}", "{\\"name\\": \\"item2\\"}"]
}`;

  const result = await repairJson({
    text: arrayCase,
    error: new JSONParseError({ text: arrayCase, cause: new Error("test") }),
  });

  assertEquals(result !== null, true);

  const parsed = ArrayCaseSchema.parse(JSON.parse(result!));
  assertEquals(parsed.items.length, 2);
  const firstItem = parsed.items.at(0);
  const secondItem = parsed.items.at(1);
  assertEquals(firstItem?.name, "item1");
  assertEquals(secondItem?.name, "item2");
});

Deno.test("repairJson - leaves valid JSON unchanged", async () => {
  const ValidJsonSchema = z.object({
    plan: z.object({ workspace: z.object({ name: z.string() }) }),
  });

  const validJson = `{
  "plan": {
    "workspace": {
      "name": "Test Workspace"
    }
  }
}`;

  const result = await repairJson({
    text: validJson,
    error: new JSONParseError({ text: validJson, cause: new Error("test") }),
  });

  assertEquals(result !== null, true);

  const parsed = ValidJsonSchema.parse(JSON.parse(result!));
  assertEquals(parsed.plan.workspace.name, "Test Workspace");
});

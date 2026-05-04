import { InvalidToolInputError, JSONParseError, NoSuchToolError } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { repairJson, repairToolCall } from "./json-repair.ts";

const WorkspacePlanSchema = z.object({
  workspace: z.object({ name: z.string(), purpose: z.string() }),
  signals: z.array(z.object({ name: z.string(), description: z.string() })),
  agents: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      capabilities: z.array(z.string()),
      configuration: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

const WorkspacePlanResponseSchema = z.object({ plan: WorkspacePlanSchema });

describe("repairJson", () => {
  it("repairs stringified JSON in object fields", async () => {
    const malformedJson = `{
  "plan": "{\\n  \\"workspace\\": {\\n    \\"name\\": \\"LinkedIn Connection Outreach Automation\\",\\n    \\"purpose\\": \\"Automates daily research and email reminders for networking with LinkedIn connections. Each weekday morning, the system selects three people from New York-based companies with 50+ employees, researches both the individuals and their companies, and sends a structured email with actionable outreach insights. This eliminates manual research work and ensures consistent, varied networking touchpoints.\\"\\n  },\\n  \\"signals\\": [\\n    {\\n      \\"name\\": \\"Daily Weekday Morning Trigger\\",\\n      \\"description\\": \\"Fires every weekday at 8 AM to initiate the daily selection and research workflow. Morning timing ensures the email arrives at the start of the workday when it's most actionable.\\"\\n    }\\n  ],\\n  \\"agents\\": [\\n    {\\n      \\"name\\": \\"CSV Connection Loader\\",\\n      \\"description\\": \\"Reads LinkedIn connections from the CSV file and extracts contact information for downstream processing.\\",\\n      \\"capabilities\\": [],\\n      \\"configuration\\": {\\n        \\"csv_path\\": \\"/tmp/connections.csv\\"\\n      }\\n    },\\n    {\\n      \\"name\\": \\"Company Researcher\\",\\n      \\"description\\": \\"Researches companies to determine location and employee count, filtering for New York-based companies with 50+ employees. Maintains a database of researched companies to avoid duplicate research.\\",\\n      \\"capabilities\\": [],\\n      \\"configuration\\": {}\\n    },\\n    {\\n      \\"name\\": \\"Contact Selector\\",\\n      \\"description\\": \\"Randomly selects 3 people from the filtered list of qualified connections each day. Tracks selection history to ensure variety over time and avoid repeated selections.\\",\\n      \\"capabilities\\": [],\\n      \\"configuration\\": {}\\n    },\\n    {\\n      \\"name\\": \\"Person Researcher\\",\\n      \\"description\\": \\"Researches selected individuals to gather detailed information about their background, experience, and professional profile for personalized outreach.\\",\\n      \\"capabilities\\": [],\\n      \\"configuration\\": {}\\n    },\\n    {\\n      \\"name\\": \\"Outreach Content Generator\\",\\n      \\"description\\": \\"Synthesizes research data to generate structured outreach materials: 4-sentence company summaries, 5 bullet points about each person, and 3 potential intro message ideas tailored to each individual.\\",\\n      \\"capabilities\\": [],\\n      \\"configuration\\": {}\\n    },\\n    {\\n      \\"name\\": \\"Email Sender\\",\\n      \\"description\\": \\"Sends the daily structured email containing all researched profiles and outreach suggestions to the specified recipient.\\",\\n      \\"capabilities\\": [\\"email\\"],\\n      \\"configuration\\": {\\n        \\"recipient\\": \\"recipient@example.com\\"\\n      }\\n    }\\n  ]\\n}"
}`;

    const result = await repairJson({
      text: malformedJson,
      error: new JSONParseError({ text: malformedJson, cause: new Error("Invalid type") }),
    });

    if (result === null) throw new Error("Expected result to not be null");

    // Validate with Zod schema
    const parsed = WorkspacePlanResponseSchema.parse(JSON.parse(result));
    expect(parsed.plan.workspace.name).toEqual("LinkedIn Connection Outreach Automation");
    expect(parsed.plan.signals.length).toEqual(1);
    expect(parsed.plan.agents.length).toEqual(6);
  });

  it("handles nested stringified JSON", async () => {
    const NestedSchema = z.object({ outer: z.object({ inner: z.object({ deep: z.string() }) }) });

    const nested = `{
  "outer": "{\\"inner\\": \\"{\\\\\\"deep\\\\\\": \\\\\\"value\\\\\\"}\\"}"
}`;

    const result = await repairJson({
      text: nested,
      error: new JSONParseError({ text: nested, cause: new Error("test") }),
    });

    if (result === null) throw new Error("Expected result to not be null");

    const parsed = NestedSchema.parse(JSON.parse(result));
    expect(parsed.outer.inner.deep).toEqual("value");
  });

  it("returns null for unparseable JSON", async () => {
    const invalidJson = "not json at all";

    const result = await repairJson({
      text: invalidJson,
      error: new JSONParseError({ text: invalidJson, cause: new Error("test") }),
    });

    expect(result).toBeNull();
  });

  it("handles arrays with stringified JSON elements", async () => {
    const ArrayCaseSchema = z.object({ items: z.array(z.object({ name: z.string() })) });

    const arrayCase = `{
  "items": ["{\\"name\\": \\"item1\\"}", "{\\"name\\": \\"item2\\"}"]
}`;

    const result = await repairJson({
      text: arrayCase,
      error: new JSONParseError({ text: arrayCase, cause: new Error("test") }),
    });

    if (result === null) throw new Error("Expected result to not be null");

    const parsed = ArrayCaseSchema.parse(JSON.parse(result));
    expect(parsed.items.length).toEqual(2);
    const firstItem = parsed.items.at(0);
    const secondItem = parsed.items.at(1);
    expect(firstItem?.name).toEqual("item1");
    expect(secondItem?.name).toEqual("item2");
  });

  it("leaves valid JSON unchanged", async () => {
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

    if (result === null) throw new Error("Expected result to not be null");

    const parsed = ValidJsonSchema.parse(JSON.parse(result));
    expect(parsed.plan.workspace.name).toEqual("Test Workspace");
  });

  it("repairs stringified array in object field (search-tools case)", async () => {
    // Actual error case from search-tools.ts - SummarizedResultSchema
    const SummarizedResultSchema = z.object({
      summary: z.string(),
      key_excerpts: z.array(z.string()),
    });

    // The JSON that caused the error - key_excerpts is a stringified array with malformed JSON
    // Note: The unquoted text "in the band Example" breaks JSON syntax
    const malformedJson = `{"summary":"Test summary about a fictional person with multiple roles in the music industry. This person works in music distribution and is also a performing artist.","key_excerpts":"[\\"Person A - Digital Coordinator at Music Company, a global distribution company\\", \\"Born January 1, 1990, a singer and songwriter\\", \\"One of the brightest young stars in the industry\\", \\"Member of Band X\\" in the band Example, \\"Presents opportunities to collaborate\\"]"}`;

    const result = await repairJson({
      text: malformedJson,
      error: new JSONParseError({ text: malformedJson, cause: new Error("Invalid type") }),
    });

    if (result === null) throw new Error("Expected result to not be null");

    // This should pass after repair - key_excerpts should be an actual array
    const parsed = SummarizedResultSchema.parse(JSON.parse(result));
    expect(parsed.key_excerpts.length).toEqual(5);
    expect(parsed.key_excerpts[0]).toEqual(
      "Person A - Digital Coordinator at Music Company, a global distribution company",
    );
  });
});

describe("repairToolCall", () => {
  it("repairs malformed JSON in tool call arguments", async () => {
    const malformedInput = `{"query": "test", "options": {trailing: comma,}}`;
    const toolCall = {
      type: "tool-call" as const,
      toolCallId: "call_123",
      toolName: "search",
      input: malformedInput,
    };

    const result = await repairToolCall({
      system: undefined,
      messages: [],
      tools: {},
      inputSchema: () => Promise.resolve({}),
      toolCall,
      error: new InvalidToolInputError({
        toolName: "search",
        toolInput: malformedInput,
        cause: new Error("Invalid JSON"),
      }),
    });

    expect(result).not.toBeNull();
    if (!result) throw new Error("Expected result to be defined");
    expect(result.toolCallId).toEqual("call_123");
    expect(result.toolName).toEqual("search");
    // Verify the repaired JSON is valid
    const ParsedSchema = z.object({ query: z.string() });
    const parsed = ParsedSchema.parse(JSON.parse(result.input));
    expect(parsed.query).toEqual("test");
  });

  it("returns null for NoSuchToolError", async () => {
    const toolCall = {
      type: "tool-call" as const,
      toolCallId: "call_123",
      toolName: "unknown_tool",
      input: "{}",
    };

    const result = await repairToolCall({
      system: undefined,
      messages: [],
      tools: {},
      inputSchema: () => Promise.resolve({}),
      toolCall,
      error: new NoSuchToolError({ toolName: "unknown_tool" }),
    });

    expect(result).toBeNull();
  });

  it("returns null for unrepairable JSON", async () => {
    const unreparableInput = "completely invalid {{{{";
    const toolCall = {
      type: "tool-call" as const,
      toolCallId: "call_123",
      toolName: "search",
      input: unreparableInput,
    };

    const result = await repairToolCall({
      system: undefined,
      messages: [],
      tools: {},
      inputSchema: () => Promise.resolve({}),
      toolCall,
      error: new InvalidToolInputError({
        toolName: "search",
        toolInput: unreparableInput,
        cause: new Error("Invalid JSON"),
      }),
    });

    expect(result).toBeNull();
  });
});

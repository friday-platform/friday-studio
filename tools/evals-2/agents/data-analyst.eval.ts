import { evalite } from "evalite";
import { dataAnalystAgent } from "../../../packages/bundled-agents/src/data-analyst/agent.ts";
import { AgentContextAdapter } from "../lib/context.ts";
import { LLMJudge } from "../lib/llm-judge.ts";
import { loadCredentials } from "../lib/load-credentials.ts";
import { createFixtures, type FixtureIds } from "./data-analyst/fixtures.ts";
import {
  type DataAnalystInput,
  type DataAnalystOutput,
  FailureScorer,
  RowCountScorer,
} from "./data-analyst/scorers.ts";

// Set up credentials and fixtures once at module load
await loadCredentials();

// Create fixtures - these become real artifacts in storage
const fixtures: FixtureIds = await createFixtures();

// Create adapter for test contexts
const adapter = new AgentContextAdapter();

/**
 * Data Analyst Agent - Core Analysis Capabilities
 *
 * Tests the 80/20 of data analysis: aggregation, grouping, filtering, joins,
 * column quoting, date handling, and error cases.
 *
 * Fixture data (from fixtures.ts):
 * - SALES: 4 rows, total revenue=7000, US=3000, EU=4000, Widget=2500, Gadget=4500
 * - PRODUCTS: Widget->Electronics, Gadget->Hardware
 * - CONTACTS: columns with spaces (First Name, Last Name, etc.)
 */
evalite<DataAnalystInput, DataAnalystOutput, string>("Data Analyst Agent - Core Analysis", {
  data: [
    // Case 1: Simple aggregation (COUNT, SUM, AVG)
    {
      input: {
        prompt: `Analyze ${fixtures.SALES_ID}. What is the total revenue across all sales?`,
        artifactIds: [fixtures.SALES_ID],
      },
      expected: `The analysis should:
        1. Calculate total revenue = 7000 (sum of 1000+2000+1500+2500)
        2. Use a simple SUM aggregation query
        3. Return a clear summary with the exact total
        4. Not require save_results (single value answer)
        The agent should correctly sum the revenue column.`,
    },

    // Case 2: Grouped aggregation (GROUP BY + ORDER)
    {
      input: {
        prompt: `Analyze ${fixtures.SALES_ID}. Calculate revenue by region and show which region has higher revenue.`,
        artifactIds: [fixtures.SALES_ID],
        expectedRowCount: 2, // Two regions: US and EU
      },
      expected: `The analysis should:
        1. Group revenue by region using GROUP BY
        2. Show EU revenue (4000) > US revenue (3000)
        3. Order results to make comparison clear
        4. Call save_results to save the grouped breakdown
        5. Produce 2 rows (one per region)
        The agent should use GROUP BY region and call save_results with the breakdown.`,
    },

    // Case 3: Filtering + aggregation (WHERE + SUM)
    {
      input: {
        prompt: `Analyze ${fixtures.SALES_ID}. What is the total revenue for Widget products only?`,
        artifactIds: [fixtures.SALES_ID],
      },
      expected: `The analysis should:
        1. Filter to product='Widget' using WHERE clause
        2. Calculate Widget revenue = 2500 (1000+1500)
        3. Return the filtered total clearly
        The agent should use WHERE product='Widget' and SUM(revenue).`,
    },

    // Case 4: Multi-table join (JOIN on product name)
    {
      input: {
        prompt: `Analyze ${fixtures.SALES_ID} and ${fixtures.PRODUCTS_ID}. Calculate total revenue by product category.`,
        artifactIds: [fixtures.SALES_ID, fixtures.PRODUCTS_ID],
        expectedRowCount: 2, // Two categories: Electronics and Hardware
      },
      expected: `The analysis should:
        1. JOIN sales and products tables on product name
        2. GROUP BY category
        3. Show Electronics revenue (Widgets: 2500) and Hardware revenue (Gadgets: 4500)
        4. Call save_results with category breakdown
        The agent should correctly join tables and aggregate by category.`,
    },

    // Case 5: Column name quoting (columns with spaces)
    {
      input: {
        prompt: `Analyze ${fixtures.CONTACTS_ID}. List all contacts with their first name, last name, and company.`,
        artifactIds: [fixtures.CONTACTS_ID],
        expectedRowCount: 3, // Three contacts
      },
      expected: `The analysis should:
        1. Query columns with spaces ("First Name", "Last Name", "Company Name")
        2. Use proper quoting to avoid SQL errors
        3. Return all 3 contacts successfully
        4. Call save_results with the contact list
        The agent must properly quote column names with spaces.`,
    },

    // Case 6: Date filtering (date range queries)
    {
      input: {
        prompt: `Analyze ${fixtures.SALES_ID}. What was the total revenue in January 2024?`,
        artifactIds: [fixtures.SALES_ID],
      },
      expected: `The analysis should:
        1. Filter by date range (January 2024)
        2. Calculate January revenue = 3000 (1000+2000 from Jan 15-16)
        3. Use date comparison in WHERE clause
        The agent should filter dates correctly and return 3000.`,
    },

    // Case 7: No data artifact needed (counting question)
    {
      input: {
        prompt: `Analyze ${fixtures.SALES_ID}. How many sales transactions are there?`,
        artifactIds: [fixtures.SALES_ID],
      },
      expected: `The analysis should:
        1. Count total rows = 4
        2. Return the count as a simple answer
        3. NOT call save_results (simple count doesn't need export)
        The agent should answer "4 transactions" without saving results.`,
    },

    // Case 8: Invalid artifact ID (error handling)
    {
      input: {
        prompt: `Analyze 00000000-0000-0000-0000-000000000000. What is the total revenue?`,
        artifactIds: ["00000000-0000-0000-0000-000000000000"],
        shouldFail: true,
      },
      expected: `The agent should:
        1. Fail fast with clear error message
        2. Indicate artifact not found
        3. Not attempt any SQL operations
        Error handling should be graceful and informative.`,
    },
  ],

  task: async (input) => {
    const { context } = adapter.createContext();

    try {
      // dataAnalystAgent.execute returns DataAnalystResult directly, throws on error
      const result = await dataAnalystAgent.execute(input.prompt, context);

      // Extract row count from summary if available (for deterministic scoring)
      // Look for patterns like "2 rows" or mentions of row counts
      const rowCountMatch = result.summary.match(/(\d+)\s*rows?/i);
      const rowCount = rowCountMatch?.[1] ? parseInt(rowCountMatch[1], 10) : undefined;

      return { summary: result.summary, rowCount };
    } catch (error) {
      // Handler threw - return error in format FailureScorer expects
      const message = error instanceof Error ? error.message : String(error);
      return { summary: `Error: ${message}`, rowCount: 0 };
    }
  },

  scorers: [LLMJudge, RowCountScorer, FailureScorer],
});

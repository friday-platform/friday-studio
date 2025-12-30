import process from "node:process";
import type { Evalite } from "evalite";
import { evalite } from "evalite";
import { emailAgent } from "../../../packages/bundled-agents/src/email/communicator.ts";
import { formatDuration, getTraceDuration } from "../lib/columns.ts";
import { AgentContextAdapter } from "../lib/context.ts";
import { LLMJudge } from "../lib/llm-judge.ts";
import { loadCredentials } from "../lib/load-credentials.ts";

// Set up credentials once
await loadCredentials();
process.env.SENDGRID_SANDBOX_MODE = "true";

// Create adapter outside evalite for reuse
const adapter = new AgentContextAdapter();

// Output types for scorers
type RefusalOutput = { emailFailedCalled: boolean; error: string; executionTime: number };
type SenderValidationResult = { result: unknown; from: string; executionTime: number };

/**
 * Deterministic scorer: checks if the emailFailed tool was called
 */
const RefusalScorer: Evalite.ScorerOpts<{ prompt: string }, RefusalOutput, string> = {
  name: "emailFailed Tool Called",
  scorer: ({ output }) => (output.emailFailedCalled ? 1 : 0),
};

/**
 * Deterministic scorer: checks if sender email matches expected value
 */
const SenderScorer: Evalite.ScorerOpts<
  { prompt: string; expectedFrom: string },
  SenderValidationResult,
  string
> = {
  name: "Sender Email Matches",
  scorer: ({ output, input }) => (output.from === input.expectedFrom ? 1 : 0),
};

/**
 * Email Agent Eval - Refusal of Unfulfillable Requests
 *
 * Verifies the email agent refuses to send emails when the request
 * requires unavailable data (previous emails, external lookups).
 *
 * Related: TEM-3355
 */
evalite<{ prompt: string }, RefusalOutput, string>(
  "Email Agent - Refusal of Unfulfillable Requests",
  {
    data: [
      {
        input: {
          prompt:
            "Resend the email that was sent to ken@tempest.team to founders@tempest.team instead.",
        },
        expected: "emailFailedCalled=true",
      },
      {
        input: {
          prompt: "Forward the last message I received from john@example.com to team@company.com",
        },
        expected: "emailFailedCalled=true",
      },
      {
        input: {
          prompt: "Send the same pricing proposal we discussed earlier to clients@enterprise.com",
        },
        expected: "emailFailedCalled=true",
      },
      {
        input: {
          prompt:
            "Look up the latest stock price for AAPL and email a summary to investor@fund.com",
        },
        expected: "emailFailedCalled=true",
      },
    ],
    task: async (input) => {
      const { context } = adapter.createContext();
      const startTime = Date.now();

      try {
        await emailAgent.execute(input.prompt, context);
        const executionTime = (Date.now() - startTime) / 1000; // Convert to seconds
        return {
          emailFailedCalled: false,
          error: "Agent did not refuse - attempted to send email",
          executionTime,
        };
      } catch (error) {
        const executionTime = (Date.now() - startTime) / 1000; // Convert to seconds
        const errorMessage = error instanceof Error ? error.message : String(error);

        // emailFailed tool produces: "Cannot compose email: <reason>"
        // No tool called produces: "Cannot compose email: The agent did not produce a result"
        // Note: errors may be wrapped with "Agent email execution failed: " prefix
        const emailFailedCalled =
          errorMessage.includes("Cannot compose email:") &&
          !errorMessage.includes("did not produce a result");

        return { emailFailedCalled, error: errorMessage, executionTime };
      }
    },
    scorers: [RefusalScorer],
    columns: ({ input, output, traces }) => [
      { label: "Input", value: input },
      { label: "Output", value: output },
      { label: "Time", value: formatDuration(getTraceDuration(traces)) },
    ],
  },
);

/**
 * Email Agent Eval - Security: Reject Hallucinated Recipient
 *
 * Verifies the agent rejects emails when the LLM hallucinates a recipient
 * email address that doesn't exist in the prompt. Security validation should
 * catch this and throw an error containing "Security: Recipient email" and
 * "not found in prompt".
 */
evalite<{ prompt: string }, { error: string; executionTime: number }, string>(
  "Email Agent - Security: Reject Hallucinated Recipient",
  {
    data: [
      {
        input: {
          prompt:
            "Send an email with subject 'Project Update' saying: The project is on track and we'll deliver next week.",
        },
        expected: "The agent threw an error because no recipient was provided in the prompt.",
      },
    ],
    task: async (input) => {
      const { context } = adapter.createContext();
      const startTime = Date.now();

      try {
        await emailAgent.execute(input.prompt, context);
        const executionTime = (Date.now() - startTime) / 1000; // Convert to seconds
        return {
          error:
            "Agent did not reject - email was sent without security validation catching hallucinated recipient",
          executionTime,
        };
      } catch (error) {
        const executionTime = (Date.now() - startTime) / 1000; // Convert to seconds
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { error: errorMessage, executionTime };
      }
    },
    scorers: [
      {
        name: "LLMJudge",
        scorer: async ({ output, expected, input }) => {
          const result = await LLMJudge({ output: output.error, expected, input });
          return { ...result, score: result.score ?? 0 };
        },
      },
    ],
    columns: ({ input, output, traces }) => [
      { label: "Input", value: input },
      { label: "Output", value: output },
      { label: "Time", value: formatDuration(getTraceDuration(traces)) },
    ],
  },
);

/**
 * Email Agent Eval - Valid Composition
 *
 * Verifies the agent composes emails correctly for valid requests.
 * Uses sandbox mode - no actual emails are sent.
 */
evalite<{ prompt: string }, { result: unknown; executionTime: number }, string>(
  "Email Agent - Valid Composition",
  {
    data: [
      {
        input: {
          prompt:
            "Send an email to test@example.com with subject 'Hello' saying: Thanks for meeting with us yesterday. We look forward to next steps.",
        },
        expected:
          "The agent successfully composed and sent an email with the correct recipient, subject, and body content.",
      },
      {
        input: {
          prompt:
            "Send an email to sarah@company.com with subject 'Meeting Reminder' saying: Hi Sarah, reminder about our product review meeting tomorrow at 2pm.",
        },
        expected:
          "The agent successfully composed and sent an email with the correct recipient, subject, and body content.",
      },
      {
        input: {
          prompt: `Send an email to testuser@example-domain.test with subject "SONOFF Zigbee Bridge Pro - Daily Price Report" with the following pricing data:

Poland (Destination):
- Amazon.pl: PLN 129.99 → EUR 30.09 (€0.2315/PLN)
- x-kom.pl: PLN 139.99 → EUR 32.40 (€0.2315/PLN)
- Allegro.pl: PLN 135.00 → EUR 31.24 (€0.2315/PLN)

Portugal (Destination):
- Amazon.es: EUR 35.99
- PCComponentes.com: EUR 38.50
- Worten.pt: EUR 37.99

Format as a professional pricing report with clear sections for each country, showing currency conversions where applicable.`,
        },
        expected:
          "The agent successfully composed and sent an email with proper formatting of multi-currency pricing data (PLN, EUR, USD), structured sections for Poland and Portugal destinations, and professional email formatting suitable for a business pricing report.",
      },
      {
        input: {
          prompt: `Send an email to stakeholders@test-company.example with subject "Product Strategy Session - Key Takeaways" summarizing the following meeting notes:

PRODUCT STRATEGY SESSION - MARCH 2025
Attendees: Sarah Chen (CPO), Marcus Rodriguez (CTO), Lisa Zhang (VP Eng), David Kim (PM), Alex Torres (Design)

1. BUDGET & TIMELINE DISCUSSION
- Q2 engineering budget confirmed at $2.4M (12% increase from Q1)
- Additional $500k allocated for AI/ML infrastructure experiments
- Platform migration timeline: Phase 1 complete by May 15, Phase 2 by July 30
- Hiring: 4 senior engineers, 2 product designers, 1 technical writer (all approved)
- Cloud costs projected to increase 18% due to new data pipeline requirements

2. FEATURE PRIORITIZATION
- Mobile app redesign moved to P0 (customer feedback score dropped to 3.2/5)
- Real-time collaboration features delayed to Q3 (dependencies on platform migration)
- API rate limiting implementation brought forward to April (current abuse patterns detected)
- Search functionality overhaul: split into 2 phases (basic improvements in May, ML-powered in Q3)
- Dark mode support: approved for June release (high user demand, 847 votes)

3. TECHNICAL DEBT & INFRASTRUCTURE
- Database sharding plan finalized: begin migration April 1, complete by June 15
- Legacy authentication system sunset date: August 31 (3,200 remaining users to migrate)
- Monitoring system upgrade approved ($45k investment, reduces incident response time by 40%)
- API versioning strategy: v3 rollout begins May 1, v1 deprecated September 30
- Code coverage target raised from 65% to 75% by end of Q2

4. CUSTOMER IMPACT ANALYSIS
- Enterprise customer churn analysis shows 23% are affected by current mobile UX
- Top 3 customer pain points: slow search (mentioned 156 times), mobile bugs (89 times), export limitations (67 times)
- NPS score currently 42, target is 55 by Q3 end
- Customer advisory board meeting scheduled for April 22 to validate roadmap

5. COMPETITIVE LANDSCAPE
- Competitor A launched similar real-time features last month (2,000 signups in first week)
- Market research indicates our pricing is 15% higher for comparable features
- Strategic partnership opportunity with DataCorp (exploratory discussion phase, potential $1.2M revenue)
- Patent filing for our ML recommendation algorithm approved (filing deadline March 31)

6. TEAM & PROCESS IMPROVEMENTS
- Engineering velocity metrics show 28% improvement after adopting new sprint structure
- Design-eng collaboration framework pilot successful (will roll out company-wide)
- Technical documentation initiative: allocate 10% of eng time to docs (currently at 3%)
- On-call rotation restructure: move to follow-the-sun model starting May 1
- Quarterly hackathon approved: June 10-11 (budget $25k for prizes and events)

7. ACTION ITEMS
- Sarah: Finalize mobile redesign specs by March 25, share with design team
- Marcus: Complete infrastructure cost analysis for board presentation by March 28
- Lisa: Review and approve database sharding implementation plan by March 22
- David: Schedule customer interviews for top 10 enterprise accounts by April 5
- Alex: Present dark mode design mockups to stakeholders by March 30
- Marcus: Submit patent filing documents to legal by March 29
- Sarah: Organize April 22 customer advisory board meeting (send invites by March 18)
- Lisa: Develop Q2 hiring pipeline and start initial screens by March 31

Please ensure the email highlights the most critical points concisely - stakeholders need key decisions and action items, not a verbatim transcript of the meeting.`,
        },
        expected:
          "The agent composed a professional, concise summary email that SUMMARIZES the key decisions, budget allocations, and critical action items with owners and deadlines. The email should NOT copy-paste all meeting details but instead distill the information into digestible highlights focused on: major budget decisions (Q2 $2.4M budget, $500k AI allocation), priority shifts (mobile redesign to P0), key timelines (platform migration, database sharding), and specific action items with deadlines. The email should be professional and executive-ready, demonstrating the agent's ability to synthesize large context into actionable takeaways.",
      },
      {
        input: {
          prompt: `I need to send a weekly pricing analysis to my boss. Their boss is Michael Johnson at boss@test-company.example.

Subject: Weekly Pricing Analysis

Include these data points:
- Competitor X pricing: $299/month for premium tier
- Our current pricing: $249/month for premium tier
- Recommendation: Consider increasing our price to $279/month to improve margins while staying competitive`,
        },
        expected:
          "The agent successfully extracted the recipient email address (boss@test-company.example) from natural language context ('Their boss is Michael Johnson at boss@test-company.example'), composed an email with subject 'Weekly Pricing Analysis', and included all three pricing data points: competitor pricing ($299/month), our pricing ($249/month), and the recommendation to increase to $279/month. This tests the agent's ability to parse recipient information from conversational context rather than explicit 'send to' format.",
      },
    ],
    task: async (input) => {
      const { context } = adapter.createContext();
      const startTime = Date.now();
      const result = await emailAgent.execute(input.prompt, context);
      const executionTime = (Date.now() - startTime) / 1000; // Convert to seconds
      return { result, executionTime };
    },
    scorers: [
      {
        name: "LLMJudge",
        scorer: async ({ output, expected, input }) => {
          const result = await LLMJudge({ output: output.result, expected, input });
          return { ...result, score: result.score ?? 0 };
        },
      },
    ],
    columns: ({ input, output, traces }) => [
      { label: "Input", value: input },
      { label: "Output", value: output },
      { label: "Time", value: formatDuration(getTraceDuration(traces)) },
    ],
  },
);

/**
 * Email Agent Eval - Sender Validation
 *
 * Verifies sender validation security rules:
 * 1. No sender specified → use default (noreply@tempestdx.com or SENDGRID_FROM_EMAIL)
 * 2. Sender NOT inferred from recipient domain (critical security: prevents spoofing)
 * 3. Explicit sender in prompt → use that sender
 *
 * Test case 2 is critical for preventing email spoofing where the LLM might
 * hallucinate a sender address based on the recipient's domain.
 */
evalite<{ prompt: string; expectedFrom: string }, SenderValidationResult, string>(
  "Email Agent - Sender Validation",
  {
    data: [
      {
        input: {
          prompt:
            "Send an email to recipient@example.com with subject 'Test' saying: This is a test message.",
          expectedFrom: process.env.SENDGRID_FROM_EMAIL || "noreply@tempestdx.com",
        },
        expected: "No sender specified, should use default",
      },
      {
        input: {
          prompt:
            "Send an email to user@corporate.com with subject 'Update' saying: Here's your status update.",
          expectedFrom: process.env.SENDGRID_FROM_EMAIL || "noreply@tempestdx.com",
        },
        expected:
          "CRITICAL SECURITY: Sender should NOT be inferred from recipient domain (prevents spoofing)",
      },
      {
        input: {
          prompt:
            "Send an email from support@tempestdx.com to customer@business.com with subject 'Response' saying: Thank you for your inquiry.",
          expectedFrom: "support@tempestdx.com",
        },
        expected: "Explicit sender in prompt should be used",
      },
    ],
    task: async (input) => {
      const { context } = adapter.createContext();
      const startTime = Date.now();
      const result = await emailAgent.execute(input.prompt, context);
      const executionTime = (Date.now() - startTime) / 1000; // Convert to seconds

      // Extract sender email from result
      const from =
        typeof result === "object" &&
        result !== null &&
        "email" in result &&
        typeof result.email === "object" &&
        result.email !== null &&
        "from" in result.email
          ? String(result.email.from)
          : "unknown";

      return { result, from, executionTime };
    },
    scorers: [SenderScorer],
    columns: ({ input, output, traces }) => [
      { label: "Input", value: input },
      { label: "Output", value: output },
      { label: "Time", value: formatDuration(getTraceDuration(traces)) },
    ],
  },
);

// ============================================================================
// Recipient Domain Restrictions (TEM-3362)
// ============================================================================

/** Generate a mock JWT with specified email for testing. */
function generateMockJWT(email: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = btoa(JSON.stringify({ email, sub: "test", exp: now + 3600, iat: now }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.mock`;
}

// Output type for recipient restriction tests
type RecipientRestrictionOutput = {
  success: boolean;
  finalRecipient: string;
  error?: string;
  executionTime: number;
};

/**
 * Deterministic scorer: checks if final recipient matches expected
 */
const RecipientScorer: Evalite.ScorerOpts<
  { prompt: string; userEmail: string; expectedTo: string },
  RecipientRestrictionOutput,
  string
> = {
  name: "Recipient Matches Expected",
  scorer: ({ output, input }) => {
    if (!output.success) return 0;
    return output.finalRecipient.toLowerCase() === input.expectedTo.toLowerCase() ? 1 : 0;
  },
};

/**
 * Email Agent Eval - Recipient Domain Restrictions (Real Scenarios)
 *
 * Tests recipient validation with realistic natural language prompts.
 * These scenarios verify the full integration works end-to-end:
 * - Agent extracts recipient from natural language
 * - Validation applies domain restrictions
 * - Email is sent (or overridden) correctly
 *
 * Related: TEM-3362
 */
evalite<
  { prompt: string; userEmail: string; expectedTo: string },
  RecipientRestrictionOutput,
  string
>("Email Agent - Recipient Domain Restrictions", {
  data: [
    // Scenario 1: Company user sends project update to teammate (same domain - allowed)
    {
      input: {
        prompt:
          "Send Sarah a project update at sarah@tempest.team - let her know the Q4 launch is on track and we're hitting our milestones. Subject should be 'Q4 Launch Status Update'.",
        userEmail: "luke@tempest.team",
        expectedTo: "sarah@tempest.team",
      },
      expected: "Company user sending to teammate - recipient should be preserved",
    },
    // Scenario 2: Company user tries to contact external vendor (different domain - overridden)
    {
      input: {
        prompt:
          "I need to reach out to our vendor about the contract renewal. Send an email to support@acme-vendor.com asking about pricing for next year. Subject: 'Contract Renewal Inquiry'.",
        userEmail: "luke@tempest.team",
        expectedTo: "luke@tempest.team",
      },
      expected: "Company user emailing external vendor - silently overridden to self",
    },
    // Scenario 3: Personal email user trying to share with friend (public domain - overridden)
    {
      input: {
        prompt:
          "Forward this great article summary to my friend at john.doe@yahoo.com. Subject: 'Check out this article'. Content: Here's that article I mentioned about productivity tips.",
        userEmail: "jane@gmail.com",
        expectedTo: "jane@gmail.com",
      },
      expected: "Personal email user sharing externally - silently overridden to self",
    },
  ],
  task: async (input) => {
    // Set the mock ATLAS_KEY for this test
    const originalAtlasKey = process.env.ATLAS_KEY;
    process.env.ATLAS_KEY = generateMockJWT(input.userEmail);

    const { context } = adapter.createContext();
    const startTime = Date.now();

    try {
      const result = await emailAgent.execute(input.prompt, context);
      const executionTime = (Date.now() - startTime) / 1000;

      // Extract final recipient from result
      const finalRecipient =
        typeof result === "object" &&
        result !== null &&
        "email" in result &&
        typeof result.email === "object" &&
        result.email !== null &&
        "to" in result.email
          ? String(result.email.to)
          : "unknown";

      return { success: true, finalRecipient, executionTime };
    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, finalRecipient: "none", error: errorMessage, executionTime };
    } finally {
      // Restore original ATLAS_KEY
      if (originalAtlasKey) {
        process.env.ATLAS_KEY = originalAtlasKey;
      } else {
        delete process.env.ATLAS_KEY;
      }
    }
  },
  scorers: [RecipientScorer],
  columns: ({ input, output, traces }) => [
    { label: "User Email", value: input.userEmail },
    { label: "Requested To", value: input.prompt.match(/to (\S+@\S+)/i)?.[1] || "?" },
    { label: "Expected To", value: input.expectedTo },
    { label: "Final To", value: output.finalRecipient },
    { label: "Success", value: output.success },
    { label: "Time", value: formatDuration(getTraceDuration(traces)) },
  ],
});

/**
 * Email Agent Eval - Missing ATLAS_KEY
 *
 * Verifies that sending emails fails when ATLAS_KEY is not set.
 *
 * Related: TEM-3362
 */
evalite<{ prompt: string }, { error: string; executionTime: number }, string>(
  "Email Agent - Missing ATLAS_KEY Rejection",
  {
    data: [
      {
        input: {
          prompt:
            "Send an email to someone@example.com with subject 'Test' saying: This should fail without ATLAS_KEY.",
        },
        expected:
          "The agent threw an error because ATLAS_KEY is not set and user email cannot be determined.",
      },
    ],
    task: async (input) => {
      // Remove ATLAS_KEY for this test
      const originalAtlasKey = process.env.ATLAS_KEY;
      delete process.env.ATLAS_KEY;

      const { context } = adapter.createContext();
      const startTime = Date.now();

      try {
        await emailAgent.execute(input.prompt, context);
        const executionTime = (Date.now() - startTime) / 1000;
        return { error: "Agent did not reject - email was sent without ATLAS_KEY", executionTime };
      } catch (error) {
        const executionTime = (Date.now() - startTime) / 1000;
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { error: errorMessage, executionTime };
      } finally {
        // Restore original ATLAS_KEY
        if (originalAtlasKey) {
          process.env.ATLAS_KEY = originalAtlasKey;
        }
      }
    },
    scorers: [
      {
        name: "ATLAS_KEY Required Error",
        scorer: ({ output }) => {
          // Check if error message indicates ATLAS_KEY is required
          const hasRequiredError =
            output.error.includes("User email required") || output.error.includes("ATLAS_KEY");
          return hasRequiredError ? 1 : 0;
        },
      },
    ],
    columns: ({ input, output, traces }) => [
      { label: "Input", value: input },
      { label: "Error", value: output.error },
      { label: "Time", value: formatDuration(getTraceDuration(traces)) },
    ],
  },
);

import type { Evalite } from "evalite";
import { evalite } from "evalite";
import { emailAgent } from "../../../packages/bundled-agents/src/email/communicator.ts";
import { AgentContextAdapter } from "../lib/context.ts";
import { loadCredentials } from "../lib/load-credentials.ts";
import { setupFakeCredentials } from "../lib/setup-fake-credentials.ts";

// Set up credentials once
await loadCredentials();
setupFakeCredentials("all");

// Create adapter outside evalite for reuse
const adapter = new AgentContextAdapter();

// Output types for scorers
type RefusalOutput = { emailFailedCalled: boolean; error: string };
type CompositionOutput = { composedSuccessfully: boolean; failedAt: string };

/**
 * Deterministic scorer: checks if the emailFailed tool was called
 */
const RefusalScorer: Evalite.ScorerOpts<{ prompt: string }, RefusalOutput, string> = {
  name: "emailFailed Tool Called",
  scorer: ({ output }) => (output.emailFailedCalled ? 1 : 0),
};

/**
 * Deterministic scorer: checks if composition succeeded
 */
const CompositionScorer: Evalite.ScorerOpts<{ prompt: string }, CompositionOutput, string> = {
  name: "Composition Check",
  scorer: ({ output }) => (output.composedSuccessfully ? 1 : 0),
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
      const context = adapter.createContext();

      try {
        await emailAgent.execute(input.prompt, context);
        return {
          emailFailedCalled: false,
          error: "Agent did not refuse - attempted to send email",
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // emailFailed tool produces: "Cannot compose email: <reason>"
        // No tool called produces: "Cannot compose email: The agent did not produce a result"
        // Note: errors may be wrapped with "Agent email execution failed: " prefix
        const emailFailedCalled =
          errorMessage.includes("Cannot compose email:") &&
          !errorMessage.includes("did not produce a result");

        return { emailFailedCalled, error: errorMessage };
      }
    },
    scorers: [RefusalScorer],
  },
);

/**
 * Email Agent Eval - Valid Composition
 *
 * Verifies the agent composes emails correctly for valid requests.
 * Expected to fail at SendGrid API with fake credentials - composition success
 * is determined by reaching the send phase.
 */
evalite<{ prompt: string }, CompositionOutput, string>("Email Agent - Valid Composition", {
  data: [
    {
      input: {
        prompt:
          "Send an email to test@example.com with subject 'Hello' saying: Thanks for meeting with us yesterday. We look forward to next steps.",
      },
      expected: "composedSuccessfully=true",
    },
    {
      input: {
        prompt:
          "Send an email to sarah@company.com with subject 'Meeting Reminder' saying: Hi Sarah, reminder about our product review meeting tomorrow at 2pm.",
      },
      expected: "composedSuccessfully=true",
    },
  ],
  task: async (input) => {
    const context = adapter.createContext();

    try {
      await emailAgent.execute(input.prompt, context);
      return { composedSuccessfully: true, failedAt: "none" };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Composition failures
      if (errorMessage.includes("Cannot compose email")) {
        return { composedSuccessfully: false, failedAt: `composition: ${errorMessage}` };
      }
      if (errorMessage.includes("Security:")) {
        return { composedSuccessfully: false, failedAt: `security: ${errorMessage}` };
      }

      // SendGrid API failures mean composition succeeded
      const isSendFailure =
        errorMessage.includes("SendGrid") ||
        errorMessage.includes("Unauthorized") ||
        errorMessage.includes("401") ||
        errorMessage.includes("403") ||
        errorMessage.includes("Failed to send email");

      if (isSendFailure) {
        return { composedSuccessfully: true, failedAt: `send: ${errorMessage}` };
      }

      return { composedSuccessfully: false, failedAt: `unknown: ${errorMessage}` };
    }
  },
  scorers: [CompositionScorer],
});

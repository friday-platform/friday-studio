import type { WorkspacePlan } from "@atlas/core/artifacts";

export const githubPRWebhookPlan: WorkspacePlan = {
  workspace: {
    name: "pr-code-reviewer",
    purpose: "Automatically analyze pull requests for code quality issues and post review comments",
  },
  signals: [
    {
      id: "github-pr-webhook",
      name: "github_pr_webhook",

      title: "Receives GitHub PR events",

      signalType: "http",

      description: "Receives GitHub webhook events when new pull requests are opened",
    },
  ],
  agents: [
    {
      id: "pr-code-reviewer",
      name: "PR Code Reviewer",
      description:
        "Fetches PR diff from GitHub, analyzes code for quality issues (style violations, potential bugs, performance concerns, best practice violations), and posts structured review comment with findings",
      needs: ["github"],
      configuration: {},
    },
  ],
  jobs: [
    {
      id: "pr-code-quality-review",
      name: "PR Code Quality Review",
      title: "Review PR",
      triggerSignalId: "github-pr-webhook",
      steps: [
        {
          agentId: "pr-code-reviewer",
          description:
            "Fetch PR diff, analyze code for quality issues including style violations, potential bugs, performance concerns, and best practice violations, then post structured review comment",
        },
      ],
      behavior: "sequential",
    },
  ],
};

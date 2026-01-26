import type { WorkspacePlan } from "@atlas/core/artifacts";

export const githubCIPipelinePlan: WorkspacePlan = {
  workspace: {
    name: "GitHub CI Checks",
    purpose:
      "Automated quality checks on main branch pushes with parallel test, security, and dependency verification",
  },
  signals: [
    {
      id: "main-branch-push",
      name: "Main Branch Push",

      title: "Receives main branch pushes",

      signalType: "http",

      description:
        "GitHub webhook triggered when code is pushed to main branch on github.com/myorg/myrepo",
    },
  ],
  agents: [
    {
      id: "parallel-quality-checker",
      name: "Parallel Quality Checker",
      description:
        "Runs three quality checks in parallel: executes test suite with coverage metrics, scans for security vulnerabilities, and verifies dependency freshness. Returns structured results for all checks.",
      needs: ["github"],
      configuration: { repository: "github.com/myorg/myrepo" },
    },
    {
      id: "results-notifier",
      name: "Results Notifier",
      description:
        "Posts check results to Slack channel and adds summary comment to the triggering commit on GitHub. Formats results into clear pass/fail status with key metrics.",
      needs: ["slack", "github"],
      configuration: { slack_channel: "#ci-alerts", repository: "github.com/myorg/myrepo" },
    },
  ],
  jobs: [
    {
      id: "main-branch-quality-pipeline",
      name: "Main Branch Quality Pipeline",
      title: "Quality Pipeline",
      triggerSignalId: "main-branch-push",
      steps: [
        {
          agentId: "parallel-quality-checker",
          description:
            "Execute parallel quality checks: run test suite with coverage metrics, scan for security vulnerabilities, and verify dependency freshness",
        },
        {
          agentId: "results-notifier",
          description:
            "Post quality check results to Slack #ci-alerts channel and add summary comment to the triggering commit on GitHub",
        },
      ],
      behavior: "sequential",
    },
  ],
};

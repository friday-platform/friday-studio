import type { WorkspacePlan } from "@atlas/core/artifacts";

export const customerSupportTriagePlan: WorkspacePlan = {
  workspace: {
    name: "zendesk-support-automation",
    purpose:
      "Automatically categorize incoming support tickets, provide solution suggestions for technical issues, flag urgent billing cases, and notify the team",
  },
  signals: [
    {
      id: "new-zendesk-ticket",
      name: "new-zendesk-ticket",
      description: "Triggers when a new support ticket is created in Zendesk via webhook",
    },
  ],
  agents: [
    {
      id: "ticket-analyzer",
      name: "ticket-analyzer",
      description:
        "Analyzes ticket content and categorizes into billing, technical, feature request, or other. For technical issues, searches documentation for known solutions. For billing issues, marks as urgent. Returns structured categorization and solution suggestions.",
      needs: ["zendesk"],
      configuration: {},
    },
    {
      id: "support-notifier",
      name: "support-notifier",
      description: "Sends formatted summary of ticket categorization and actions to Slack channel",
      needs: ["slack"],
      configuration: { channel: "#support-triage" },
    },
  ],
  jobs: [
    {
      id: "zendesk-ticket-triage-and-notification",
      name: "Zendesk Ticket Triage and Notification",
      triggerSignalId: "new-zendesk-ticket",
      steps: [
        {
          agentId: "ticket-analyzer",
          description:
            "Analyze and categorize the new ticket, search for solutions for technical issues, and flag billing issues as urgent",
        },
        {
          agentId: "support-notifier",
          description:
            "Send categorization summary and suggested actions to Slack #support-triage channel",
        },
      ],
      behavior: "sequential",
    },
  ],
};

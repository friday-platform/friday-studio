import type { WorkspacePlan } from "@atlas/core/artifacts";

export const investorBriefingPlan: WorkspacePlan = {
  workspace: {
    name: "Daily Meeting Briefing",
    purpose:
      "Automated daily briefing that researches companies and founders for upcoming meetings and delivers via email",
  },
  signals: [
    {
      id: "morning-briefing-trigger",
      name: "Morning Briefing Trigger",
      description:
        "Fires daily at 8:00 AM PST, including weekends, to initiate the briefing workflow",
    },
  ],
  agents: [
    {
      id: "calendar-reader",
      name: "Calendar Reader",
      description:
        "Connects to Google Calendar and extracts today's meeting events, identifying companies to research",
      needs: ["google-calendar"],
      configuration: {},
    },
    {
      id: "company-intelligence-researcher",
      name: "Company Intelligence Researcher",
      description:
        "For each company, researches business model, funding stage, key metrics, and founding team backgrounds. Handles all research work as a cohesive task since company data and founder information are naturally related and overlap in sources",
      needs: ["research"],
      configuration: {},
    },
    {
      id: "briefing-composer",
      name: "Briefing Composer",
      description:
        "Compiles calendar events and research findings into a structured email briefing and sends to recipient",
      needs: ["email"],
      configuration: { recipient: "vc@example.com" },
    },
  ],
  jobs: [
    {
      id: "daily-morning-briefing",
      name: "Daily Morning Briefing",
      triggerSignalId: "morning-briefing-trigger",
      steps: [
        {
          agentId: "calendar-reader",
          description:
            "Extract today's meeting events from Google Calendar and identify companies to research",
        },
        {
          agentId: "company-intelligence-researcher",
          description:
            "Research each company's business model, funding stage, key metrics, and founding team backgrounds",
        },
        {
          agentId: "briefing-composer",
          description:
            "Compile calendar events and research findings into a structured email briefing and send to vc@example.com",
        },
      ],
      behavior: "sequential",
    },
  ],
};

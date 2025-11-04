import type { WorkspacePlan } from "@atlas/core/artifacts";

/**
 * EXACT workspace plan from Yena's hallucination session (Oct 14, 2025).
 * This plan led to fabricated professional backgrounds because it used a single
 * LLM agent (Haiku) with a vague prompt instead of proper research agents.
 *
 * This is a regression test to ensure workspace creation detects and fixes
 * hallucination-prone agent configurations.
 */
export const linkedinProspectResearchPlan: WorkspacePlan = {
  workspace: {
    name: "Daily Outreach Prospect System",
    purpose:
      "Automates daily prospect research and relationship-building by reading a CSV file of contacts, filtering for companies with 50+ employees, randomly selecting 3 people each weekday, and sending comprehensive briefing emails. Each email includes the prospect's details from the CSV, company summary, personal insights, and relationship-nurturing message ideas focused on future partnerships rather than direct sales. This eliminates manual research time and ensures consistent daily prospecting activity.",
  },
  signals: [
    {
      id: "weekday-morning-trigger",
      name: "Weekday Morning Trigger",
      description:
        "Fires every weekday morning at 8 AM to initiate the daily prospect selection and research process. Weekday-only schedule ensures emails arrive during business hours and aligns with professional outreach cadence.",
    },
  ],
  agents: [
    {
      id: "prospect-researcher",
      name: "Prospect Researcher",
      description:
        "Reads CSV file of contacts, filters for companies with 50+ employees, randomly selects 3 people, researches each prospect and their company, generates company summaries and person insights, creates relationship-nurturing message ideas focused on future partnerships.",
      needs: ["research"],
      configuration: {
        csvPath: "/Users/yenaoh/Downloads/Connections.csv",
        companySize: "50+",
        dailyProspects: 3,
      },
    },
    {
      id: "briefing-emailer",
      name: "Briefing Emailer",
      description:
        "Sends detailed briefing emails with prospect research, company summaries, insights, and message ideas formatted for the recipient.",
      needs: ["email"],
      configuration: { emailRecipient: "yena@tempest.team" },
    },
  ],
  jobs: [
    {
      id: "daily-prospect-research-and-email-briefing",
      name: "Daily Prospect Research and Email Briefing",
      triggerSignalId: "weekday-morning-trigger",
      steps: [
        {
          agentId: "prospect-researcher",
          description:
            "Filter CSV for 50+ employee companies, randomly select 3 prospects, research each person and company, generate insights and nurturing message ideas",
        },
        {
          agentId: "briefing-emailer",
          description:
            "Send comprehensive briefing email with all research findings to yena@tempest.team",
        },
      ],
      behavior: "sequential",
    },
  ],
};

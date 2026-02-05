<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { getServiceIcon } from "$lib/modules/integrations/icons.svelte";

  type UseCase = {
    title: string;
    summary: string;
    prompt: string;
    integrations: string[];
    category: "productivity" | "research" | "development" | "analysis" | "monitor";
  };

  let { onclick }: { onclick: (item: UseCase) => void } = $props();

  let useCases: UseCase[] = [
    {
      title: "Create Linear tickets from your meeting notes",
      summary: "Turn raw meeting notes into tickets with owners and next steps.",
      prompt:
        "From my meeting notes in Notion, create Linear tickets with a title, description, owner, and priority.",
      integrations: ["linear", "notion"],
      category: "development",
    },
    {
      title: "Send email reminders",
      summary: "Follow up automatically if someone has not replied after a set amount of time.",
      prompt:
        "If someone does not reply to this email in my Gmail within 3 business days, remind me on Slack and draft a polite follow-up.",
      integrations: ["google-gmail", "slack"],
      category: "productivity",
    },
    {
      title: "Upload a data set and conduct analysis via chat",
      summary: "Upload a dataset once, then explore it over time by asking questions.",
      prompt:
        "I'm going to share a dataset via Google Sheets. Remember it and answer my questions about trends, breakdowns, and specific rows as I ask them.",
      integrations: ["google-sheets"],
      category: "analysis",
    },
    {
      title: "Research brief on meeting attendees",
      summary: "Prepare briefs on the company and attendees of upcoming meetings.",
      prompt:
        "For any external meetings, research each company and attendee, then send me a briefing the morning of each meeting.",
      integrations: ["google-gmail", "google-calendar"],
      category: "research",
    },
    {
      title: "Error trend summary",
      summary: "Surface patterns and the most frequent errors in Sentry.",
      prompt:
        "Send me a weekly summary via Slack of the most frequent errors and any trends, including what's improved or what's gotten worse.",
      integrations: ["sentry", "slack"],
      category: "monitor",
    },
    {
      title: "Summarize AI related news for the day",
      summary: "Get a daily digest of relevant AI-related news, curated to your interests.",
      prompt:
        "Every weekday morning, send me a concise summary of the most important tech and AI news.",
      integrations: ["google-gmail"],
      category: "research",
    },
    {
      title: "Write release notes based on PRs",
      summary: "Generate clear, user-friendly release notes from merged pull requests.",
      prompt:
        "Look at all PRs merged this week and generate release notes grouped by features, improvements, and fixes. Save them to Notion.",
      integrations: ["github", "notion"],
      category: "development",
    },
    {
      title: "Competitor briefing",
      summary: "Get up to date on information competitor news",
      prompt:
        "Every week, send me a summary of the latest news on a short list of competitors. Make sure to link the source.",
      integrations: ["google-gmail"],
      category: "research",
    },
    {
      title: "Distribute meeting notes and next steps",
      summary: "Summarize meeting notes with action items, then share them with your team.",
      prompt:
        "Summarize meeting notes in Notion, outline next steps, and post the summary in a Slack channel.",
      integrations: ["slack", "notion"],
      category: "productivity",
    },
    {
      title: "Daily stock updates",
      summary: "Get a daily snapshot of your stock performance.",
      prompt:
        "Every weekday, send me a daily update on the stocks I'm tracking, including major changes and notable news.",
      integrations: ["google-gmail"],
      category: "monitor",
    },
    {
      title: "Week over week performance tracking",
      summary: "Track multiple data sets to understand how performance is trending.",
      prompt:
        "Compare this week's data set to last week data set and summarize the major trends and takeaways.",
      integrations: ["google-sheets"],
      category: "analysis",
    },
    {
      title: "Keyword or brand mentions",
      summary: "Get updates when your brand or product is mentioned online.",
      prompt: "Every day, monitor the web for mentions of our brand and send me a daily summary.",
      integrations: ["google-gmail"],
      category: "monitor",
    },
    {
      title: "Weekly standup summary",
      summary: "Generates a clear weekly standup update based on the work you shipped.",
      prompt:
        "Create a weekly standup summary from my GitHub commits in the last 24 hours and save to Notion.",
      integrations: ["github", "notion"],
      category: "development",
    },
    {
      title: "Email inbox summary",
      summary: "Get a daily overview of your inbox that highlight anything most pressing.",
      prompt:
        "Summarize my unread emails in the last 24 hours and send it to me in a Slack channel every morning. Call out any that seem important or urgent.",
      integrations: ["google-gmail", "slack"],
      category: "productivity",
    },
    {
      title: "Survey response analysis",
      summary: "Take survey responses and glean themes, patterns, and insights.",
      prompt:
        "Analyze survey responses in Google Sheets, group them by theme, and summarize the top insights and patterns in a Google Doc.",
      integrations: ["google-sheets", "google-docs"],
      category: "analysis",
    },
  ];
</script>

<section>
  <div>
    {#each useCases as item (item.title)}
      <button
        onclick={() => {
          trackEvent(GA4.USE_CASE_SELECTED, { title: item.title });

          onclick(item);
        }}
      >
        <article>
          <span>{item.category}</span>
          <h2>
            {item.title}
          </h2>

          <p>{item.summary}</p>

          <footer>
            {#each item.integrations as integration (integration)}
              {@const icon = getServiceIcon(integration)}
              {#if icon}
                {#if icon.type === "component"}
                  {@const Component = icon.src}
                  <Component />
                {:else}
                  <img src={icon.src} alt={`${integration} logo`} />
                {/if}
              {/if}
            {/each}
          </footer>
        </article>
      </button>
    {/each}
  </div>
</section>

<style>
  section {
    overflow: visible;
  }

  div {
    break-inside: avoid;
    column-count: 1;
    column-gap: 0;
    margin-inline: auto;
    max-inline-size: var(--size-216);
    overflow: visible;

    @media (min-width: 640px) {
      column-count: 2;
    }

    @media (min-width: 768px) {
      column-count: 3;
    }
  }

  button {
    display: block;
    inline-size: 100%;
  }

  article {
    background-color: var(--color-highlight-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    margin: var(--size-2-5);
    padding: var(--size-4);
    transition: all 200ms ease;
    text-align: left;

    span {
      font-size: var(--font-size-1);
      font-weight: var(--font-weight-4-5);
      opacity: 0.5;
      text-transform: capitalize;
    }

    h2 {
      font-size: var(--font-size-3);
      font-weight: var(--font-weight-5);
      line-height: var(--font-lineheight-1);
      padding-block: var(--size-1);
      text-wrap-style: balance;
    }

    p {
      font-size: var(--font-size-2);
      line-height: var(--font-lineheight-2);
      opacity: 0.8;
    }

    footer {
      display: flex;
      gap: var(--size-2);
      margin-block-start: var(--size-3);

      & :global(svg),
      img {
        aspect-ratio: 1 / 1;
        object-fit: contain;
        inline-size: var(--size-4);
      }
    }
  }

  button:hover article {
    background-color: color-mix(in srgb, var(--color-highlight-1), var(--accent-2) 4%);
  }
</style>

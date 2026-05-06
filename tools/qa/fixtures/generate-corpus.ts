#!/usr/bin/env -S deno run --allow-write --allow-read

/**
 * Generates 50 fake-email markdown fixtures into ./inbox-corpus/.
 * Deterministic — same output each run. Sized to roughly match
 * the original auto-triage 50-email scenario (~600 char body each,
 * ~30KB total) so the QA fan-in metric is comparable to the
 * production baseline.
 *
 * Run from the worktree root:
 *   deno run --allow-write --allow-read tools/qa/fixtures/generate-corpus.ts
 */

import { dirname, fromFileUrl, join } from "jsr:@std/path";

const TONES = ["newsletter", "work-thread", "vendor-ping", "calendar", "alert", "social"] as const;

const FROMS: Record<(typeof TONES)[number], string[]> = {
  newsletter: [
    "digest@morningbrew.example",
    "weekly@hackernewsletter.example",
    "team@stratechery.example",
  ],
  "work-thread": ["alex@acme-corp.example", "priya@acme-corp.example", "sam@acme-corp.example"],
  "vendor-ping": ["billing@stripe.example", "noreply@cloudflare.example", "support@vercel.example"],
  calendar: ["calendar-noreply@google.example"],
  alert: ["security@github.example", "alerts@datadoghq.example"],
  social: ["notify@linkedin.example", "info@meetup.example"],
};

const SUBJECT_TEMPLATES: Record<(typeof TONES)[number], string[]> = {
  newsletter: [
    "Issue #{n}: 5 reads we curated this week",
    "Weekly digest — top stories you missed",
    "Your Tuesday briefing: what's moving the markets",
  ],
  "work-thread": [
    "Re: Q3 OKR draft — feedback by EOD?",
    "Standup notes from yesterday + blockers",
    "Heads up: incident postmortem at 2pm",
  ],
  "vendor-ping": [
    "Your invoice for {month} is ready",
    "Action required: update payment method",
    "We've shipped your order #{n}",
  ],
  calendar: [
    "Invitation: Weekly 1:1 @ {month} {day}",
    "Cancelled: Sprint planning",
    "Reminder: Doctor appointment tomorrow",
  ],
  alert: [
    "[GitHub] New security advisory affecting your dependencies",
    "[Datadog] CPU on prod-api-7 exceeded 85% for 10m",
    "Suspicious sign-in attempt detected",
  ],
  social: [
    "{name} sent you a connection request",
    "3 events near you this week",
    "Your post got 47 reactions",
  ],
};

const BODY_PARAGRAPHS: Record<(typeof TONES)[number], string[][]> = {
  newsletter: [
    [
      "We sifted through 200+ articles this week so you don't have to. The headliner is a deep dive into how mid-market SaaS is rethinking ARR vs. NRR after the latest round of public-market repricing.",
      "Three reads we'd flag as essential: (1) the State of AI Agents 2026 report from Sequoia, which finally puts a number on agent-as-a-service revenue; (2) a thoughtful piece on retrieval architecture in long-running tool loops; (3) a counterintuitive take on why founder-mode is overrated for hardware companies.",
      "If you only have time for one, make it the agents report — page 14 onward has the segmentation we've been waiting for. Reply to this email with feedback; we read everything.",
    ],
    [
      "This week's edition is shorter than usual because most of the team is at re:Invent. Quick hits: enterprise AI budgets are ballooning, edge inference is finally cheap enough to matter, and the open-source vs. proprietary model gap is closing on most benchmarks.",
      "We're piloting a new section called 'tool of the week' next issue. Drop your favorite dev tools in the form linked at the bottom and we'll feature the best ones.",
    ],
  ],
  "work-thread": [
    [
      "Hey team — circling back on the Q3 OKR draft I shared last Friday. I haven't heard from a few of you and we promised legal a final by tomorrow EOD.",
      "Specifically I need eyes on objective #2 (the platform reliability one) and the key results under it. The current numbers feel ambitious; are we comfortable committing to four-nines on the public API given last quarter's incident rate?",
      "Happy to jump on a call if it's easier than async. Otherwise just drop comments in the doc by 5pm Pacific.",
    ],
    [
      "Quick recap of standup since a few people were out: backend is unblocked on the gateway migration; frontend is waiting on the design review for the new flows (Priya, can you confirm timing?); and ops flagged a slow-leaking memory issue on prod-worker-3 that they're investigating.",
      "Action items: I'll book a postmortem slot for the incident from yesterday; Sam's drafting the comms; and we should plan to reduce on-call load next sprint — three pages overnight is too many.",
    ],
  ],
  "vendor-ping": [
    [
      "Hi there — your invoice for the previous billing cycle is now available. The amount due reflects standard usage; no overage adjustments this period.",
      "If you have any questions about the line items, reply to this email or open a ticket from the dashboard. Payment will be auto-collected from the card on file in 3 business days unless you let us know otherwise.",
      "As always, thanks for being a customer. We've shipped a number of platform improvements this month — a quick changelog is linked at the bottom.",
    ],
    [
      "We noticed your card on file is set to expire next month. To avoid any service interruption, please update the payment method in your billing settings before the next cycle closes.",
      "This is an automated reminder. If your card has already been updated and you're seeing this in error, you can safely ignore it.",
    ],
  ],
  calendar: [
    [
      "You've been invited to a recurring weekly 1:1 meeting. Click the link to accept, decline, or propose a new time. Recurrence: every Tuesday at 10:00 AM Pacific until end of quarter.",
      "Agenda items can be added to the linked doc. Please review last week's notes before joining.",
    ],
    [
      "The sprint planning meeting originally scheduled for tomorrow has been cancelled. We'll consolidate planning into Wednesday's larger team sync; expect a separate invite shortly.",
    ],
  ],
  alert: [
    [
      "A new high-severity security advisory was published affecting one of your project's transitive dependencies. The vulnerability allows for remote code execution under specific conditions detailed in the linked CVE.",
      "Recommended action: bump the affected package to the patched version. Dependabot has already opened a PR for review; merge as soon as your CI is green.",
    ],
    [
      "The CPU utilization metric for the host prod-api-7 has exceeded 85% for the past 10 minutes. The current value is 91%. This is a P3 alert — investigate when convenient.",
      "Common causes: traffic spike, runaway query, or a leaking process. Check the runbook for triage steps.",
    ],
  ],
  social: [
    [
      "A second-degree connection from a mutual company sent you an invitation to connect. They left a note: 'Saw your post on agent architectures — would love to compare notes.'",
      "You can accept, decline, or message them directly from the platform.",
    ],
    [
      "Three events are happening near you in the next 7 days that match your interests. Two are technical talks and one is a casual founder mixer. RSVP from the app to confirm a spot.",
    ],
  ],
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const NAMES = ["Alex", "Priya", "Sam", "Jordan", "Morgan", "Taylor", "Riley", "Casey"];

// Deterministic PRNG (Mulberry32) so corpus is stable across runs.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  const item = arr[Math.floor(rng() * arr.length)];
  if (item === undefined) throw new Error("pick(): empty array");
  return item;
}

function fillTemplate(rng: () => number, tpl: string, n: number): string {
  return tpl
    .replaceAll("{n}", String(n + 100))
    .replaceAll("{month}", pick(rng, MONTHS))
    .replaceAll("{day}", String(Math.floor(rng() * 28) + 1))
    .replaceAll("{name}", pick(rng, NAMES));
}

const rng = mulberry32(42);

const outDir = join(dirname(fromFileUrl(import.meta.url)), "inbox-corpus");

let totalBytes = 0;
for (let i = 1; i <= 50; i++) {
  const tone = pick(rng, TONES);
  const from = pick(rng, FROMS[tone]);
  const subjectTpl = pick(rng, SUBJECT_TEMPLATES[tone]);
  const subject = fillTemplate(rng, subjectTpl, i);
  const paragraphs = pick(rng, BODY_PARAGRAPHS[tone]);
  const body = paragraphs.join("\n\n");
  const date = `2026-04-${String((i % 28) + 1).padStart(2, "0")}T${String(8 + (i % 12)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}:00Z`;
  const labels =
    tone === "alert" || i % 5 === 0 ? ["unread", "inbox", "important"] : ["unread", "inbox"];

  const md = [
    "---",
    `from: ${from}`,
    `subject: "${subject.replace(/"/g, "'")}"`,
    `date: ${date}`,
    `labels: [${labels.map((l) => JSON.stringify(l)).join(", ")}]`,
    `tone: ${tone}`,
    "---",
    "",
    body,
    "",
  ].join("\n");

  const path = join(outDir, `email-${String(i).padStart(3, "0")}.md`);
  Deno.writeTextFileSync(path, md);
  totalBytes += new TextEncoder().encode(md).length;
}

console.log(
  `Wrote 50 emails to ${outDir} (${totalBytes} bytes total, avg ${Math.round(totalBytes / 50)} per file)`,
);

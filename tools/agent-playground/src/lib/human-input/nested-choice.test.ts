import { describe, expect, it } from "vitest";
import {
  buildGroupedOptionAnswer,
  buildNestedChoiceAnswer,
  formatChoiceComments,
  parseGroupedOptionPrompt,
  parseNestedChoicePrompt,
} from "./nested-choice.ts";

const inboxPrompt = `Here are your 2 unread emails, Mr. Ken:

\`\`\`
[1] From: Stripe <notifications@stripe.com>
    Subject: Your receipt from Gather Presence
    Date: May 7, 2026
    Preview: $90.00 paid — Monthly Subscription
    ─────────────────────────────
    Actions: (A)rchive  (K)eep  (U)nread  (D)elete

[2] From: Gunderson Dettmer Events <events@gunder.com>
    Subject: Reminder to Register: Community 5K Run/1 Mile Walk
    Date: May 7, 2026
    Preview: AAPI Heritage Month event
    ─────────────────────────────
    Actions: (A)rchive  (K)eep  (U)nread  (D)elete  (S)ubscribe
\`\`\`

Enter choices as: \`1=A 2=K 3=D ...\` (press Enter when done)`;

const groupedQuestion = `Review your inbox — select an action for each email:

[1] From: Joe Marconato (via Google Docs) | Document shared with you: "Hackathon Projects" | Thu May 7
    I've shared an item with you: Hackathon Projects — it's stored online. Click the link to open it.

[2] From: Medium | Eric Skram sent a draft to Friday AI for review | Thu May 7
    Eric Skram submitted a draft to Friday AI and is waiting for you to review it.`;

const groupedOptions = [
  {
    label: '[1] Archive — "Hackathon Projects" Google Doc share',
    value: "1:archive",
  },
  {
    label: '[1] Keep — "Hackathon Projects" Google Doc share',
    value: "1:keep",
  },
  {
    label: '[1] Delete — "Hackathon Projects" Google Doc share',
    value: "1:delete",
  },
  {
    label: "[2] Archive — Eric Skram draft submitted to Friday AI",
    value: "2:archive",
  },
  {
    label: "[2] Keep — Eric Skram draft submitted to Friday AI",
    value: "2:keep",
  },
  {
    label: "[2] Delete — Eric Skram draft submitted to Friday AI",
    value: "2:delete",
  },
];

describe("nested HITL choice prompt parsing", () => {
  it("extracts repeated numbered items with per-item actions", () => {
    const parsed = parseNestedChoicePrompt(inboxPrompt);

    expect(parsed?.intro).toBe("Here are your 2 unread emails, Mr. Ken:");
    expect(parsed?.items).toHaveLength(2);
    expect(parsed?.items[0]).toMatchObject({
      index: 1,
      title: "Your receipt from Gather Presence",
      detail: expect.stringContaining("Stripe"),
      actions: [
        { value: "A", label: "Archive" },
        { value: "K", label: "Keep" },
        { value: "U", label: "Unread" },
        { value: "D", label: "Delete" },
      ],
    });
    expect(parsed?.items[1]?.actions.at(-1)).toEqual({
      value: "S",
      label: "Subscribe",
    });
    expect(parsed?.instructions).toContain("Enter choices as");
  });

  it("groups flat request_human_input options by numbered item", () => {
    const parsed = parseGroupedOptionPrompt(groupedQuestion, groupedOptions);

    expect(parsed?.intro).toBe(
      "Review your inbox — select an action for each email:",
    );
    expect(parsed?.items).toHaveLength(2);
    expect(parsed?.items[0]).toMatchObject({
      index: 1,
      title: '"Hackathon Projects" Google Doc share',
      detail: expect.stringContaining("Joe Marconato"),
      actions: [
        { label: "Archive", value: "1:archive" },
        { label: "Keep", value: "1:keep" },
        { label: "Delete", value: "1:delete" },
      ],
    });
    expect(parsed?.items[1]?.title).toBe(
      "Eric Skram draft submitted to Friday AI",
    );
  });

  it("does not group ordinary flat options", () => {
    expect(
      parseGroupedOptionPrompt("Pick one", [
        { label: "Archive", value: "archive" },
        { label: "Keep", value: "keep" },
      ]),
    ).toBeNull();
  });

  it("ignores ordinary free-form questions", () => {
    expect(parseNestedChoicePrompt("What label should I apply?")).toBeNull();
  });

  it("serializes selected nested choices in the format requested by the agent", () => {
    expect(buildNestedChoiceAnswer({ "2": "K", "1": "A", "3": "" })).toBe(
      "1=A 2=K",
    );
  });

  it("serializes grouped option choices as a JSON array of original option values", () => {
    expect(
      buildGroupedOptionAnswer({ "2": "2:keep", "1": "1:archive", "3": "" }),
    ).toBe(
      '["1:archive","2:keep"]',
    );
  });

  it("formats per-choice-set comments for the note field", () => {
    expect(
      formatChoiceComments({
        "2": "needs a reply",
        "1": "",
        "10": "looks stale",
      }),
    )
      .toBe("[2] needs a reply\n[10] looks stale");
  });
});

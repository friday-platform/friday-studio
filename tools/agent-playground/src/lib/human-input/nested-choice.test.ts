import { describe, expect, it } from "vitest";
import {
  buildNestedChoiceAnswer,
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

  it("ignores ordinary free-form questions", () => {
    expect(parseNestedChoicePrompt("What label should I apply?")).toBeNull();
  });

  it("serializes selected nested choices in the format requested by the agent", () => {
    expect(buildNestedChoiceAnswer({ "2": "K", "1": "A", "3": "" })).toBe(
      "1=A 2=K",
    );
  });
});

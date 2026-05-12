import { describe, expect, it } from "vitest";
import {
  connectCommunicatorSucceeded,
  connectServiceSucceeded,
  delegateAnsweredUser,
} from "./stop-conditions.ts";

// `StopCondition<TOOLS>` from the AI SDK consumes the latest step batch.
// We pass minimal step shapes — the predicates only read `step.toolResults`.
function makeSteps(
  toolResults: Array<{ toolName: string; output: Record<string, unknown> }>,
): Parameters<ReturnType<typeof connectServiceSucceeded>>[0] {
  // deno-lint-ignore no-explicit-any
  return { steps: [{ toolResults }] } as any;
}

describe("delegateAnsweredUser", () => {
  it("fires when a delegate call returned a lifted-marker answer", () => {
    const predicate = delegateAnsweredUser();
    const fired = predicate(
      makeSteps([
        {
          toolName: "delegate",
          output: {
            ok: true,
            answer:
              "[attachment lifted to artifact abc-123 (17 KB, text/plain, from pre-model/delegate) — use display_artifact or get_artifact to read]",
          },
        },
      ]),
    );
    expect(fired).toBe(true);
  });

  it("does not fire on a short inline answer (lift didn't trigger)", () => {
    const predicate = delegateAnsweredUser();
    const fired = predicate(
      makeSteps([
        { toolName: "delegate", output: { ok: true, answer: "The user has 3 unread messages." } },
      ]),
    );
    expect(fired).toBe(false);
  });

  it("does not fire on a failed delegate call", () => {
    const predicate = delegateAnsweredUser();
    const fired = predicate(
      makeSteps([
        { toolName: "delegate", output: { ok: false, reason: "MCP server unavailable" } },
      ]),
    );
    expect(fired).toBe(false);
  });

  it("does not fire when the marker shape comes from a non-delegate tool", () => {
    const predicate = delegateAnsweredUser();
    const fired = predicate(
      makeSteps([
        {
          toolName: "get_artifact",
          output: {
            ok: true,
            answer:
              "[attachment lifted to artifact xyz-999 (10 KB, text/plain, from pre-model/delegate) — use display_artifact or get_artifact to read]",
          },
        },
      ]),
    );
    expect(fired).toBe(false);
  });
});

describe("connectServiceSucceeded — regression guard", () => {
  it("fires on a successful connect_service result and ignores delegate marker outputs", () => {
    const predicate = connectServiceSucceeded();
    expect(
      predicate(makeSteps([{ toolName: "connect_service", output: { provider: "gmail" } }])),
    ).toBe(true);
    expect(
      predicate(
        makeSteps([
          {
            toolName: "delegate",
            output: {
              ok: true,
              answer:
                "[attachment lifted to artifact abc (1 KB, text/plain, from pre-model/delegate) — use display_artifact or get_artifact to read]",
            },
          },
        ]),
      ),
    ).toBe(false);
  });
});

describe("connectCommunicatorSucceeded — regression guard", () => {
  it("fires on a successful connect_communicator result", () => {
    const predicate = connectCommunicatorSucceeded();
    expect(
      predicate(makeSteps([{ toolName: "connect_communicator", output: { kind: "slack" } }])),
    ).toBe(true);
  });
});

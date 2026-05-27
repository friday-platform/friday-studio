/**
 * SSR tests for `session-results.svelte`.
 *
 * Scope mirrors what the FSM session reducer at
 * `packages/core/src/session/session-reducer.ts:90` actually produces:
 *   - `{ response, data? }` from Agent SDK `complete({ response, data })`
 *   - `{ text }`            from workspace-chat / "unknown" agent
 *   - anything else         falls back to JsonHighlight
 *
 * Bare-string and `{error}` shapes are NOT exercised here — the reducer
 * doesn't emit either into the `results` map (errors flow through
 * `query.data.error` on the parent page, which is a separate branch).
 *
 * Render-only assertions via `svelte/server` — no DOM event simulation.
 * `markdownToHTMLSafe` uses `isomorphic-dompurify` which transparently
 * spins up jsdom in Node, so the rendered markdown HTML lands in the
 * SSR body.
 */

import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import SessionResults from "./session-results.svelte";

describe("session-results", () => {
  it("renders nothing when the results map is empty", () => {
    const { body } = render(SessionResults, { props: { results: {} } });
    expect(body).not.toContain("result-block");
    expect(body).not.toContain('class="results"');
  });

  it("`{text}` envelope renders the markdown body — the dominant chat-tool shape", () => {
    // This is what handle-chat / workspace-chat sessions emit. Real-world
    // QA on a live daemon (melted_onion/b459e082) caught that the first
    // cut of this component missed the `{text}` branch and dumped this
    // shape back into JsonHighlight — the exact regression to lock here.
    const { body } = render(SessionResults, {
      props: {
        results: {
          unknown: {
            text: "# Done\n\nThe assistant **finished** the task.\n\n- step one\n- step two",
          },
        },
      },
    });
    expect(body).toContain("<h1");
    expect(body).toContain("Done</h1>");
    expect(body).toContain("<strong>finished</strong>");
    expect(body).toContain("step one");
    expect(body).toContain("step two");
    // Crucially: no escaped newlines, no JSON-shaped `"text": "..."`.
    expect(body).not.toContain("\\n\\n");
    expect(body).not.toMatch(/"text"\s*:/);
  });

  it("`{response, data}` renders response as markdown and data as JSON", () => {
    const { body } = render(SessionResults, {
      props: {
        results: {
          agent_one: {
            response: "## Summary\n\nThe job is **done**.",
            data: { rows_touched: 42, ok: true },
          },
        },
      },
    });
    expect(body).toContain("<h2");
    expect(body).toContain("Summary</h2>");
    expect(body).toContain("<strong>done</strong>");
    // The structured `data` payload still shows below as readable JSON.
    expect(body).toContain("rows_touched");
    expect(body).toContain("42");
  });

  it("`{response}` without data does not emit an empty JSON block", () => {
    const { body } = render(SessionResults, {
      props: { results: { agent_one: { response: "ok" } } },
    });
    expect(body).toContain("ok");
    expect(body).not.toContain("rows_touched");
    expect(body).not.toMatch(/<code[^>]*>{}<\/code>/);
  });

  it("markdown with an embedded GFM table renders prose + TableView", () => {
    const { body } = render(SessionResults, {
      props: {
        results: {
          unknown: {
            text: "Some prose first.\n\n| col1 | col2 |\n| --- | --- |\n| a | b |\n\nMore prose after.",
          },
        },
      },
    });
    // Both prose chunks land.
    expect(body).toContain("Some prose first");
    expect(body).toContain("More prose after");
    // Table headers + cell values arrive via TableView, not as a markdown
    // <table> from MarkdownRendered.
    expect(body).toContain("col1");
    expect(body).toContain("col2");
    expect(body).toContain(">a<");
    expect(body).toContain(">b<");
  });

  it("unrecognised object shape falls back to a JSON view", () => {
    const { body } = render(SessionResults, {
      props: { results: { agent_one: { weirdShape: [1, 2, 3] } } },
    });
    expect(body).toContain("weirdShape");
    expect(body).toContain("1");
    expect(body).toContain("2");
    expect(body).toContain("3");
  });

  it("renders per-agent headers when there is more than one entry", () => {
    const { body } = render(SessionResults, {
      props: {
        results: {
          fetcher: { text: "Fetched 12 docs." },
          summariser: { response: "Summary is **here**." },
        },
      },
    });
    expect(body).toContain("result-agent");
    expect(body).toContain("fetcher");
    expect(body).toContain("summariser");
    expect(body).toContain("<strong>here</strong>");
  });

  it("does not render an agent-name header when there is only one entry", () => {
    const { body } = render(SessionResults, {
      props: { results: { only_agent: { text: "just one result" } } },
    });
    expect(body).toContain("just one result");
    expect(body).not.toContain("result-agent");
    expect(body).not.toContain(">only_agent<");
  });

  it("a null-valued entry falls back to the JSON view rather than crashing", () => {
    const { body } = render(SessionResults, {
      props: { results: { agent_one: null } },
    });
    // Lands in the JSON fallback path — typeof null === "object" but the
    // prose extractor rejects null explicitly.
    expect(body).toContain("null");
  });
});

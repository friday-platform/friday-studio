/**
 * SSR tests for `session-results.svelte` — the per-agent results renderer
 * the run-detail page mounts under the final "Complete"/"Failed" roll-up.
 *
 * The page's upstream type for `results` is `Record<string, unknown>`
 * because agents emit anything they want through `complete()`, FSM
 * `outputTo`, or the chat-tool's implicit `{ text }` fall-through.
 * The component does the runtime branching: bare string, structured
 * `{response, data}`, `{text}` envelope, `{error}` envelope, raw JSON
 * fallback. These tests pin each branch on the first paint so a future
 * "simplification" can't quietly route a markdown payload back into a
 * JSON dump.
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

  it("string value renders as markdown prose, not escaped JSON", () => {
    const markdown = "# Result\n\nThe agent **succeeded** at the task.";
    const { body } = render(SessionResults, { props: { results: { agent_one: markdown } } });
    expect(body).toContain("<h1");
    expect(body).toContain("Result</h1>");
    expect(body).toContain("<strong>succeeded</strong>");
    // Never re-stringified through JsonHighlight.
    expect(body).not.toContain("\\n\\n");
    expect(body).not.toContain("# Result\\n");
  });

  it("string value with an embedded GFM table renders prose + TableView", () => {
    const markdown =
      "Some prose first.\n\n| col1 | col2 |\n| --- | --- |\n| a | b |\n\nMore prose after.";
    const { body } = render(SessionResults, { props: { results: { agent_one: markdown } } });
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

  it("structured {response, data} renders response as markdown and data as JSON", () => {
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

  it("structured value without `data` does not emit an empty JSON block", () => {
    const { body } = render(SessionResults, {
      props: { results: { agent_one: { response: "ok" } } },
    });
    expect(body).toContain("ok");
    // The structured `data` JSON block only appears when the agent emits one.
    expect(body).not.toContain("rows_touched");
    expect(body).not.toMatch(/<code[^>]*>{}<\/code>/);
  });

  it("`{text}` envelope renders the markdown body — the dominant chat-tool shape", () => {
    // This is what handle-chat / workspace-chat sessions actually emit
    // ('agentName: unknown' under the hood). Real-world data caught
    // during browser QA showed this was the missing branch.
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
    // List items make it through too.
    expect(body).toContain("step one");
    expect(body).toContain("step two");
    // Crucially: no escaped newlines, no JSON-shaped `"text": "..."`.
    expect(body).not.toContain("\\n\\n");
    expect(body).not.toMatch(/"text"\s*:/);
  });

  it("error envelope renders the error string with the error label class", () => {
    const { body } = render(SessionResults, {
      props: { results: { agent_one: { error: "blew up parsing yaml" } } },
    });
    expect(body).toContain("error-label");
    expect(body).toContain("blew up parsing yaml");
    // The error string is the whole render — no markdown pass and no JSON
    // dump alongside.
    expect(body).not.toContain("<h1");
    expect(body).not.toMatch(/rows_touched/);
  });

  it("unrecognised shape falls back to a JSON view, not a markdown render", () => {
    const { body } = render(SessionResults, {
      props: { results: { agent_one: { weirdShape: [1, 2, 3] } } },
    });
    expect(body).toContain("weirdShape");
    // The raw object should arrive as JSON-shaped text (key + array
    // values), not as a parsed markdown render.
    expect(body).toContain("1");
    expect(body).toContain("2");
    expect(body).toContain("3");
    expect(body).not.toContain("error-label");
  });

  it("renders per-agent headers when there is more than one entry", () => {
    const { body } = render(SessionResults, {
      props: { results: { fetcher: "Fetched 12 docs.", summariser: "Summary is **here**." } },
    });
    expect(body).toContain("result-agent");
    expect(body).toContain("fetcher");
    expect(body).toContain("summariser");
    expect(body).toContain("<strong>here</strong>");
  });

  it("does not render an agent-name header when there is only one entry", () => {
    const { body } = render(SessionResults, {
      props: { results: { only_agent: "just one result" } },
    });
    expect(body).toContain("just one result");
    expect(body).not.toContain("result-agent");
    expect(body).not.toContain(">only_agent<");
  });

  it("a null-valued entry falls back to the JSON view rather than crashing", () => {
    const { body } = render(SessionResults, { props: { results: { agent_one: null } } });
    // Lands in the JSON fallback path — typeof null === "object" but the
    // structured/error guards reject it explicitly.
    expect(body).toContain("null");
    expect(body).not.toContain("error-label");
  });
});

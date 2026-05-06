/**
 * C1 — fast-path aiSummary built from the terminal action's declared
 * `summary:` (Phase 2.A schema) + leaf-field-derived keyDetails. Pure-
 * function tests for the building blocks plus a runtime-shaped check
 * that confirms the LLM `generateSessionSummary` is skipped when the
 * fast path produces a value, and called when it doesn't.
 */

import type { FSMDefinition, Document as FSMDocument } from "@atlas/fsm-engine";
import { describe, expect, it, vi } from "vitest";
import {
  buildFastPathAiSummary,
  buildSynchronousFallbackAiSummary,
  deriveKeyDetailsFromOutputDoc,
  findTerminalAction,
  humanizeFieldKey,
} from "../runtime.ts";

describe("findTerminalAction", () => {
  it("returns the last LLM/agent entry action of the final state", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "start",
      states: {
        start: { on: { go: { target: "done" } } },
        done: {
          type: "final",
          entry: [
            { type: "emit", event: "noop" },
            {
              type: "llm",
              provider: "p",
              model: "m",
              prompt: "x",
              outputTo: "result",
              summary: "terminal summary",
            },
          ],
        },
      },
    };
    const found = findTerminalAction(definition);
    expect(found?.type).toBe("llm");
    expect(found?.summary).toBe("terminal summary");
  });

  it("falls back to the predecessor state when the final state has no LLM/agent entry", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "work",
      states: {
        work: {
          entry: [{ type: "agent", agentId: "a", outputTo: "out", summary: "predecessor summary" }],
          on: { done: { target: "end" } },
        },
        end: { type: "final" },
      },
    };
    const found = findTerminalAction(definition);
    expect(found?.type).toBe("agent");
    expect(found?.summary).toBe("predecessor summary");
  });

  it("returns undefined when no LLM/agent action reaches the terminal state", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "a",
      states: {
        a: { entry: [{ type: "emit", event: "noop" }], on: { done: { target: "b" } } },
        b: { type: "final" },
      },
    };
    expect(findTerminalAction(definition)).toBeUndefined();
  });

  it("returns undefined when no final state exists", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "a",
      states: { a: { entry: [{ type: "llm", provider: "p", model: "m", prompt: "x" }] } },
    };
    expect(findTerminalAction(definition)).toBeUndefined();
  });

  it("picks the LAST LLM/agent action when multiple are present", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "s",
      states: {
        s: {
          type: "final",
          entry: [
            { type: "llm", provider: "p", model: "m", prompt: "first", summary: "first summary" },
            { type: "agent", agentId: "a", prompt: "second", summary: "second summary" },
          ],
        },
      },
    };
    const found = findTerminalAction(definition);
    expect(found?.summary).toBe("second summary");
  });
});

describe("humanizeFieldKey", () => {
  it("title-cases camelCase fields", () => {
    expect(humanizeFieldKey("processedCount")).toBe("Processed Count");
  });

  it("title-cases snake_case fields", () => {
    expect(humanizeFieldKey("total_emails")).toBe("Total Emails");
  });

  it("handles single-word keys", () => {
    expect(humanizeFieldKey("status")).toBe("Status");
  });

  it("handles mixed snake + camel + numerics", () => {
    expect(humanizeFieldKey("page2Url")).toBe("Page2 Url");
    expect(humanizeFieldKey("first_pageURL")).toBe("First Page URL");
  });
});

describe("deriveKeyDetailsFromOutputDoc", () => {
  it("returns [] for a missing or empty doc", () => {
    expect(deriveKeyDetailsFromOutputDoc(undefined)).toEqual([]);
    expect(deriveKeyDetailsFromOutputDoc({ data: {} })).toEqual([]);
  });

  it("emits one entry per top-level string/number leaf", () => {
    const out = deriveKeyDetailsFromOutputDoc({ data: { processedCount: 7, status: "ok" } });
    expect(out).toEqual([
      { label: "Processed Count", value: "7" },
      { label: "Status", value: "ok" },
    ]);
  });

  it("populates `url` for strings starting with http:// or https://", () => {
    const out = deriveKeyDetailsFromOutputDoc({
      data: {
        notionPage: "https://notion.so/abc",
        plainText: "not-a-url",
        secureLink: "http://example.com/x",
      },
    });
    expect(out).toEqual([
      { label: "Notion Page", value: "https://notion.so/abc", url: "https://notion.so/abc" },
      { label: "Plain Text", value: "not-a-url" },
      { label: "Secure Link", value: "http://example.com/x", url: "http://example.com/x" },
    ]);
  });

  it("skips nested objects and arrays of objects", () => {
    const out = deriveKeyDetailsFromOutputDoc({
      data: { title: "Report", nested: { inner: 1 }, items: [{ a: 1 }, { a: 2 }], count: 3 },
    });
    expect(out).toEqual([
      { label: "Title", value: "Report" },
      { label: "Count", value: "3" },
    ]);
  });

  it("caps the result at 5 entries", () => {
    const data: Record<string, string> = {};
    for (let i = 0; i < 8; i++) data[`field${i}`] = `v${i}`;
    const out = deriveKeyDetailsFromOutputDoc({ data });
    expect(out).toHaveLength(5);
    expect(out.map((e) => e.label)).toEqual(["Field0", "Field1", "Field2", "Field3", "Field4"]);
  });
});

describe("buildFastPathAiSummary", () => {
  const definitionWithSummary: FSMDefinition = {
    id: "j",
    initial: "s",
    states: {
      s: {
        type: "final",
        entry: [
          {
            type: "llm",
            provider: "p",
            model: "m",
            prompt: "x",
            outputTo: "result",
            outputType: "Result",
            summary: "Triaged the inbox",
          },
        ],
      },
    },
  };

  it("builds aiSummary synchronously from declared summary + doc leaves", () => {
    const docs: FSMDocument[] = [
      { id: "result", type: "Result", data: { processedCount: 12, link: "https://example.com/r" } },
    ];
    const out = buildFastPathAiSummary(definitionWithSummary, docs);
    expect(out).toEqual({
      summary: "Triaged the inbox",
      keyDetails: [
        { label: "Processed Count", value: "12" },
        { label: "Link", value: "https://example.com/r", url: "https://example.com/r" },
      ],
    });
  });

  it("returns aiSummary with empty keyDetails when no outputTo doc exists", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "s",
      states: {
        s: {
          type: "final",
          entry: [
            { type: "llm", provider: "p", model: "m", prompt: "x", summary: "Did the thing" },
          ],
        },
      },
    };
    const out = buildFastPathAiSummary(definition, []);
    expect(out).toEqual({ summary: "Did the thing", keyDetails: [] });
  });

  it("returns undefined when terminal action has no `summary:` declared", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "s",
      states: {
        s: {
          type: "final",
          entry: [{ type: "llm", provider: "p", model: "m", prompt: "x", outputTo: "result" }],
        },
      },
    };
    const docs: FSMDocument[] = [{ id: "result", type: "Result", data: { ok: true } }];
    expect(buildFastPathAiSummary(definition, docs)).toBeUndefined();
  });

  it("returns undefined when no terminal action can be identified", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "a",
      states: {
        a: { entry: [{ type: "emit", event: "noop" }], on: { done: { target: "b" } } },
        b: { type: "final" },
      },
    };
    expect(buildFastPathAiSummary(definition, [])).toBeUndefined();
  });
});

describe("buildSynchronousFallbackAiSummary (C2)", () => {
  // Used when the C1 fast path is unavailable. Caller emits this
  // immediately on `job-complete` and detaches the LLM round-trip;
  // tests cover the source-preference rules.

  it("uses the terminal-action's declared `summary:` even without an outputTo doc", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "s",
      states: {
        s: {
          type: "final",
          entry: [{ type: "llm", provider: "p", model: "m", prompt: "x", summary: "Done it" }],
        },
      },
    };
    const out = buildSynchronousFallbackAiSummary(definition, []);
    expect(out).toEqual({ summary: "Done it", keyDetails: [] });
  });

  it("falls back to truncated terminal-doc data when no `summary:` is declared", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "s",
      states: {
        s: {
          type: "final",
          entry: [{ type: "agent", agentId: "a", prompt: "x", outputTo: "result" }],
        },
      },
    };
    const docs: FSMDocument[] = [{ id: "result", type: "Result", data: { ok: true, count: 4 } }];
    const out = buildSynchronousFallbackAiSummary(definition, docs);
    // Truncated JSON of the doc data (~300 chars cap).
    expect(out.summary).toContain('"ok":true');
    expect(out.summary).toContain('"count":4');
    // keyDetails still derived from the outputTo doc.
    expect(out.keyDetails).toEqual([{ label: "Count", value: "4" }]);
  });

  it("returns an empty SessionAISummary when there's no terminal action and no docs", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "a",
      states: {
        a: { entry: [{ type: "emit", event: "noop" }], on: { done: { target: "b" } } },
        b: { type: "final" },
      },
    };
    const out = buildSynchronousFallbackAiSummary(definition, []);
    expect(out).toEqual({ summary: "", keyDetails: [] });
  });
});

describe("fast path skips generateSessionSummary", () => {
  // Models the runtime call-site decision: when buildFastPathAiSummary
  // returns a value the LLM-summary path is bypassed; otherwise it's
  // invoked. Keeps the pure-function contract test honest about the
  // wire-up the runtime depends on without spinning the full engine.

  it("uses the synchronous fast path when terminal action has summary:", async () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "s",
      states: {
        s: {
          type: "final",
          entry: [
            {
              type: "llm",
              provider: "p",
              model: "m",
              prompt: "x",
              outputTo: "out",
              summary: "Fast path summary",
            },
          ],
        },
      },
    };
    const docs: FSMDocument[] = [{ id: "out", type: "Out", data: { count: 1 } }];

    const generateSessionSummary = vi.fn(() => Promise.resolve({ summary: "llm", keyDetails: [] }));
    const fast = buildFastPathAiSummary(definition, docs);
    const aiSummary = fast ?? (await generateSessionSummary());

    expect(aiSummary?.summary).toBe("Fast path summary");
    expect(generateSessionSummary).not.toHaveBeenCalled();
  });

  it("falls through to generateSessionSummary when terminal action has no summary:", async () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "s",
      states: {
        s: {
          type: "final",
          entry: [{ type: "llm", provider: "p", model: "m", prompt: "x", outputTo: "out" }],
        },
      },
    };
    const docs: FSMDocument[] = [{ id: "out", type: "Out", data: { count: 1 } }];

    const generateSessionSummary = vi.fn(() =>
      Promise.resolve({ summary: "llm summary", keyDetails: [] }),
    );
    const fast = buildFastPathAiSummary(definition, docs);
    const aiSummary = fast ?? (await generateSessionSummary());

    expect(aiSummary?.summary).toBe("llm summary");
    expect(generateSessionSummary).toHaveBeenCalledTimes(1);
  });
});

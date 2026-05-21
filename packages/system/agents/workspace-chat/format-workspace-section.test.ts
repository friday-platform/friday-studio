import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import { describe, expect, it } from "vitest";
import { formatWorkspaceSection, type WorkspaceDetails } from "./workspace-chat.agent.ts";

function details(over: Partial<WorkspaceDetails> = {}): WorkspaceDetails {
  return {
    name: "test-workspace",
    description: "A test workspace.",
    agents: [],
    jobs: [],
    signals: [],
    artifacts: [],
    ...over,
  };
}

const REINDEX_SIGNAL = {
  provider: "http",
  description: "rebuild",
  config: { path: "/webhooks/reindex" },
};

const REINDEX_JOB = {
  description: "Rebuild the corpus.",
  triggers: [{ signal: "reindex" }],
  fsm: { initial: "done", states: { done: { type: "final" } } },
};

/** Build a parsed WorkspaceConfig from a partial input.
 *
 * Input is typed as `Record<string, unknown>` rather than
 * `Partial<WorkspaceConfig>` so the inline literal shapes (REINDEX_SIGNAL,
 * REINDEX_JOB) don't have to satisfy the strict discriminated-union
 * shape on `provider` etc. — zod's `parse()` does the validation and
 * returns the precisely-typed `WorkspaceConfig`. */
const config = (over: Record<string, unknown>): WorkspaceConfig =>
  WorkspaceConfigSchema.parse({ version: "1.0", workspace: { name: "x" }, ...over });

describe("formatWorkspaceSection signal display", () => {
  it("points the model at the job tool when one covers the signal (locks tools/qa/live-daemon eval)", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details({ signals: [{ name: "reindex" }] }),
      config({
        signals: { reindex: REINDEX_SIGNAL },
        jobs: { "reindex-knowledge-base": REINDEX_JOB },
      }),
    );

    expect(out).toContain("reindex (use tool: reindex-knowledge-base)");
    expect(out).not.toContain("POST /webhooks/reindex");
  });

  it("falls back to provider-trigger description when no job covers the signal", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details({ signals: [{ name: "reindex" }] }),
      config({
        signals: { reindex: REINDEX_SIGNAL },
        // no jobs at all → must still describe the trigger
      }),
    );

    expect(out).toContain("reindex (POST /webhooks/reindex)");
    expect(out).not.toContain("use tool:");
  });

  it("ignores jobs whose triggers reference a different signal", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details({ signals: [{ name: "reindex" }] }),
      config({
        signals: { reindex: REINDEX_SIGNAL },
        jobs: { "unrelated-job": { ...REINDEX_JOB, triggers: [{ signal: "different-signal" }] } },
      }),
    );

    expect(out).toContain("reindex (POST /webhooks/reindex)");
    expect(out).not.toContain("use tool:");
  });

  it("renders bare signal name when neither config nor jobs are available", () => {
    const out = formatWorkspaceSection("ws_1", details({ signals: [{ name: "reindex" }] }));
    expect(out).toContain("<signals>\nreindex\n</signals>");
  });

  it("maps each signal independently when multiple jobs/signals exist", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details({ signals: [{ name: "reindex" }, { name: "query" }] }),
      config({
        signals: {
          reindex: REINDEX_SIGNAL,
          query: { ...REINDEX_SIGNAL, config: { path: "/webhooks/query" } },
        },
        jobs: {
          "reindex-knowledge-base": REINDEX_JOB,
          "query-knowledge-base": { ...REINDEX_JOB, triggers: [{ signal: "query" }] },
        },
      }),
    );

    expect(out).toContain("reindex (use tool: reindex-knowledge-base)");
    expect(out).toContain("query (use tool: query-knowledge-base)");
    expect(out).not.toContain("/webhooks/");
  });
});

describe("formatWorkspaceSection welcome", () => {
  it("emits a <welcome> child after description when workspace.welcome is non-empty", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details(),
      config({ workspace: { name: "x", welcome: "## RTX Price Monitor\n\nWatches Best Buy." } }),
    );
    expect(out).toContain("<welcome>## RTX Price Monitor\n\nWatches Best Buy.</welcome>");
    // Welcome sits between the description body and the rest of the block.
    expect(out.indexOf("A test workspace.")).toBeLessThan(out.indexOf("<welcome>"));
  });

  it("omits <welcome> entirely when workspace.welcome is absent", () => {
    const out = formatWorkspaceSection("ws_1", details(), config({ workspace: { name: "x" } }));
    expect(out).not.toContain("<welcome");
  });

  it("omits <welcome> when workspace.welcome is an empty string", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details(),
      config({ workspace: { name: "x", welcome: "" } }),
    );
    expect(out).not.toContain("<welcome");
  });

  it("XML-escapes welcome body so author markdown can't break out of the element", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details(),
      config({ workspace: { name: "x", welcome: `<script>alert("x & 'y'")</script>` } }),
    );
    expect(out).toContain(
      "<welcome>&lt;script&gt;alert(&quot;x &amp; &apos;y&apos;&quot;)&lt;/script&gt;</welcome>",
    );
    expect(out).not.toContain("<script>");
  });
});

describe("formatWorkspaceSection variables", () => {
  it("emits one <variable> per declaration with required=true when no schema default", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details(),
      config({
        variables: {
          EMAIL_RECIPIENT: {
            description: "Address that receives alerts.",
            schema: { type: "string" },
          },
        },
      }),
    );
    expect(out).toContain(
      '<variables>\n<variable name="EMAIL_RECIPIENT" required="true">\n<description>Address that receives alerts.</description>\n</variable>\n</variables>',
    );
  });

  it("marks variable required=false when the schema carries a default", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details(),
      config({ variables: { MAX_PRICE: { schema: { type: "integer", default: 1400 } } } }),
    );
    expect(out).toContain('<variable name="MAX_PRICE" required="false"/>');
  });

  it("uses the self-closing form when a variable carries no description", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details(),
      config({ variables: { MAX_PRICE: { schema: { type: "integer" } } } }),
    );
    expect(out).toContain('<variable name="MAX_PRICE" required="true"/>');
    expect(out).not.toContain("<description>");
  });

  it("omits <description> entirely when the declaration's description is an empty string", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details(),
      config({ variables: { MAX_PRICE: { description: "", schema: { type: "integer" } } } }),
    );
    expect(out).toContain('<variable name="MAX_PRICE" required="true"/>');
    expect(out).not.toContain("<description>");
  });

  it("XML-escapes description bodies", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details(),
      config({
        variables: { NOTE: { description: `<b>hi & "bye"</b>`, schema: { type: "string" } } },
      }),
    );
    expect(out).toContain("<description>&lt;b&gt;hi &amp; &quot;bye&quot;&lt;/b&gt;</description>");
    expect(out).not.toContain("<b>");
  });

  it("renders both <welcome> and <variables> when both are present", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details(),
      config({
        workspace: { name: "x", welcome: "Hello." },
        variables: {
          EMAIL_RECIPIENT: {
            description: "Address that receives alerts.",
            schema: { type: "string" },
          },
          MAX_PRICE: { schema: { type: "integer", default: 1400 } },
        },
      }),
    );
    expect(out).toContain("<welcome>Hello.</welcome>");
    expect(out).toContain('<variable name="EMAIL_RECIPIENT" required="true">');
    expect(out).toContain('<variable name="MAX_PRICE" required="false"/>');
  });

  it("preserves declaration order across calls (deterministic iteration)", () => {
    const variables = {
      C_VAR: { schema: { type: "string" as const } },
      A_VAR: { schema: { type: "string" as const } },
      B_VAR: { schema: { type: "string" as const } },
    };
    const first = formatWorkspaceSection("ws_1", details(), config({ variables }));
    const second = formatWorkspaceSection("ws_1", details(), config({ variables }));
    expect(second).toBe(first);
    const cIdx = first.indexOf("C_VAR");
    const aIdx = first.indexOf("A_VAR");
    const bIdx = first.indexOf("B_VAR");
    expect(cIdx).toBeLessThan(aIdx);
    expect(aIdx).toBeLessThan(bIdx);
  });

  it("omits <variables> when the record is absent", () => {
    const out = formatWorkspaceSection("ws_1", details(), config({}));
    expect(out).not.toContain("<variables");
  });

  it("omits <variables> when the record is an empty object", () => {
    const out = formatWorkspaceSection("ws_1", details(), config({ variables: {} }));
    expect(out).not.toContain("<variables");
  });

  it("produces byte-identical output to today when neither welcome nor variables are present", () => {
    // Locks the empty case: a workspace with no welcome and no variables
    // declarations must render exactly the same bytes the agent saw before
    // this feature shipped. Any drift breaks the 1h prompt-cache prefix.
    const expected = '<workspace id="ws_1" name="test-workspace">\nA test workspace.\n</workspace>';
    const withoutConfig = formatWorkspaceSection("ws_1", details());
    const withEmptyConfig = formatWorkspaceSection("ws_1", details(), config({}));
    expect(withoutConfig).toBe(expected);
    expect(withEmptyConfig).toBe(expected);
  });
});

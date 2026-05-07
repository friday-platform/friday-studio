import { describe, expect, it } from "vitest";
import {
  type ClassifierInput,
  classifyAction,
  isMutating,
  isReadOnly,
  MUTATING_VERB_RE,
  READ_ONLY_ALLOWLIST,
} from "./validate-classifier.ts";

const baseInput: ClassifierInput = {
  declaredTools: [],
  calledToolNames: [],
  hasOutputType: false,
  hasInputFrom: false,
  resolvedAgentType: undefined,
  emittedProse: false,
  toolsAvailable: false,
};

describe("classifyAction — skip rules", () => {
  it("skips read-only fetcher (gmail/search_* + outputType)", () => {
    const out = classifyAction({
      ...baseInput,
      declaredTools: ["google-gmail/search_gmail_messages"],
      hasOutputType: true,
      toolsAvailable: true,
    });
    expect(out.decision).toBe("skip");
    expect(out.reason).toBe("read-only-fetcher");
  });

  it("skips pure formatter (inputFrom + outputType, no tools)", () => {
    const out = classifyAction({ ...baseInput, hasInputFrom: true, hasOutputType: true });
    expect(out.decision).toBe("skip");
    expect(out.reason).toBe("pure-formatter");
  });

  it("skips when resolvedAgentType is 'user'", () => {
    const out = classifyAction({
      ...baseInput,
      resolvedAgentType: "user",
      // Mutating tool is irrelevant — user-agent short-circuits first.
      declaredTools: ["google-gmail/send_gmail_message"],
    });
    expect(out.decision).toBe("skip");
    expect(out.reason).toBe("non-llm-agent-type:user");
  });

  it("skips when resolvedAgentType is 'atlas'", () => {
    const out = classifyAction({ ...baseInput, resolvedAgentType: "atlas", emittedProse: true });
    expect(out.decision).toBe("skip");
    expect(out.reason).toBe("non-llm-agent-type:atlas");
  });

  it("skips read-only fetcher with mixed gmail get_/list_/search_", () => {
    const out = classifyAction({
      ...baseInput,
      declaredTools: [
        "google-gmail/get_gmail_message",
        "google-gmail/list_gmail_labels",
        "google-gmail/search_gmail_messages",
      ],
      hasOutputType: true,
      toolsAvailable: true,
    });
    expect(out.decision).toBe("skip");
    expect(out.reason).toBe("read-only-fetcher");
  });

  it("does NOT skip read-only-fetcher when outputType is missing", () => {
    const out = classifyAction({
      ...baseInput,
      declaredTools: ["google-gmail/search_gmail_messages"],
      hasOutputType: false,
      emittedProse: true,
      toolsAvailable: true,
    });
    expect(out.decision).toBe("self");
  });
});

describe("classifyAction — self rules", () => {
  it("returns self when a declared tool is mutating", () => {
    const tool = "google-gmail/batch_modify_gmail_message_labels";
    const out = classifyAction({
      ...baseInput,
      declaredTools: [tool],
      hasOutputType: true,
      toolsAvailable: true,
    });
    expect(out.decision).toBe("self");
    expect(out.reason).toBe(`mutating-tool:${tool}`);
  });

  it("returns self when a CALLED tool is mutating (even if not declared)", () => {
    const out = classifyAction({
      ...baseInput,
      declaredTools: [],
      calledToolNames: ["google-gmail/send_gmail_message"],
    });
    expect(out.decision).toBe("self");
    expect(out.reason).toBe("mutating-tool:google-gmail/send_gmail_message");
  });

  it("returns self for free-form prose", () => {
    const out = classifyAction({ ...baseInput, emittedProse: true });
    expect(out.decision).toBe("self");
    expect(out.reason).toBe("free-form-prose");
  });

  it("returns self when resolvedAgentType is 'llm' and tools mutate", () => {
    const out = classifyAction({
      ...baseInput,
      resolvedAgentType: "llm",
      declaredTools: ["google-gmail/send_gmail_message"],
      toolsAvailable: true,
    });
    expect(out.decision).toBe("self");
    expect(out.reason).toBe("mutating-tool:google-gmail/send_gmail_message");
  });

  it("returns self when tools are available but none called and prose emitted", () => {
    const out = classifyAction({
      ...baseInput,
      declaredTools: ["google-gmail/search_gmail_messages"],
      toolsAvailable: true,
      calledToolNames: [],
      emittedProse: true,
      // Critically, NO outputType — so the read-only-fetcher rule doesn't fire.
      hasOutputType: false,
    });
    expect(out.decision).toBe("self");
    expect(out.reason).toBe("tools-available-but-prose-output");
  });

  it("returns self via fallback when nothing else matches", () => {
    const out = classifyAction(baseInput);
    expect(out.decision).toBe("self");
    expect(out.reason).toBe("default-self");
  });

  it("run_code with outputType is NOT skipped (run_code not in allowlist)", () => {
    const out = classifyAction({
      ...baseInput,
      declaredTools: ["run_code"],
      hasOutputType: true,
      toolsAvailable: true,
      emittedProse: true,
    });
    expect(out.decision).toBe("self");
    // Either prose or fallback — both acceptable; key is "not skip".
    expect(out.decision).not.toBe("skip");
  });
});

describe("isReadOnly — allowlist coverage", () => {
  it.each([
    ["google-gmail/get_gmail_message", true],
    ["google-gmail/list_gmail_labels", true],
    ["google-gmail/search_gmail_messages", true],
    ["github/get_issue", true],
    ["github/list_pull_requests", true],
    ["github/search_repositories", true],
    ["github/view_file", true],
    ["fs/fs_read_file", true],
    ["fs_read_file", true],
    ["fs_glob", true],
    ["fs_list_files", true],
    ["fs_grep", true],
    ["core/web_fetch", true],
    ["web_search", true],
    ["request_tool_access", true],
    ["request_human_input", true],
    ["memory_read", true],
    ["artifacts/artifacts_get", true],
    ["artifacts_get", true],
    ["parse_artifact", true],
    ["display_artifact", true],
    // Negative cases
    ["run_code", false],
    ["google-gmail/send_gmail_message", false],
    ["fs/fs_write_file", false],
    ["memory_save", false],
  ])("isReadOnly(%s) === %s", (name, expected) => {
    expect(isReadOnly(name)).toBe(expected);
  });

  it("READ_ONLY_ALLOWLIST does not contain run_code", () => {
    const literals = READ_ONLY_ALLOWLIST.filter((e): e is string => typeof e === "string");
    expect(literals).not.toContain("run_code");
  });
});

describe("MUTATING_VERB_RE — verb regex spot checks", () => {
  it.each([
    ["send_email", true],
    ["create_issue", true],
    ["create_", true],
    ["memory_save", true],
    ["memory_remove", true],
    ["fs_write_file", true],
    ["batch_modify_gmail_message_labels", true],
    ["delete_message", true],
    ["archive_thread", true],
    ["unsubscribe_list", true],
    ["publish_release", true],
    ["deploy_app", true],
    ["merge_pr", true],
    // Negatives
    ["get_email", false],
    ["list_files", false],
    ["search_messages", false],
    ["view_file", false],
    ["fs_read_file", false],
    ["memory_read", false],
  ])("MUTATING_VERB_RE.test(%s) === %s", (name, expected) => {
    expect(MUTATING_VERB_RE.test(name)).toBe(expected);
  });

  it("isMutating strips the <mcp-server>/ prefix before matching", () => {
    expect(isMutating("google-gmail/send_gmail_message")).toBe(true);
    expect(isMutating("github/create_issue")).toBe(true);
    expect(isMutating("fs/fs_write_file")).toBe(true);
    expect(isMutating("google-gmail/get_gmail_message")).toBe(false);
  });
});

/**
 * Integration tests verifying expandAgentActions, resolveRuntimeAgentId,
 * and resolveRuntimeAgentId compose correctly against real workspace config
 * shapes (pr-review and notion-research).
 *
 * Tests cover both legacy formats (backward compat) and rewritten delegate
 * model formats.
 */

import type { Action, FSMDefinition } from "@atlas/fsm-engine";
import { describe, expect, test } from "vitest";
import type { WorkspaceAgentConfig } from "./agents.ts";
import { expandAgentActions } from "./expand-agent-actions.ts";
import { atlasAgent, llmAgent } from "./mutations/test-fixtures.ts";
import { resolveRuntimeAgentId } from "./resolve-runtime-agent.ts";

// ==============================================================================
// HELPERS
// ==============================================================================

/** Extract entry array from a state in the result FSM, throwing if missing. */
function getEntry(result: FSMDefinition, stateId: string): Action[] {
  const state = result.states[stateId];
  if (!state?.entry) throw new Error(`Expected entry actions on state ${stateId}`);
  return state.entry;
}

// ==============================================================================
// FIXTURES — real workspace config shapes
// ==============================================================================

/**
 * pr-review legacy: FSM uses `agentId: claude-code` directly.
 * No workspace agent keyed as `claude-code` exists — agents are keyed by
 * role name (repo-cloner, code-reviewer, review-reporter).
 */
function prReviewLegacyFSM(): FSMDefinition {
  return {
    id: "pr-code-review-pipeline",
    initial: "idle",
    states: {
      idle: { on: { "review-pr": { target: "step_clone_repo" } } },
      step_clone_repo: {
        entry: [
          { type: "code", function: "prepare_clone" },
          {
            type: "agent",
            agentId: "claude-code",
            prompt: "Clone the repo",
            outputTo: "clone-output",
            outputType: "clone-result",
          },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "step_review_pr" } },
      },
      step_review_pr: {
        entry: [
          { type: "code", function: "prepare_review" },
          {
            type: "agent",
            agentId: "claude-code",
            prompt: "Review the PR",
            outputTo: "review-output",
            outputType: "code-review-result",
          },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "step_post_review" } },
      },
      step_post_review: {
        entry: [
          { type: "code", function: "prepare_post_review" },
          {
            type: "agent",
            agentId: "claude-code",
            prompt: "Post the review",
            outputTo: "post-review-output",
            outputType: "post-review-result",
          },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "completed" } },
      },
      completed: { type: "final" },
    },
  };
}

/**
 * notion-research legacy: FSM uses inline `type: llm` actions.
 * The `notion-research-agent` in the agents map is vestigial — never referenced.
 */
function notionResearchLegacyFSM(): FSMDefinition {
  return {
    id: "notion-research",
    initial: "idle",
    states: {
      idle: { on: { "research-topic": { target: "step_search_notion_pages" } } },
      step_search_notion_pages: {
        entry: [
          { type: "code", function: "prepare_search_notion_pages" },
          {
            type: "llm",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            prompt: "Search the Notion workspace for all pages related to the given topic.",
            tools: ["notion"],
            outputTo: "search-notion-pages-output",
            outputType: "search-notion-pages-result",
          },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "step_summarize_findings" } },
      },
      step_summarize_findings: {
        entry: [
          { type: "code", function: "prepare_summarize_findings" },
          {
            type: "llm",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            prompt: "Summarize the key findings from the Notion pages.",
            tools: ["notion"],
            outputTo: "summarize-findings-output",
            outputType: "summarize-findings-result",
          },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "step_create_summary_page" } },
      },
      step_create_summary_page: {
        entry: [
          { type: "code", function: "prepare_create_summary_page" },
          {
            type: "llm",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            prompt: "Create a new Notion page with the summarized findings.",
            tools: ["notion"],
            outputTo: "create-summary-page-output",
            outputType: "create-summary-page-result",
          },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "completed" } },
      },
      completed: { type: "final" },
    },
  };
}

/**
 * pr-review rewritten: FSM uses workspace agent keys (repo-cloner, etc.)
 * with `type: agent`. Agents are atlas type pointing to `claude-code`.
 */
function prReviewDelegateFSM(): FSMDefinition {
  return {
    id: "pr-code-review-pipeline",
    initial: "idle",
    states: {
      idle: { on: { "review-pr": { target: "step_clone_repo" } } },
      step_clone_repo: {
        entry: [
          { type: "code", function: "prepare_clone" },
          {
            type: "agent",
            agentId: "repo-cloner",
            prompt: "Clone the repo",
            outputTo: "clone-output",
            outputType: "clone-result",
          },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "step_review_pr" } },
      },
      step_review_pr: {
        entry: [
          { type: "code", function: "prepare_review" },
          {
            type: "agent",
            agentId: "code-reviewer",
            prompt: "Review the PR",
            outputTo: "review-output",
            outputType: "code-review-result",
          },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "step_post_review" } },
      },
      step_post_review: {
        entry: [
          { type: "code", function: "prepare_post_review" },
          {
            type: "agent",
            agentId: "review-reporter",
            prompt: "Post the review",
            outputTo: "post-review-output",
            outputType: "post-review-result",
          },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "completed" } },
      },
      completed: { type: "final" },
    },
  };
}

/**
 * notion-research rewritten: FSM uses `agentId: notion-research-agent`
 * instead of inline `type: llm`. The agent config carries provider/model/tools.
 */
function notionResearchDelegateFSM(): FSMDefinition {
  return {
    id: "notion-research",
    initial: "idle",
    states: {
      idle: { on: { "research-topic": { target: "step_search_notion_pages" } } },
      step_search_notion_pages: {
        entry: [
          { type: "code", function: "prepare_search_notion_pages" },
          {
            type: "agent",
            agentId: "notion-research-agent",
            prompt: "Search the Notion workspace for all pages related to the given topic.",
            outputTo: "search-notion-pages-output",
            outputType: "search-notion-pages-result",
          },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "step_summarize_findings" } },
      },
      step_summarize_findings: {
        entry: [
          { type: "code", function: "prepare_summarize_findings" },
          {
            type: "agent",
            agentId: "notion-research-agent",
            prompt: "Summarize the key findings from the Notion pages.",
            outputTo: "summarize-findings-output",
            outputType: "summarize-findings-result",
          },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "step_create_summary_page" } },
      },
      step_create_summary_page: {
        entry: [
          { type: "code", function: "prepare_create_summary_page" },
          {
            type: "agent",
            agentId: "notion-research-agent",
            prompt: "Create a new Notion page with the summarized findings.",
            outputTo: "create-summary-page-output",
            outputType: "create-summary-page-result",
          },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "completed" } },
      },
      completed: { type: "final" },
    },
  };
}

// ==============================================================================
// LEGACY BACKWARD COMPAT — current workspace formats
// ==============================================================================

describe("legacy backward compat", () => {
  describe("pr-review (agentId: claude-code, no matching workspace agent key)", () => {
    const legacyAgents: Record<string, WorkspaceAgentConfig> = {
      "repo-cloner": atlasAgent({ agent: "claude-code", description: "Cloner" }),
      "code-reviewer": atlasAgent({ agent: "claude-code", description: "Reviewer" }),
      "review-reporter": atlasAgent({ agent: "claude-code", description: "Reporter" }),
    };

    test("expandAgentActions passes through all actions unchanged", () => {
      const fsm = prReviewLegacyFSM();
      const result = expandAgentActions(fsm, legacyAgents);

      // All 3 step states use agentId: claude-code, which has no matching key
      // in the workspace agents map → passthrough
      for (const stateId of ["step_clone_repo", "step_review_pr", "step_post_review"]) {
        const entry = getEntry(result, stateId);
        const agentAction = entry.find((a) => a.type === "agent");

        expect(agentAction?.type).toBe("agent");
        if (agentAction?.type === "agent") {
          expect(agentAction.agentId).toBe("claude-code");
        }
      }
    });

    test("resolveRuntimeAgentId returns claude-code unchanged (no config match)", () => {
      // Legacy workspace: FSM says agentId: claude-code, but no agent keyed
      // "claude-code" in the agents map → undefined config → passthrough
      const agentConfig = legacyAgents["claude-code"]; // undefined
      expect(resolveRuntimeAgentId(agentConfig, "claude-code")).toBe("claude-code");
    });
  });

  describe("notion-research (inline type: llm, vestigial agent config)", () => {
    const legacyAgents: Record<string, WorkspaceAgentConfig> = {
      "notion-research-agent": llmAgent({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        prompt: "You are Notion Research Agent.",
        tools: ["notion"],
      }),
    };

    test("expandAgentActions passes through all actions unchanged", () => {
      const fsm = notionResearchLegacyFSM();
      const result = expandAgentActions(fsm, legacyAgents);

      // All 3 step states use inline type: llm → not type: agent → no expansion
      for (const stateId of [
        "step_search_notion_pages",
        "step_summarize_findings",
        "step_create_summary_page",
      ]) {
        const entry = getEntry(result, stateId);
        const llmAction = entry.find((a) => a.type === "llm");

        expect(llmAction?.type).toBe("llm");
        if (llmAction?.type === "llm") {
          expect(llmAction.provider).toBe("anthropic");
          expect(llmAction.model).toBe("claude-sonnet-4-6");
        }
      }
    });
  });
});

// ==============================================================================
// NEW DELEGATE MODEL — rewritten workspace configs
// ==============================================================================

describe("delegate model (rewritten configs)", () => {
  describe("pr-review (atlas agents pointing to claude-code)", () => {
    const delegateAgents: Record<string, WorkspaceAgentConfig> = {
      "repo-cloner": atlasAgent({
        agent: "claude-code",
        description: "Cloner",
        prompt: "Clone repos",
      }),
      "code-reviewer": atlasAgent({
        agent: "claude-code",
        description: "Reviewer",
        prompt: "Review code",
      }),
      "review-reporter": atlasAgent({
        agent: "claude-code",
        description: "Reporter",
        prompt: "Post reviews",
      }),
    };

    test("expandAgentActions passes through atlas agents unchanged", () => {
      const fsm = prReviewDelegateFSM();
      const result = expandAgentActions(fsm, delegateAgents);

      // Atlas agents are NOT LLM → no expansion → stays type: agent
      const cloneAction = getEntry(result, "step_clone_repo").find((a) => a.type === "agent");
      expect(cloneAction?.type === "agent" && cloneAction.agentId).toBe("repo-cloner");

      const reviewAction = getEntry(result, "step_review_pr").find((a) => a.type === "agent");
      expect(reviewAction?.type === "agent" && reviewAction.agentId).toBe("code-reviewer");

      const postAction = getEntry(result, "step_post_review").find((a) => a.type === "agent");
      expect(postAction?.type === "agent" && postAction.agentId).toBe("review-reporter");
    });

    test("resolveRuntimeAgentId extracts claude-code from atlas config", () => {
      expect(resolveRuntimeAgentId(delegateAgents["repo-cloner"], "repo-cloner")).toBe(
        "claude-code",
      );
      expect(resolveRuntimeAgentId(delegateAgents["code-reviewer"], "code-reviewer")).toBe(
        "claude-code",
      );
      expect(resolveRuntimeAgentId(delegateAgents["review-reporter"], "review-reporter")).toBe(
        "claude-code",
      );
    });
  });

  describe("notion-research (LLM agent referenced by FSM steps)", () => {
    const delegateAgents: Record<string, WorkspaceAgentConfig> = {
      "notion-research-agent": llmAgent({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        prompt: "You are Notion Research Agent.",
        tools: ["notion"],
      }),
    };

    test("expandAgentActions converts type: agent to type: llm with combined prompt", () => {
      const fsm = notionResearchDelegateFSM();
      const result = expandAgentActions(fsm, delegateAgents);

      // All 3 steps should be converted from type: agent → type: llm
      const searchAction = getEntry(result, "step_search_notion_pages").find(
        (a) => a.type === "llm",
      );

      expect(searchAction?.type).toBe("llm");
      if (searchAction?.type === "llm") {
        expect(searchAction.provider).toBe("anthropic");
        expect(searchAction.model).toBe("claude-sonnet-4-6");
        expect(searchAction.tools).toEqual(["notion"]);
        expect(searchAction.prompt).toBe(
          "You are Notion Research Agent.\n\nSearch the Notion workspace for all pages related to the given topic.",
        );
        expect(searchAction.outputTo).toBe("search-notion-pages-output");
        expect(searchAction.outputType).toBe("search-notion-pages-result");
      }

      const summarizeAction = getEntry(result, "step_summarize_findings").find(
        (a) => a.type === "llm",
      );

      expect(summarizeAction?.type).toBe("llm");
      if (summarizeAction?.type === "llm") {
        expect(summarizeAction.prompt).toBe(
          "You are Notion Research Agent.\n\nSummarize the key findings from the Notion pages.",
        );
      }

      const createAction = getEntry(result, "step_create_summary_page").find(
        (a) => a.type === "llm",
      );

      expect(createAction?.type).toBe("llm");
      if (createAction?.type === "llm") {
        expect(createAction.prompt).toBe(
          "You are Notion Research Agent.\n\nCreate a new Notion page with the summarized findings.",
        );
      }
    });
  });
});

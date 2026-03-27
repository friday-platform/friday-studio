import process from "node:process";
import { createAgent, err, ok } from "@atlas/agent-sdk";
import type { Version3Models, Version3Parameters } from "jira.js";
import { Version3Client } from "jira.js";
import { z } from "zod";
import { parseOperationConfig as parseOpConfig } from "../shared/operation-parser.ts";

/**
 * Output schema for Jira agent operations.
 */
export const JiraOutputSchema = z.object({
  operation: z.string().describe("The operation that was executed"),
  success: z.boolean().describe("Whether the operation succeeded"),
  data: z.object({}).catchall(z.unknown()).describe("Operation-specific output data"),
});

export type JiraOutput = z.infer<typeof JiraOutputSchema>;

// ---------------------------------------------------------------------------
// Operation config schemas
// ---------------------------------------------------------------------------

const IssueViewConfigSchema = z.object({
  operation: z.literal("issue-view"),
  issue_key: z.string(),
});

const IssueSearchConfigSchema = z.object({
  operation: z.literal("issue-search"),
  jql: z.string(),
  max_results: z.number().optional(),
});

const IssueCreateConfigSchema = z.object({
  operation: z.literal("issue-create"),
  project_key: z.string(),
  summary: z.string(),
  description: z.string().optional(),
  issue_type: z.string().optional(),
  labels: z.array(z.string()).optional(),
  priority: z.string().optional(),
});

const IssueUpdateConfigSchema = z.object({
  operation: z.literal("issue-update"),
  issue_key: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  labels: z.array(z.string()).optional(),
  priority: z.string().optional(),
});

const IssueTransitionConfigSchema = z.object({
  operation: z.literal("issue-transition"),
  issue_key: z.string(),
  transition_name: z.string(),
});

const IssueCommentConfigSchema = z.object({
  operation: z.literal("issue-comment"),
  issue_key: z.string(),
  body: z.string(),
});

const OperationConfigSchema = z.discriminatedUnion("operation", [
  IssueViewConfigSchema,
  IssueSearchConfigSchema,
  IssueCreateConfigSchema,
  IssueUpdateConfigSchema,
  IssueTransitionConfigSchema,
  IssueCommentConfigSchema,
]);

type OperationConfig = z.infer<typeof OperationConfigSchema>;

// ---------------------------------------------------------------------------
// ADF (Atlassian Document Format) plaintext extraction
// ---------------------------------------------------------------------------

/**
 * Convert a plain text string with optional markdown links to ADF inline content nodes.
 *
 * Parses `[text](url)` patterns into ADF text nodes with link marks.
 * Everything else becomes plain text nodes.
 */
export function textToAdfContent(
  text: string,
): Array<{
  type: string;
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, string> }>;
}> {
  const nodes: Array<{
    type: string;
    text?: string;
    marks?: Array<{ type: string; attrs?: Record<string, string> }>;
  }> = [];
  const linkPattern = /\[([^\]]+)\]\(((?:[^()]*|\([^()]*\))*)\)/g;
  let lastIndex = 0;

  for (const match of text.matchAll(linkPattern)) {
    const matchIndex = match.index ?? 0;
    // Add preceding plain text
    if (matchIndex > lastIndex) {
      nodes.push({ type: "text", text: text.slice(lastIndex, matchIndex) });
    }
    // Add linked text with link mark
    nodes.push({
      type: "text",
      text: match[1],
      marks: [{ type: "link", attrs: { href: match[2] ?? "" } }],
    });
    lastIndex = matchIndex + match[0].length;
  }

  // Add trailing plain text
  if (lastIndex < text.length) {
    nodes.push({ type: "text", text: text.slice(lastIndex) });
  }

  // If no content was generated, return a single text node
  if (nodes.length === 0) {
    nodes.push({ type: "text", text });
  }

  return nodes;
}

/**
 * Recursively extract plaintext from an ADF (Atlassian Document Format) node.
 *
 * ADF is a nested JSON tree where text lives in `content[].content[].text`.
 * This walks all nodes depth-first, collecting text from `text`-type nodes.
 */
export function extractAdfText(node: unknown): string {
  if (typeof node !== "object" || node === null) {
    return "";
  }

  // `"key" in obj` on `object` narrows to `Record<"key", unknown>` (per CLAUDE.md rules)
  if ("text" in node) {
    const textVal = node.text;
    if (typeof textVal === "string") return textVal;
  }

  if ("content" in node && Array.isArray(node.content)) {
    const children: unknown[] = node.content;
    return children.map((child) => extractAdfText(child)).join("");
  }

  return "";
}

// ---------------------------------------------------------------------------
// URL / site helpers
// ---------------------------------------------------------------------------

/**
 * Build the Jira REST API base URL from a site hostname.
 *
 * Accepts bare hostnames ("acme.atlassian.net") or full URLs
 * ("https://acme.atlassian.net"). Always returns "https://{host}".
 */
export function buildBaseUrl(site: string): string {
  const trimmed = site.trim();
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    const url = new URL(trimmed);
    return `https://${url.hostname}`;
  }
  return `https://${trimmed}`;
}

// ---------------------------------------------------------------------------
// JSON extraction from prompt (shared across agents)
// ---------------------------------------------------------------------------

/**
 * Parse the operation config from the prompt string.
 *
 * Searches for JSON blocks in code fences, raw JSON objects, or the entire
 * prompt as JSON — delegates to the shared operation parser.
 */
export function parseOperationConfig(prompt: string): OperationConfig {
  return parseOpConfig(prompt, OperationConfigSchema);
}

// ---------------------------------------------------------------------------
// Issue data extraction
// ---------------------------------------------------------------------------

/** Extract a flat summary object from a jira.js Issue. */
function summarizeIssue(issue: Version3Models.Issue): Record<string, unknown> {
  return {
    key: issue.key,
    id: issue.id,
    summary: issue.fields.summary,
    description: extractAdfText(issue.fields.description),
    status: issue.fields.status?.name,
    priority: issue.fields.priority?.name,
    issue_type: issue.fields.issuetype?.name ?? issue.fields.issueType?.name,
    labels: issue.fields.labels,
    assignee: issue.fields.assignee?.displayName,
    reporter: issue.fields.reporter?.displayName,
    created: issue.fields.created,
    updated: issue.fields.updated,
  };
}

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

/**
 * jira — lightweight Jira Cloud agent.
 *
 * Executes structured Jira operations (view, search, create, update, transition,
 * comment) without an LLM. Deterministic, fast, and cheap.
 */
export const jiraAgent = createAgent<string, JiraOutput>({
  id: "jira",
  displayName: "Jira Cloud",
  version: "1.0.0",
  description: [
    "<role>",
    "You are a deterministic Jira Cloud API agent. You execute structured operations against the",
    "Jira REST API v3 without any LLM reasoning. You parse a JSON operation document from the",
    "prompt and make direct API calls, returning structured results.",
    "</role>",
    "",
    "<how_to_use>",
    "1. Include a JSON document in the prompt containing an 'operation' field.",
    "2. The agent extracts the first valid JSON object (supports code fences, inline JSON, or raw JSON).",
    "3. The JSON must match one of the operation schemas below exactly.",
    "4. The agent executes the API call and returns a structured result.",
    "This agent is deterministic — the same input always produces the same API call.",
    "</how_to_use>",
    "",
    "<operations>",
    "<operation name='issue-view'>",
    "Fetch a single issue by key. Returns key, summary, description, status, priority,",
    "issue_type, labels, assignee, reporter, created, updated.",
    "Description is converted from Jira's ADF (Atlassian Document Format) to plaintext",
    "because downstream agents need readable text, not nested JSON structures.",
    "Required fields: operation, issue_key",
    'Schema: { "operation": "issue-view", "issue_key": "PROJ-123" }',
    "</operation>",
    "",
    "<operation name='issue-search'>",
    "Search issues using JQL. Returns an array of issues with the same fields as issue-view.",
    "Required fields: operation, jql",
    "Optional fields: max_results (default: 50, max: 100)",
    'Schema: { "operation": "issue-search", "jql": "project = PROJ AND labels = bug", "max_results": 10 }',
    "</operation>",
    "",
    "<operation name='issue-create'>",
    "Create a new issue in a project. Returns key, id, and self URL of the created issue.",
    "Required fields: operation, project_key, summary",
    'Optional fields: description, issue_type (default: "Bug"), labels (string array), priority',
    'Schema: { "operation": "issue-create", "project_key": "PROJ", "summary": "Title", "issue_type": "Bug", "labels": ["bug"] }',
    "</operation>",
    "",
    "<operation name='issue-update'>",
    "Update fields on an existing issue. All fields except operation and issue_key are optional.",
    "Only provided fields are updated; omitted fields are left unchanged.",
    "Required fields: operation, issue_key",
    "Optional fields: summary, description, labels (replaces entire list — include all desired labels), priority",
    'Schema: { "operation": "issue-update", "issue_key": "PROJ-123", "labels": ["bug", "fixed"] }',
    "</operation>",
    "",
    "<operation name='issue-transition'>",
    "Move an issue to a different status. The agent fetches available transitions and matches",
    "by name (case-insensitive). Fails if no matching transition is found.",
    "Required fields: operation, issue_key, transition_name",
    'Schema: { "operation": "issue-transition", "issue_key": "PROJ-123", "transition_name": "In Progress" }',
    "</operation>",
    "",
    "<operation name='issue-comment'>",
    "Add a comment to an issue. The body supports [markdown links](url) which are converted",
    "to proper Jira ADF link nodes. Plain text is also supported.",
    "Required fields: operation, issue_key, body",
    'Schema: { "operation": "issue-comment", "issue_key": "PROJ-123", "body": "Fixed in [PR #42](https://example.com/pr/42)" }',
    "</operation>",
    "</operations>",
    "",
    "<output_format>",
    "All operations return: { operation: string, success: boolean, data: { ...operation-specific fields } }",
    "On error, returns: { ok: false, error: { reason: string } } with credentials redacted.",
    "</output_format>",
    "",
    "<error_handling>",
    "- Invalid issue key: Jira API returns 404, agent returns error with reason.",
    "- Wrong project key on create: Jira API returns 400, agent returns error with Jira's message.",
    "- No matching transition: Agent returns error listing available transition names.",
    "- Auth failure (401/403): Agent returns error. Check JIRA_EMAIL and JIRA_API_TOKEN.",
    "- All errors redact credentials (email, token, base64) from the message.",
    "</error_handling>",
  ].join("\n"),
  constraints: [
    "Requires three environment variables: JIRA_EMAIL (account email), JIRA_API_TOKEN (API token",
    "from https://id.atlassian.com/manage-profile/security/api-tokens), and JIRA_SITE (Atlassian",
    "site hostname, e.g. acme.atlassian.net). Only supports Jira Cloud (REST API v3). Jira",
    "Server and Data Center use different API versions and authentication and are not supported.",
  ].join(" "),
  useWorkspaceSkills: true,
  expertise: {
    examples: [
      "<examples>",
      "<example>",
      "Input: Fetch bug ticket DEV-4",
      'JSON: {"operation":"issue-view","issue_key":"DEV-4"}',
      'Output: { operation: "issue-view", success: true, data: { key: "DEV-4", summary: "...", status: "To Do", labels: ["bug"], ... } }',
      "</example>",
      "<example>",
      "Input: Find all open bugs in the DEV project",
      'JSON: {"operation":"issue-search","jql":"project = DEV AND labels = bug AND status = \\"To Do\\"","max_results":10}',
      'Output: { operation: "issue-search", success: true, data: { issues: [...], total: 3 } }',
      "</example>",
      "<example>",
      "Input: Create a new high-priority bug about login crashes",
      'JSON: {"operation":"issue-create","project_key":"DEV","summary":"Login page crashes on empty password","issue_type":"Bug","labels":["bug","auth"],"priority":"High"}',
      'Output: { operation: "issue-create", success: true, data: { key: "DEV-5", id: "10014", self: "https://..." } }',
      "</example>",
      "<example>",
      "Input: Add labels to an existing issue",
      'JSON: {"operation":"issue-update","issue_key":"DEV-4","labels":["bug","in-progress"]}',
      'Output: { operation: "issue-update", success: true, data: { issue_key: "DEV-4" } }',
      "</example>",
      "<example>",
      "Input: Move DEV-4 to In Progress",
      'JSON: {"operation":"issue-transition","issue_key":"DEV-4","transition_name":"In Progress"}',
      'Output: { operation: "issue-transition", success: true, data: { issue_key: "DEV-4", from_status: "To Do", to_status: "In Progress" } }',
      "</example>",
      "<example>",
      "Input: Post a comment with a PR link on DEV-4",
      'JSON: {"operation":"issue-comment","issue_key":"DEV-4","body":"Pull request created: [PR #42](https://bitbucket.org/ws/repo/pull-requests/42)"}',
      'Output: { operation: "issue-comment", success: true, data: { issue_key: "DEV-4", comment_id: "10042" } }',
      "</example>",
      "</examples>",
    ],
  },
  outputSchema: JiraOutputSchema,
  environment: {
    required: [
      {
        name: "JIRA_EMAIL",
        description: "Jira account email address",
        linkRef: { provider: "jira", key: "email" },
      },
      {
        name: "JIRA_API_TOKEN",
        description: "Jira API token",
        linkRef: { provider: "jira", key: "api_token" },
      },
      { name: "JIRA_SITE", description: "Atlassian site hostname (e.g. acme.atlassian.net)" },
    ],
  },

  handler: async (prompt, context) => {
    const { env, logger } = context;

    const email = env.JIRA_EMAIL ?? process.env.JIRA_EMAIL;
    const apiToken = env.JIRA_API_TOKEN ?? process.env.JIRA_API_TOKEN;
    const site = env.JIRA_SITE ?? process.env.JIRA_SITE;
    if (!email || !apiToken || !site) {
      return err("JIRA_EMAIL, JIRA_API_TOKEN, and JIRA_SITE environment variables must be set");
    }

    let config: OperationConfig;
    try {
      config = parseOperationConfig(prompt);
    } catch (error) {
      return err(
        `Failed to parse operation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    logger.info("Executing jira operation", { operation: config.operation });

    const host = buildBaseUrl(site);

    try {
      const client = new Version3Client({ host, authentication: { basic: { email, apiToken } } });
      switch (config.operation) {
        case "issue-view": {
          const issue = await client.issues.getIssue({ issueIdOrKey: config.issue_key });

          return ok({ operation: "issue-view", success: true, data: summarizeIssue(issue) });
        }

        case "issue-search": {
          const maxResults = config.max_results ?? 50;
          // Use enhanced search (the legacy endpoint was removed by Atlassian — 410 Gone)
          const searchResult = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
            jql: config.jql,
            maxResults,
            fields: [
              "summary",
              "status",
              "priority",
              "issuetype",
              "labels",
              "assignee",
              "reporter",
              "description",
              "created",
              "updated",
            ],
          });

          const issues = (searchResult.issues ?? []).map((issue) => summarizeIssue(issue));

          return ok({
            operation: "issue-search",
            success: true,
            data: { issues, total: issues.length, max_results: maxResults },
          });
        }

        case "issue-create": {
          const issueType = config.issue_type ?? "Bug";

          const createParams: Version3Parameters.CreateIssue = {
            fields: {
              project: { key: config.project_key },
              summary: config.summary,
              description: config.description
                ? {
                    type: "doc",
                    version: 1,
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: config.description }] },
                    ],
                  }
                : undefined,
              issuetype: { name: issueType },
              labels: config.labels,
              priority: config.priority ? { name: config.priority } : undefined,
            },
          };

          const created = await client.issues.createIssue(createParams);

          logger.info("Jira issue created", { key: created.key, id: created.id });

          return ok({
            operation: "issue-create",
            success: true,
            data: { key: created.key, id: created.id, self: created.self },
          });
        }

        case "issue-update": {
          const updateFields: Version3Models.IssueUpdateDetails["fields"] = {};

          if (config.summary !== undefined) {
            updateFields.summary = config.summary;
          }
          if (config.description !== undefined) {
            updateFields.description = {
              type: "doc",
              version: 1,
              content: [
                { type: "paragraph", content: [{ type: "text", text: config.description }] },
              ],
            };
          }
          if (config.labels !== undefined) {
            updateFields.labels = config.labels;
          }
          if (config.priority !== undefined) {
            updateFields.priority = { name: config.priority };
          }

          await client.issues.editIssue({ issueIdOrKey: config.issue_key, fields: updateFields });

          logger.info("Jira issue updated", { issue_key: config.issue_key });

          return ok({
            operation: "issue-update",
            success: true,
            data: { issue_key: config.issue_key, updated: true },
          });
        }

        case "issue-transition": {
          // 1. Fetch available transitions
          const transitionsData = await client.issues.getTransitions({
            issueIdOrKey: config.issue_key,
          });

          // 2. Find the matching transition (case-insensitive)
          const targetName = config.transition_name.toLowerCase();
          const transitions = transitionsData.transitions ?? [];
          const transition = transitions.find((t) => t.name?.toLowerCase() === targetName);

          if (!transition) {
            const available = transitions.map((t) => t.name ?? "").join(", ");
            return err(
              `Transition "${config.transition_name}" not found. Available transitions: ${available}`,
            );
          }

          // 3. Get current status before transition
          const issueData = await client.issues.getIssue({
            issueIdOrKey: config.issue_key,
            fields: ["status"],
          });
          const fromStatus = issueData.fields.status?.name ?? "Unknown";

          // 4. Execute the transition
          await client.issues.doTransition({
            issueIdOrKey: config.issue_key,
            transition: { id: transition.id },
          });

          const toStatus = transition.to?.name ?? config.transition_name;

          logger.info("Jira issue transitioned", {
            issue_key: config.issue_key,
            from: fromStatus,
            to: toStatus,
          });

          return ok({
            operation: "issue-transition",
            success: true,
            data: { issue_key: config.issue_key, from_status: fromStatus, to_status: toStatus },
          });
        }

        case "issue-comment": {
          const comment = await client.issueComments.addComment({
            issueIdOrKey: config.issue_key,
            comment: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: textToAdfContent(config.body) }],
            },
          });

          const commentId = comment.id ?? "";

          logger.info("Jira comment added", { issue_key: config.issue_key, comment_id: commentId });

          return ok({
            operation: "issue-comment",
            success: true,
            data: { issue_key: config.issue_key, comment_id: commentId },
          });
        }

        default: {
          const _exhaustive: never = config;
          return err(`Unknown operation: ${(_exhaustive as OperationConfig).operation}`);
        }
      }
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      // Redact credentials from any error messages
      for (const secret of [email, apiToken, btoa(`${email}:${apiToken}`)]) {
        message = message.replaceAll(secret, "***");
      }
      logger.error("jira operation failed", { operation: config.operation, error: message });
      return err(`jira ${config.operation} failed: ${message}`);
    }
  },
});

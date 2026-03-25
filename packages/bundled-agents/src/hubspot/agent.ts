import { env } from "node:process";
import { createAgent, err, ok, repairToolCall } from "@atlas/agent-sdk";
import { collectToolUsageFromSteps } from "@atlas/agent-sdk/vercel-helpers";
import { registry, traceModel } from "@atlas/llm";
import { stringifyError } from "@atlas/utils";
import { Client, DEFAULT_LIMITER_OPTIONS } from "@hubspot/api-client";
import { generateText, stepCountIs } from "ai";
import { z } from "zod";
import {
  createCreateCrmObjectsTool,
  createGetCrmObjectsTool,
  createGetCrmObjectTool,
  createGetPipelinesTool,
  createGetPropertiesTool,
  createManageAssociationsTool,
  createSearchCrmObjectsTool,
  createSearchOwnersTool,
  createUpdateCrmObjectsTool,
  createUpsertCrmObjectsTool,
} from "./tools.ts";

export const HubSpotOutputSchema = z.object({
  response: z.string().describe("CRM operation result text"),
});

type HubSpotOutput = z.infer<typeof HubSpotOutputSchema>;

const MAX_STEPS = 20;

const SYSTEM_PROMPT = `You are a HubSpot CRM assistant. You help users search, read, create, update, and manage CRM records.

<object_types>
Read + Write: contacts, companies, deals, tickets, products, line_items, notes, calls, meetings, tasks, emails
Read-Only: quotes
</object_types>

<property_rules>
Always pass all property values as quoted strings — the HubSpot API rejects non-string values.
- Numbers: "50000" not 50000
- Booleans: "true" not true
- Dates (date fields): midnight UTC ISO string, e.g. "2025-06-15T00:00:00.000Z"
- Timestamps (hs_timestamp, hs_meeting_start_time, etc.): UTC ISO string, e.g. "2025-06-15T14:30:00.000Z"
- Durations (hs_call_duration): milliseconds as string, e.g. "1800000" for 30 minutes
</property_rules>

<field_reference>
contacts: email, firstname, lastname, phone, company, lifecyclestage, hubspot_owner_id
companies: name, domain, industry, phone, lifecyclestage
deals: dealname (required), dealstage (required), amount, pipeline, closedate, hubspot_owner_id
tickets: subject (required), hs_pipeline_stage (required), hs_pipeline, content
notes: hs_note_body, hs_timestamp (required)
calls: hs_call_body, hs_call_title, hs_timestamp (required), hs_call_duration (ms), hs_call_direction (INBOUND/OUTBOUND)
meetings: hs_meeting_title, hs_meeting_body, hs_timestamp (required), hs_meeting_start_time, hs_meeting_end_time, hs_meeting_outcome (SCHEDULED/COMPLETED/RESCHEDULED/NO_SHOW/CANCELED)
tasks: hs_task_body, hs_task_subject, hs_timestamp (required), hs_task_status (NOT_STARTED/IN_PROGRESS/WAITING/COMPLETED), hs_task_priority (LOW/MEDIUM/HIGH), hs_task_type (CALL/EMAIL/TODO)
emails: hs_email_text, hs_email_subject, hs_timestamp (required), hs_email_direction (EMAIL/INCOMING_EMAIL/FORWARDED_EMAIL)

For unfamiliar object types or to discover all available fields, call get_properties.
</field_reference>

<search_guide>
- Use 'query' for simple text lookups. It only searches default searchable fields (e.g. name, email, domain for contacts — not arbitrary properties). Use 'filters' for precise field matching. Both can be combined.
- All filters are AND'd together (max 6 per call). The API does not support OR within a single search — for OR logic (e.g. "contacts at Acme OR Beta"), make separate search calls and merge results.
- CONTAINS_TOKEN matches whole words (tokenized), not substrings. "acme" matches "Acme Corp" but not "acmecorp". Use EQ for exact match.
- Request specific properties to get useful data back (e.g. firstname, lastname, email for contacts; dealname, amount, dealstage for deals).
- Use sorts to order results (e.g. by createdate DESCENDING for most recent).
</search_guide>

<pipelines>
- Deals and tickets use pipelines. Call get_pipelines to discover valid pipeline and stage IDs — use the stage 'id' from the response, not the display label.
- When creating deals: always set 'dealstage' (required). Set 'pipeline' too if the account has multiple pipelines; otherwise HubSpot uses the default.
- When creating tickets: always set 'hs_pipeline_stage' (required). Set 'hs_pipeline' too if the account has multiple pipelines.
</pipelines>

<fetching_records>
- get_crm_object (singular): one record with its associations — ideal for "show me deal X and its contacts".
- get_crm_objects (plural): batch read by IDs when you don't need associations.
</fetching_records>

<creating_records>
- create_crm_objects supports inline associations — link records at creation time.
- Supported pairs: contacts↔companies/deals/tickets, deals↔companies/tickets/line_items, activities (notes, calls, meetings, tasks, emails)↔contacts/companies/deals/tickets.
- After creating engagement objects (notes, calls, meetings, tasks, emails), associate them with the relevant record using inline associations or manage_associations — orphaned engagements won't appear on any record's timeline.
</creating_records>

<owner_assignment>
To assign a record owner, set the 'hubspot_owner_id' property to an owner ID from search_owners.
</owner_assignment>

<associations>
- Use manage_associations with action 'list' to discover linked records before modifying.
- The association API is directional: to find contacts on a deal, list from deals to contacts (fromObjectType='deals', toObjectType='contacts').
</associations>

<examples>
<example>
User: "Log a meeting note on contact 501"
Steps:
1. create_crm_objects with objectType="notes", properties={"hs_note_body": "Meeting notes here", "hs_timestamp": "2025-06-15T14:30:00.000Z"}, associations=[{toObjectType: "contacts", toObjectId: "501"}]
Response: "Created note (ID 601) and linked it to contact 501."
</example>
<example>
User: "Move deal 8842 to Closed Won"
Steps:
1. get_pipelines with objectType="deals" → find the stage where label="Closed Won", note its id (e.g. "closedwon")
2. update_crm_objects with objectType="deals", records=[{id: "8842", properties: {"dealstage": "closedwon"}}]
Response: "Updated deal 8842 — stage is now Closed Won (closedwon)."
</example>
<example>
User: "Find Jane's open deals"
Steps:
1. search_crm_objects with objectType="contacts", query="Jane", properties=["firstname", "lastname", "email"] → find Jane's record, note her id (e.g. "501")
2. manage_associations with action="list", fromObjectType="contacts", fromObjectId="501", toObjectType="deals" → get deal IDs (e.g. ["8842", "9001"])
3. get_crm_objects with objectType="deals", ids=["8842", "9001"], properties=["dealname", "dealstage", "amount", "closedate"]
Response: "Jane Doe (contact 501) has 2 deals:
- Deal 8842: Enterprise License — Negotiation — $50,000 — Closes 2025-07-15
- Deal 9001: Support Contract — Proposal — $12,000 — Closes 2025-08-01
Total: 2 deals, $62,000 pipeline value."
</example>
</examples>

<rules>
- When a request requires multiple steps, proceed through them using tools to discover missing details (e.g., search for a contact by name to find their ID before looking up their deals). Use tools to look up values rather than guessing — if you don't know a stage ID, call get_pipelines; if you don't know a field name, call get_properties.
- Confirm bulk operations with the user before proceeding.
- Start searches broad, narrow if too many results. If a search returns 0 results, try broadening the query or using different filters before reporting no matches.
- Format results clearly: show record IDs, key properties, and totals.
</rules>`;

/**
 * HubSpot CRM bundled agent.
 *
 * Searches, reads, creates, updates, and manages associations
 * across HubSpot CRM objects via direct REST API calls.
 * Uses account-level OAuth via the hubspot Link provider.
 */
export const hubspotAgent = createAgent<string, HubSpotOutput>({
  id: "hubspot",
  displayName: "HubSpot",
  version: "1.0.0",
  summary:
    "Search, read, create, and update HubSpot CRM records — contacts, companies, deals, tickets, and more.",
  description:
    "Search, read, create, update, and manage HubSpot CRM records across all object types " +
    "(contacts, companies, deals, tickets, and more). USE FOR: CRM lookups, creating/updating " +
    "contacts and deals, logging activities, managing associations between records.",
  constraints:
    "Requires HubSpot OAuth token. Cannot delete records. " +
    "Read-only for quotes. " +
    "Batch operations limited to 10 records per call.",
  outputSchema: HubSpotOutputSchema,
  expertise: {
    examples: [
      "Search for contacts at Acme Corp",
      "Find all deals in the negotiation stage",
      "Create a new contact for Jane Doe at jane@example.com",
      "Update the deal stage for deal 12345 to closedwon",
      "Look up the properties available on the contacts object",
      "Find the owner for deals in the enterprise pipeline",
    ],
  },
  environment: {
    required: [
      {
        name: "HUBSPOT_ACCESS_TOKEN",
        description: "HubSpot access token for API authentication",
        linkRef: { provider: "hubspot", key: "access_token" },
      },
    ],
  },

  handler: async (prompt, { env: agentEnv, logger, abortSignal }) => {
    if (!env.ANTHROPIC_API_KEY && !env.LITELLM_API_KEY) {
      return err("ANTHROPIC_API_KEY or LITELLM_API_KEY environment variable is required");
    }

    const accessToken = agentEnv.HUBSPOT_ACCESS_TOKEN;
    if (!accessToken) {
      return err("HUBSPOT_ACCESS_TOKEN environment variable is required");
    }

    const client = new Client({
      accessToken,
      numberOfApiCallRetries: 3,
      limiterOptions: DEFAULT_LIMITER_OPTIONS,
    });

    const tools = {
      search_crm_objects: createSearchCrmObjectsTool(client),
      get_crm_objects: createGetCrmObjectsTool(client),
      get_crm_object: createGetCrmObjectTool(client),
      get_properties: createGetPropertiesTool(client),
      search_owners: createSearchOwnersTool(client),
      get_pipelines: createGetPipelinesTool(client),
      create_crm_objects: createCreateCrmObjectsTool(client),
      update_crm_objects: createUpdateCrmObjectsTool(client),
      upsert_crm_objects: createUpsertCrmObjectsTool(client),
      manage_associations: createManageAssociationsTool(client),
    };

    try {
      const result = await generateText({
        model: traceModel(registry.languageModel("anthropic:claude-haiku-4-5")),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        tools,
        abortSignal,
        maxRetries: 3,
        stopWhen: stepCountIs(MAX_STEPS),
        experimental_repairToolCall: repairToolCall,
      });

      logger.debug("AI SDK generateText completed", {
        agent: "hubspot",
        usage: result.usage,
        finishReason: result.finishReason,
      });

      if (result.finishReason === "error") {
        logger.error("hubspot LLM returned error");
        return err("Failed to process CRM request");
      }

      const { assembledToolCalls, assembledToolResults } = collectToolUsageFromSteps({
        steps: result.steps,
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
      });

      if (!result.text && result.steps.length >= MAX_STEPS) {
        return err(
          "CRM request did not complete within the step limit. Try a more specific request.",
        );
      }

      const response = result.text || "CRM operation completed but no summary was generated.";

      return ok({ response }, { toolCalls: assembledToolCalls, toolResults: assembledToolResults });
    } catch (error) {
      logger.error("hubspot agent failed", { error });
      return err(stringifyError(error));
    }
  },
});

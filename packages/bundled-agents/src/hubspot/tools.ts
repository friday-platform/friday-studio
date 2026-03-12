import { stringifyError } from "@atlas/utils";
import type { Client } from "@hubspot/api-client";
import { AssociationSpecAssociationCategoryEnum } from "@hubspot/api-client/lib/codegen/crm/objects/models/AssociationSpec.js";
import { FilterOperatorEnum } from "@hubspot/api-client/lib/codegen/crm/objects/models/Filter.js";
import { tool } from "ai";
import { z } from "zod";

// -- Object Type Enums (module-private) --

const ALL_OBJECT_TYPES = [
  "contacts",
  "companies",
  "deals",
  "tickets",
  "products",
  "line_items",
  "notes",
  "calls",
  "meetings",
  "tasks",
  "emails",
  "quotes",
] as const;

const WRITABLE_OBJECT_TYPES = [
  "contacts",
  "companies",
  "deals",
  "tickets",
  "products",
  "line_items",
  "notes",
  "calls",
  "meetings",
  "tasks",
  "emails",
] as const;

const CrmObjectType = z.enum(ALL_OBJECT_TYPES as unknown as [string, ...string[]]);

const WritableCrmObjectType = z.enum(WRITABLE_OBJECT_TYPES as unknown as [string, ...string[]]);

// -- Tool Input Schemas (module-private) --

const FilterSchema = z.object({
  propertyName: z.string().describe("CRM property name, e.g. 'email', 'dealstage', 'createdate'"),
  operator: z
    .nativeEnum(FilterOperatorEnum)
    .describe(
      "Filter operator. Use EQ/NEQ for exact match, CONTAINS_TOKEN for text search, " +
        "GT/LT/GTE/LTE for comparisons, BETWEEN with value+highValue for ranges, " +
        "IN/NOT_IN with values array for sets, HAS_PROPERTY/NOT_HAS_PROPERTY for existence",
    ),
  value: z
    .string()
    .optional()
    .describe("Single filter value for EQ, NEQ, GT, LT, GTE, LTE, CONTAINS_TOKEN"),
  values: z
    .array(z.string())
    .optional()
    .describe("Multiple filter values for IN and NOT_IN operators"),
  highValue: z
    .string()
    .optional()
    .describe("Upper bound for BETWEEN operator; use with value as lower bound"),
});

const SortSchema = z.object({
  propertyName: z.string().describe("CRM property name to sort by, e.g. 'createdate', 'lastname'"),
  direction: z.enum(["ASCENDING", "DESCENDING"]).default("ASCENDING").describe("Sort direction"),
});

const SearchCrmObjectsInput = z.object({
  objectType: CrmObjectType.describe("CRM object type to search"),
  query: z
    .string()
    .optional()
    .describe(
      "Free-text search across default searchable properties (name, email, domain, etc.). " +
        "Simpler alternative to filters for quick lookups, e.g. 'john@acme.com' or 'Acme Corp'",
    ),
  filters: z
    .array(FilterSchema)
    .default([])
    .describe("All filters are AND'd together. Omit for unfiltered results"),
  sorts: z.array(SortSchema).default([]).describe("Sort order for results"),
  properties: z
    .array(z.string())
    .default([])
    .describe(
      "Property names to return, e.g. ['firstname', 'email']. Empty returns default properties",
    ),
  limit: z.number().int().min(1).max(100).default(10).describe("Number of results per page"),
  after: z
    .string()
    .optional()
    .describe("Opaque pagination cursor from a previous response's nextCursor"),
});

const GetCrmObjectsInput = z.object({
  objectType: CrmObjectType.describe("CRM object type to fetch"),
  ids: z.array(z.string()).min(1).max(100).describe("Record IDs to fetch, e.g. ['123', '456']"),
  properties: z
    .array(z.string())
    .default([])
    .describe("Property names to return. Empty returns default properties"),
});

const GetCrmObjectInput = z.object({
  objectType: CrmObjectType.describe("CRM object type to fetch"),
  id: z.string().describe("Record ID to fetch"),
  properties: z
    .array(z.string())
    .default([])
    .describe("Property names to return. Empty returns default properties"),
  associations: z
    .array(CrmObjectType)
    .default([])
    .describe(
      "Object types to include associations for, e.g. ['contacts', 'companies']. " +
        "Returns IDs of associated records for each requested type",
    ),
});

const AssociationInput = z.object({
  toObjectType: CrmObjectType.describe("Target object type to associate with, e.g. 'contacts'"),
  toObjectId: z.string().describe("Target record ID to associate with"),
});

const CreateCrmObjectsInput = z.object({
  objectType: WritableCrmObjectType.describe("CRM object type to create"),
  records: z
    .array(
      z.object({
        properties: z
          .record(z.string(), z.string())
          .describe("Field name/value pairs, e.g. { firstname: 'Jane', email: 'jane@co.com' }"),
        associations: z
          .array(AssociationInput)
          .default([])
          .describe(
            "Optional associations to create with the record. " +
              "Supported pairs: contacts↔companies/deals/tickets, deals↔companies/tickets/line_items, " +
              "notes/calls/meetings/tasks/emails↔contacts/companies/deals/tickets",
          ),
      }),
    )
    .min(1)
    .max(10)
    .describe("Records to create (1-10)"),
});

const UpdateCrmObjectsInput = z.object({
  objectType: WritableCrmObjectType.describe("CRM object type to update"),
  records: z
    .array(
      z.object({
        id: z.string().describe("Existing record ID to update"),
        properties: z
          .record(z.string(), z.string())
          .describe("Field name/value pairs to update, e.g. { dealstage: 'closedwon' }"),
      }),
    )
    .min(1)
    .max(10)
    .describe("Records to update (1-10). Only specified properties are changed"),
});

const UpsertCrmObjectsInput = z.object({
  objectType: WritableCrmObjectType.describe("CRM object type to upsert"),
  idProperty: z
    .string()
    .describe(
      "Property with unique values used to match existing records, e.g. 'email' for contacts, " +
        "'domain' for companies. If a record with the matching value exists it is updated, otherwise created",
    ),
  records: z
    .array(
      z.object({
        id: z
          .string()
          .describe(
            "Value of the idProperty for this record, e.g. 'jane@acme.com' when idProperty is 'email'",
          ),
        properties: z
          .record(z.string(), z.string())
          .describe("Field name/value pairs to set, e.g. { firstname: 'Jane', lastname: 'Doe' }"),
      }),
    )
    .min(1)
    .max(10)
    .describe("Records to upsert (1-10). Each is created or updated based on idProperty match"),
});

const GetPropertiesInput = z.object({
  objectType: CrmObjectType.describe("CRM object type to get property definitions for"),
});

const SearchOwnersInput = z.object({
  email: z.string().optional().describe("Filter by email address, e.g. 'jane@company.com'"),
  limit: z.number().int().min(1).max(100).default(20).describe("Number of results per page"),
  after: z
    .string()
    .optional()
    .describe("Opaque pagination cursor from a previous response's nextCursor"),
});

const PipelineObjectType = z
  .enum(["deals", "tickets"])
  .describe("Object type that supports pipelines. Only deals and tickets have pipelines");

const GetPipelinesInput = z.object({ objectType: PipelineObjectType });

const ManageAssociationsInput = z.object({
  action: z
    .enum(["link", "unlink", "list"])
    .describe("'link' creates, 'unlink' removes, 'list' retrieves associations from a record"),
  fromObjectType: CrmObjectType.describe("Source object type, e.g. 'notes'"),
  fromObjectId: z.string().describe("Source record ID"),
  toObjectType: CrmObjectType.describe("Target object type, e.g. 'contacts'"),
  toObjectId: z
    .string()
    .optional()
    .describe("Target record ID. Required for link/unlink, omit for list"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe("Max associations to return (list action only)"),
  after: z.string().optional().describe("Pagination cursor (list action only)"),
});

// -- Helpers (module-private) --

/**
 * Normalizes the SDK batch response union.
 * BatchResponseSimplePublicObject lacks numErrors/errors;
 * BatchResponseSimplePublicObjectWithErrors has them optionally.
 */
function normalizeBatchResponse<T extends { id: string }>(response: {
  status: string;
  results: Array<T>;
  numErrors?: number;
  errors?: Array<{ status: string; message: string }>;
}) {
  return {
    results: response.results,
    numErrors: "numErrors" in response ? (response.numErrors ?? 0) : 0,
    errors:
      "errors" in response
        ? (response.errors?.map((e) => ({ status: e.status, message: e.message })) ?? [])
        : [],
  };
}

/**
 * Maps (fromObjectType, toObjectType) → HubSpot default association type ID.
 * Values sourced from @hubspot/api-client AssociationTypes enum.
 */
const DEFAULT_ASSOCIATION_TYPES: Record<string, Record<string, number>> = {
  contacts: { companies: 279, deals: 4, tickets: 15 },
  companies: { contacts: 280, deals: 342, tickets: 340 },
  deals: { contacts: 3, companies: 341, tickets: 27, line_items: 19 },
  tickets: { contacts: 16, companies: 339, deals: 28 },
  notes: { contacts: 202, companies: 190, deals: 214, tickets: 228 },
  calls: { contacts: 194, companies: 182, deals: 206, tickets: 220 },
  meetings: { contacts: 200, companies: 188, deals: 212, tickets: 226 },
  tasks: { contacts: 204, companies: 192, deals: 216, tickets: 230 },
  emails: { contacts: 198, companies: 186, deals: 210, tickets: 224 },
  products: {},
  line_items: { deals: 20 },
};

// -- Tool Factories --

/**
 * Creates the search_crm_objects tool that searches HubSpot CRM objects
 * with filters, sorts, and pagination.
 */
export function createSearchCrmObjectsTool(client: Client) {
  return tool({
    description:
      "Search HubSpot CRM records with free-text query and/or structured filters. " +
      "Use 'query' for simple lookups (searches name, email, domain, etc.). " +
      "Use 'filters' for precise matching (AND'd together). Both can be combined. " +
      "Pass the nextCursor from the response as 'after' to paginate through results.",
    inputSchema: SearchCrmObjectsInput,
    execute: async (input) => {
      try {
        const filterGroups = input.filters.length > 0 ? [{ filters: input.filters }] : [];

        const sorts = input.sorts.map((s) => `${s.propertyName}:${s.direction}`);

        const { results, total, paging } = await client.crm.objects.searchApi.doSearch(
          input.objectType,
          {
            query: input.query,
            filterGroups,
            properties: input.properties,
            sorts,
            limit: input.limit,
            after: input.after,
          },
        );

        return {
          total,
          results: results.map((r) => ({ id: r.id, properties: r.properties })),
          hasMore: paging?.next !== undefined,
          nextCursor: paging?.next?.after,
        };
      } catch (error) {
        return { error: stringifyError(error) };
      }
    },
  });
}

/**
 * Creates the get_crm_objects tool that fetches HubSpot CRM objects by ID
 * with specific properties via batch read.
 */
export function createGetCrmObjectsTool(client: Client) {
  return tool({
    description:
      "Fetch HubSpot CRM records by their IDs via batch read. " +
      "Use when you already have record IDs and need their properties. " +
      "Returns each record's ID and requested properties.",
    inputSchema: GetCrmObjectsInput,
    execute: async (input) => {
      try {
        const response = await client.crm.objects.batchApi.read(input.objectType, {
          inputs: input.ids.map((id) => ({ id })),
          properties: input.properties,
          propertiesWithHistory: [],
        });
        const batch = normalizeBatchResponse(response);

        return {
          results: batch.results.map((r) => ({ id: r.id, properties: r.properties })),
          numErrors: batch.numErrors,
          errors: batch.errors,
        };
      } catch (error) {
        return { error: stringifyError(error) };
      }
    },
  });
}

/**
 * Creates the get_crm_object tool that fetches a single HubSpot CRM record
 * by ID with optional associated record IDs.
 */
export function createGetCrmObjectTool(client: Client) {
  return tool({
    description:
      "Fetch a single HubSpot CRM record by ID with optional associated records. " +
      "More efficient than get_crm_objects + manage_associations when you need " +
      "one record with its associations (e.g. 'show me deal 123 and its contacts'). " +
      "Pass association types to include (e.g. ['contacts', 'companies']) to get linked record IDs.",
    inputSchema: GetCrmObjectInput,
    execute: async (input) => {
      try {
        const result = await client.crm.objects.basicApi.getById(
          input.objectType,
          input.id,
          input.properties.length > 0 ? input.properties : undefined,
          undefined,
          input.associations.length > 0 ? input.associations : undefined,
        );

        const associations: Record<string, Array<{ id: string; type: string }>> = {};
        if (result.associations) {
          for (const [objectType, collection] of Object.entries(result.associations)) {
            associations[objectType] = collection.results.map((a) => ({ id: a.id, type: a.type }));
          }
        }

        return {
          id: result.id,
          properties: result.properties,
          associations: Object.keys(associations).length > 0 ? associations : undefined,
        };
      } catch (error) {
        return { error: stringifyError(error) };
      }
    },
  });
}

/**
 * Creates the get_properties tool that retrieves property definitions
 * for a HubSpot CRM object type.
 */
export function createGetPropertiesTool(client: Client) {
  return tool({
    description:
      "Discover available fields for a CRM object type. " +
      "Returns each property's name, label, type, and valid option values. " +
      "Call this before creating or updating records to learn required fields and accepted values.",
    inputSchema: GetPropertiesInput,
    execute: async (input) => {
      try {
        const { results } = await client.crm.properties.coreApi.getAll(input.objectType);

        return {
          results: results
            .filter((p) => !p.hidden)
            .map((p) => ({
              name: p.name,
              label: p.label,
              type: p.type,
              fieldType: p.fieldType,
              options: p.options.map((o) => ({ label: o.label, value: o.value })),
            })),
        };
      } catch (error) {
        return { error: stringifyError(error) };
      }
    },
  });
}

/**
 * Creates the search_owners tool that searches HubSpot account owners,
 * optionally filtered by email.
 */
export function createSearchOwnersTool(client: Client) {
  return tool({
    description:
      "Find HubSpot account owners (users). " +
      "Use to look up owner IDs for assigning records via hubspot_owner_id property. " +
      "Supports filtering by email and pagination.",
    inputSchema: SearchOwnersInput,
    execute: async (input) => {
      try {
        const { results, paging } = await client.crm.owners.ownersApi.getPage(
          input.email,
          input.after,
          input.limit,
        );

        return {
          results: results.map((o) => ({
            id: o.id,
            email: o.email,
            firstName: o.firstName ?? "",
            lastName: o.lastName ?? "",
          })),
          hasMore: paging?.next !== undefined,
          nextCursor: paging?.next?.after,
        };
      } catch (error) {
        return { error: stringifyError(error) };
      }
    },
  });
}

/**
 * Creates the get_pipelines tool that retrieves pipeline definitions
 * and their stages for deals or tickets.
 */
export function createGetPipelinesTool(client: Client) {
  return tool({
    description:
      "Get pipeline definitions and their stages for deals or tickets. " +
      "Returns each pipeline's ID, label, and ordered stages with IDs, labels, and metadata " +
      "(probability for deal stages, ticketState for ticket stages). " +
      "Call this before updating dealstage or hs_pipeline_stage to discover valid values.",
    inputSchema: GetPipelinesInput,
    execute: async (input) => {
      try {
        const { results } = await client.crm.pipelines.pipelinesApi.getAll(input.objectType);

        return {
          results: results.map((p) => ({
            id: p.id,
            label: p.label,
            displayOrder: p.displayOrder,
            stages: p.stages
              .sort((a, b) => a.displayOrder - b.displayOrder)
              .map((s) => ({
                id: s.id,
                label: s.label,
                displayOrder: s.displayOrder,
                metadata: s.metadata,
              })),
          })),
        };
      } catch (error) {
        return { error: stringifyError(error) };
      }
    },
  });
}

/**
 * Creates the create_crm_objects tool that batch-creates HubSpot CRM objects.
 * Only writable object types are accepted (contacts, companies, deals, tickets,
 * products, line_items, notes, calls, meetings, tasks, emails).
 */
export function createCreateCrmObjectsTool(client: Client) {
  return tool({
    description:
      "Create new HubSpot CRM records in batch (1-10 per call). " +
      "For unfamiliar object types, call get_properties first to discover required fields. " +
      "Returns created record IDs and properties. " +
      "Supports inline associations to link records at creation time.",
    inputSchema: CreateCrmObjectsInput,
    execute: async (input) => {
      try {
        const skippedAssociations: string[] = [];

        const inputs = input.records.map((r) => {
          const associations: Array<{
            to: { id: string };
            types: Array<{
              associationCategory: AssociationSpecAssociationCategoryEnum;
              associationTypeId: number;
            }>;
          }> = [];
          for (const a of r.associations ?? []) {
            const typeId = DEFAULT_ASSOCIATION_TYPES[input.objectType]?.[a.toObjectType];
            if (typeId !== undefined) {
              associations.push({
                to: { id: a.toObjectId },
                types: [
                  {
                    associationCategory: AssociationSpecAssociationCategoryEnum.HubspotDefined,
                    associationTypeId: typeId,
                  },
                ],
              });
            } else {
              skippedAssociations.push(`${input.objectType} → ${a.toObjectType}`);
            }
          }
          return { properties: r.properties, associations };
        });

        const response = await client.crm.objects.batchApi.create(input.objectType, { inputs });
        const batch = normalizeBatchResponse(response);

        return {
          results: batch.results.map((r) => ({ id: r.id, properties: r.properties })),
          numErrors: batch.numErrors,
          errors: batch.errors,
          skippedAssociations:
            skippedAssociations.length > 0
              ? `No default association type for: ${skippedAssociations.join(", ")}. Use manage_associations instead.`
              : undefined,
        };
      } catch (error) {
        return { error: stringifyError(error) };
      }
    },
  });
}

/**
 * Creates the update_crm_objects tool that batch-updates existing HubSpot CRM objects.
 * Only writable object types are accepted (contacts, companies, deals, tickets,
 * products, line_items, notes, calls, meetings, tasks, emails).
 */
export function createUpdateCrmObjectsTool(client: Client) {
  return tool({
    description:
      "Update existing HubSpot CRM records in batch (1-10 per call). " +
      "Only specified properties are changed; omitted properties are untouched. " +
      "For unfamiliar fields, call get_properties to discover valid names and values.",
    inputSchema: UpdateCrmObjectsInput,
    execute: async (input) => {
      try {
        const response = await client.crm.objects.batchApi.update(input.objectType, {
          inputs: input.records.map((r) => ({ id: r.id, properties: r.properties })),
        });
        const batch = normalizeBatchResponse(response);

        return {
          results: batch.results.map((r) => ({ id: r.id, properties: r.properties })),
          numErrors: batch.numErrors,
          errors: batch.errors,
        };
      } catch (error) {
        return { error: stringifyError(error) };
      }
    },
  });
}

/**
 * Creates the upsert_crm_objects tool that creates or updates HubSpot CRM objects
 * based on a unique property match (e.g. email for contacts, domain for companies).
 */
export function createUpsertCrmObjectsTool(client: Client) {
  return tool({
    description:
      "Create or update HubSpot CRM records in batch (1-10 per call) based on a unique property. " +
      "If a record with the matching idProperty value exists, it is updated; otherwise a new record is created. " +
      "Each result includes 'new: true' if created or 'new: false' if updated. " +
      "Common idProperty values: 'email' for contacts, 'domain' for companies.",
    inputSchema: UpsertCrmObjectsInput,
    execute: async (input) => {
      try {
        const response = await client.crm.objects.batchApi.upsert(input.objectType, {
          inputs: input.records.map((r) => ({
            id: r.id,
            idProperty: input.idProperty,
            properties: r.properties,
          })),
        });
        const normalized = normalizeBatchResponse(response);

        return {
          results: normalized.results.map((r) => ({
            id: r.id,
            properties: r.properties,
            new: "_new" in r ? Boolean(r._new) : undefined,
          })),
          numErrors: normalized.numErrors,
          errors: normalized.errors,
        };
      } catch (error) {
        return { error: stringifyError(error) };
      }
    },
  });
}

/**
 * Creates the manage_associations tool that links, unlinks,
 * or lists associations between HubSpot CRM objects via the v4 associations API.
 */
export function createManageAssociationsTool(client: Client) {
  return tool({
    description:
      "Create, remove, or list associations between HubSpot CRM records. " +
      "Use 'list' to find what records are associated (e.g. contacts on a deal). " +
      "Use 'link'/'unlink' to create/remove associations. " +
      "Uses HubSpot's default association type for the object pair.",
    inputSchema: ManageAssociationsInput,
    execute: async (input) => {
      const { action, fromObjectType, fromObjectId, toObjectType } = input;

      try {
        if (action === "list") {
          const { results, paging } = await client.crm.associations.v4.basicApi.getPage(
            fromObjectType,
            fromObjectId,
            toObjectType,
            input.after,
            input.limit,
          );

          return {
            status: "success" as const,
            action,
            from: { objectType: fromObjectType, objectId: fromObjectId },
            toObjectType,
            results: results.map((r) => ({ toObjectId: r.toObjectId })),
            hasMore: paging?.next !== undefined,
            nextCursor: paging?.next?.after,
          };
        }

        const toObjectId = input.toObjectId;
        if (!toObjectId) {
          return {
            status: "error" as const,
            action,
            from: { objectType: fromObjectType, objectId: fromObjectId },
            to: { objectType: toObjectType, objectId: "" },
            error: "toObjectId is required for link/unlink actions",
          };
        }

        const details = {
          action,
          from: { objectType: fromObjectType, objectId: fromObjectId },
          to: { objectType: toObjectType, objectId: toObjectId },
        };

        if (action === "link") {
          await client.crm.associations.v4.basicApi.createDefault(
            fromObjectType,
            fromObjectId,
            toObjectType,
            toObjectId,
          );
        } else {
          await client.crm.associations.v4.basicApi.archive(
            fromObjectType,
            fromObjectId,
            toObjectType,
            toObjectId,
          );
        }
        return { status: "success" as const, ...details };
      } catch (error) {
        return {
          status: "error" as const,
          action,
          from: { objectType: fromObjectType, objectId: fromObjectId },
          toObjectType,
          error: stringifyError(error),
        };
      }
    },
  });
}

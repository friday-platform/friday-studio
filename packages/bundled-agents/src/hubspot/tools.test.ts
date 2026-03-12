import type { Client } from "@hubspot/api-client";
import { FilterOperatorEnum } from "@hubspot/api-client/lib/codegen/crm/objects/models/Filter.js";
import { describe, expect, it, vi } from "vitest";
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

const TOOL_CONTEXT = {
  toolCallId: "test",
  messages: [] as never[],
  abortSignal: new AbortController().signal,
};

/** Extracts execute from an AI SDK tool, throwing if not defined. */
function getExecute<T>(toolDef: { execute?: T }): NonNullable<T> {
  const { execute } = toolDef;
  if (!execute) throw new Error("Tool execute is undefined");
  return execute;
}

// -- Search CRM Objects --

describe("createSearchCrmObjectsTool", () => {
  function createMockClient() {
    const doSearch = vi.fn<(objectType: string, request: unknown) => Promise<unknown>>();
    const client = { crm: { objects: { searchApi: { doSearch } } } } as unknown as Client;
    return { client, doSearch };
  }

  it("wraps filters into filterGroups and formats sorts as colon-separated strings", async () => {
    const { client, doSearch } = createMockClient();
    doSearch.mockResolvedValue({ results: [], total: 0, paging: undefined });

    const execute = getExecute(createSearchCrmObjectsTool(client));
    await execute(
      {
        objectType: "contacts",
        filters: [{ propertyName: "email", operator: FilterOperatorEnum.Eq, value: "a@b.com" }],
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
        properties: ["email"],
        limit: 5,
        after: undefined,
      },
      TOOL_CONTEXT,
    );

    expect(doSearch).toHaveBeenCalledWith("contacts", {
      filterGroups: [
        { filters: [{ propertyName: "email", operator: FilterOperatorEnum.Eq, value: "a@b.com" }] },
      ],
      properties: ["email"],
      sorts: ["createdate:DESCENDING"],
      limit: 5,
      after: undefined,
    });
  });

  it("groups multiple filters into a single filterGroup (AND semantics)", async () => {
    const { client, doSearch } = createMockClient();
    doSearch.mockResolvedValue({ results: [], total: 0, paging: undefined });

    const filters = [
      { propertyName: "lifecyclestage", operator: FilterOperatorEnum.Eq, value: "lead" },
      { propertyName: "createdate", operator: FilterOperatorEnum.Gte, value: "2025-01-01" },
      {
        propertyName: "hs_email_domain",
        operator: FilterOperatorEnum.ContainsToken,
        value: "acme.com",
      },
    ];

    const execute = getExecute(createSearchCrmObjectsTool(client));
    await execute(
      {
        objectType: "contacts",
        filters,
        sorts: [],
        properties: ["email"],
        limit: 10,
        after: undefined,
      },
      TOOL_CONTEXT,
    );

    expect(doSearch).toHaveBeenCalledWith(
      "contacts",
      expect.objectContaining({ filterGroups: [{ filters }] }),
    );
  });

  it("passes empty filterGroups when no filters provided", async () => {
    const { client, doSearch } = createMockClient();
    doSearch.mockResolvedValue({ results: [], total: 0, paging: undefined });

    const execute = getExecute(createSearchCrmObjectsTool(client));
    await execute(
      { objectType: "deals", filters: [], sorts: [], properties: [], limit: 10, after: undefined },
      TOOL_CONTEXT,
    );

    expect(doSearch).toHaveBeenCalledWith("deals", expect.objectContaining({ filterGroups: [] }));
  });

  it("passes query parameter for free-text search", async () => {
    const { client, doSearch } = createMockClient();
    doSearch.mockResolvedValue({ results: [], total: 0, paging: undefined });

    const execute = getExecute(createSearchCrmObjectsTool(client));
    await execute(
      {
        objectType: "contacts",
        query: "john@acme.com",
        filters: [],
        sorts: [],
        properties: ["email"],
        limit: 10,
        after: undefined,
      },
      TOOL_CONTEXT,
    );

    expect(doSearch).toHaveBeenCalledWith(
      "contacts",
      expect.objectContaining({ query: "john@acme.com" }),
    );
  });

  it("maps results and extracts pagination cursor", async () => {
    const { client, doSearch } = createMockClient();
    doSearch.mockResolvedValue({
      results: [
        { id: "1", properties: { email: "a@b.com" }, extra: "ignored" },
        { id: "2", properties: { email: "c@d.com" }, extra: "ignored" },
      ],
      total: 50,
      paging: { next: { after: "cursor-abc" } },
    });

    const execute = getExecute(createSearchCrmObjectsTool(client));
    const result = await execute(
      {
        objectType: "contacts",
        filters: [],
        sorts: [],
        properties: ["email"],
        limit: 2,
        after: undefined,
      },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({
      total: 50,
      results: [
        { id: "1", properties: { email: "a@b.com" } },
        { id: "2", properties: { email: "c@d.com" } },
      ],
      hasMore: true,
      nextCursor: "cursor-abc",
    });
  });

  it("sets hasMore false when no next page", async () => {
    const { client, doSearch } = createMockClient();
    doSearch.mockResolvedValue({ results: [], total: 0, paging: undefined });

    const execute = getExecute(createSearchCrmObjectsTool(client));
    const result = await execute(
      {
        objectType: "contacts",
        filters: [],
        sorts: [],
        properties: [],
        limit: 10,
        after: undefined,
      },
      TOOL_CONTEXT,
    );

    expect(result).toMatchObject({ hasMore: false, nextCursor: undefined });
  });

  it("returns error object when SDK throws", async () => {
    const { client, doSearch } = createMockClient();
    doSearch.mockRejectedValue(new Error("401 Unauthorized"));

    const execute = getExecute(createSearchCrmObjectsTool(client));
    const result = await execute(
      {
        objectType: "contacts",
        filters: [],
        sorts: [],
        properties: [],
        limit: 10,
        after: undefined,
      },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({ error: "401 Unauthorized" });
  });
});

// -- Get CRM Objects (batch read + normalizeBatchResponse) --

describe("createGetCrmObjectsTool", () => {
  function createMockClient() {
    const read = vi.fn<(objectType: string, request: unknown) => Promise<unknown>>();
    const client = { crm: { objects: { batchApi: { read } } } } as unknown as Client;
    return { client, read };
  }

  it("normalizes response without numErrors/errors fields (BatchResponseSimplePublicObject)", async () => {
    const { client, read } = createMockClient();
    read.mockResolvedValue({
      status: "COMPLETE",
      results: [{ id: "1", properties: { name: "Acme" } }],
      // no numErrors or errors — this is the non-error SDK response type
    });

    const execute = getExecute(createGetCrmObjectsTool(client));
    const result = await execute(
      { objectType: "companies", ids: ["1"], properties: ["name"] },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({
      results: [{ id: "1", properties: { name: "Acme" } }],
      numErrors: 0,
      errors: [],
    });
  });

  it("normalizes response with numErrors/errors fields (BatchResponseWithErrors)", async () => {
    const { client, read } = createMockClient();
    read.mockResolvedValue({
      status: "COMPLETE",
      results: [{ id: "1", properties: { name: "Acme" } }],
      numErrors: 1,
      errors: [{ status: "error", message: "Object 2 not found" }],
    });

    const execute = getExecute(createGetCrmObjectsTool(client));
    const result = await execute(
      { objectType: "companies", ids: ["1", "2"], properties: ["name"] },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({
      results: [{ id: "1", properties: { name: "Acme" } }],
      numErrors: 1,
      errors: [{ status: "error", message: "Object 2 not found" }],
    });
  });

  it("passes correct shape to SDK batchApi.read", async () => {
    const { client, read } = createMockClient();
    read.mockResolvedValue({ status: "COMPLETE", results: [] });

    const execute = getExecute(createGetCrmObjectsTool(client));
    await execute(
      { objectType: "deals", ids: ["10", "20"], properties: ["dealname"] },
      TOOL_CONTEXT,
    );

    expect(read).toHaveBeenCalledWith("deals", {
      inputs: [{ id: "10" }, { id: "20" }],
      properties: ["dealname"],
      propertiesWithHistory: [],
    });
  });

  it("normalizes response when numErrors/errors keys exist but are undefined", async () => {
    const { client, read } = createMockClient();
    read.mockResolvedValue({
      status: "COMPLETE",
      results: [{ id: "1", properties: { name: "Acme" } }],
      numErrors: undefined,
      errors: undefined,
    });

    const execute = getExecute(createGetCrmObjectsTool(client));
    const result = await execute(
      { objectType: "companies", ids: ["1"], properties: ["name"] },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({
      results: [{ id: "1", properties: { name: "Acme" } }],
      numErrors: 0,
      errors: [],
    });
  });

  it("returns error object when SDK throws", async () => {
    const { client, read } = createMockClient();
    read.mockRejectedValue(new Error("403 Forbidden"));

    const execute = getExecute(createGetCrmObjectsTool(client));
    const result = await execute(
      { objectType: "contacts", ids: ["1"], properties: [] },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({ error: "403 Forbidden" });
  });
});

// -- Get CRM Object (singular, with associations) --

describe("createGetCrmObjectTool", () => {
  function createMockClient() {
    const getById =
      vi.fn<
        (
          objectType: string,
          objectId: string,
          properties?: string[],
          propertiesWithHistory?: string[],
          associations?: string[],
        ) => Promise<unknown>
      >();
    const client = { crm: { objects: { basicApi: { getById } } } } as unknown as Client;
    return { client, getById };
  }

  it("fetches a single record with associations", async () => {
    const { client, getById } = createMockClient();
    getById.mockResolvedValue({
      id: "deal-1",
      properties: { dealname: "Big Deal", amount: "50000" },
      associations: {
        contacts: {
          results: [
            { id: "c1", type: "deal_to_contact" },
            { id: "c2", type: "deal_to_contact" },
          ],
        },
        companies: { results: [{ id: "co1", type: "deal_to_company" }] },
      },
    });

    const execute = getExecute(createGetCrmObjectTool(client));
    const result = await execute(
      {
        objectType: "deals",
        id: "deal-1",
        properties: ["dealname", "amount"],
        associations: ["contacts", "companies"],
      },
      TOOL_CONTEXT,
    );

    expect(getById).toHaveBeenCalledWith("deals", "deal-1", ["dealname", "amount"], undefined, [
      "contacts",
      "companies",
    ]);
    expect(result).toEqual({
      id: "deal-1",
      properties: { dealname: "Big Deal", amount: "50000" },
      associations: {
        contacts: [
          { id: "c1", type: "deal_to_contact" },
          { id: "c2", type: "deal_to_contact" },
        ],
        companies: [{ id: "co1", type: "deal_to_company" }],
      },
    });
  });

  it("omits associations from response when none requested", async () => {
    const { client, getById } = createMockClient();
    getById.mockResolvedValue({ id: "contact-1", properties: { email: "a@b.com" } });

    const execute = getExecute(createGetCrmObjectTool(client));
    const result = await execute(
      { objectType: "contacts", id: "contact-1", properties: ["email"], associations: [] },
      TOOL_CONTEXT,
    );

    expect(getById).toHaveBeenCalledWith("contacts", "contact-1", ["email"], undefined, undefined);
    expect(result).toEqual({
      id: "contact-1",
      properties: { email: "a@b.com" },
      associations: undefined,
    });
  });

  it("passes undefined for empty properties and associations arrays", async () => {
    const { client, getById } = createMockClient();
    getById.mockResolvedValue({ id: "1", properties: {} });

    const execute = getExecute(createGetCrmObjectTool(client));
    await execute(
      { objectType: "contacts", id: "1", properties: [], associations: [] },
      TOOL_CONTEXT,
    );

    expect(getById).toHaveBeenCalledWith("contacts", "1", undefined, undefined, undefined);
  });

  it("handles association entry with empty results array", async () => {
    const { client, getById } = createMockClient();
    getById.mockResolvedValue({
      id: "deal-1",
      properties: { dealname: "Big Deal" },
      associations: {
        contacts: { results: [] },
        companies: { results: [{ id: "co1", type: "deal_to_company" }] },
      },
    });

    const execute = getExecute(createGetCrmObjectTool(client));
    const result = await execute(
      {
        objectType: "deals",
        id: "deal-1",
        properties: ["dealname"],
        associations: ["contacts", "companies"],
      },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({
      id: "deal-1",
      properties: { dealname: "Big Deal" },
      associations: { contacts: [], companies: [{ id: "co1", type: "deal_to_company" }] },
    });
  });

  it("returns error object when SDK throws", async () => {
    const { client, getById } = createMockClient();
    getById.mockRejectedValue(new Error("404 Not Found"));

    const execute = getExecute(createGetCrmObjectTool(client));
    const result = await execute(
      { objectType: "deals", id: "missing", properties: [], associations: [] },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({ error: "404 Not Found" });
  });

  it("returns stringified error for non-Error thrown objects", async () => {
    const { client, getById } = createMockClient();
    getById.mockRejectedValue({ code: 500, body: "Internal Server Error" });

    const execute = getExecute(createGetCrmObjectTool(client));
    const result = await execute(
      { objectType: "deals", id: "1", properties: [], associations: [] },
      TOOL_CONTEXT,
    );

    expect(result).toHaveProperty("error");
    expect(typeof (result as { error: string }).error).toBe("string");
  });
});

// -- Create CRM Objects --

describe("createCreateCrmObjectsTool", () => {
  function createMockClient() {
    const create = vi.fn<(objectType: string, request: unknown) => Promise<unknown>>();
    const client = { crm: { objects: { batchApi: { create } } } } as unknown as Client;
    return { client, create };
  }

  it("passes empty associations when none provided", async () => {
    const { client, create } = createMockClient();
    create.mockResolvedValue({ status: "COMPLETE", results: [] });

    const execute = getExecute(createCreateCrmObjectsTool(client));
    await execute(
      {
        objectType: "contacts",
        records: [
          { properties: { email: "a@b.com", firstname: "Alice" }, associations: [] },
          { properties: { email: "c@d.com", firstname: "Bob" }, associations: [] },
        ],
      },
      TOOL_CONTEXT,
    );

    expect(create).toHaveBeenCalledWith("contacts", {
      inputs: [
        { properties: { email: "a@b.com", firstname: "Alice" }, associations: [] },
        { properties: { email: "c@d.com", firstname: "Bob" }, associations: [] },
      ],
    });
  });

  it("resolves inline associations to HUBSPOT_DEFINED type IDs", async () => {
    const { client, create } = createMockClient();
    create.mockResolvedValue({
      status: "COMPLETE",
      results: [{ id: "note-1", properties: { hs_note_body: "Follow up" } }],
    });

    const execute = getExecute(createCreateCrmObjectsTool(client));
    const result = await execute(
      {
        objectType: "notes",
        records: [
          {
            properties: { hs_note_body: "Follow up" },
            associations: [
              { toObjectType: "contacts", toObjectId: "c1" },
              { toObjectType: "deals", toObjectId: "d1" },
            ],
          },
        ],
      },
      TOOL_CONTEXT,
    );

    expect(create).toHaveBeenCalledWith("notes", {
      inputs: [
        {
          properties: { hs_note_body: "Follow up" },
          associations: [
            {
              to: { id: "c1" },
              types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
            },
            {
              to: { id: "d1" },
              types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }],
            },
          ],
        },
      ],
    });
    expect(result).toMatchObject({ skippedAssociations: undefined });
  });

  it("warns about unsupported association pairs", async () => {
    const { client, create } = createMockClient();
    create.mockResolvedValue({
      status: "COMPLETE",
      results: [{ id: "p1", properties: { name: "Widget" } }],
    });

    const execute = getExecute(createCreateCrmObjectsTool(client));
    const result = await execute(
      {
        objectType: "products",
        records: [
          {
            properties: { name: "Widget" },
            associations: [{ toObjectType: "contacts", toObjectId: "c1" }],
          },
        ],
      },
      TOOL_CONTEXT,
    );

    expect(create).toHaveBeenCalledWith("products", {
      inputs: [{ properties: { name: "Widget" }, associations: [] }],
    });
    expect(result).toMatchObject({
      skippedAssociations: expect.stringContaining("products → contacts"),
    });
  });

  it("normalizes response without numErrors/errors fields", async () => {
    const { client, create } = createMockClient();
    create.mockResolvedValue({
      status: "COMPLETE",
      results: [{ id: "101", properties: { email: "a@b.com" } }],
    });

    const execute = getExecute(createCreateCrmObjectsTool(client));
    const result = await execute(
      { objectType: "contacts", records: [{ properties: { email: "a@b.com" }, associations: [] }] },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({
      results: [{ id: "101", properties: { email: "a@b.com" } }],
      numErrors: 0,
      errors: [],
      skippedAssociations: undefined,
    });
  });

  it("normalizes response with numErrors/errors fields", async () => {
    const { client, create } = createMockClient();
    create.mockResolvedValue({
      status: "COMPLETE",
      results: [{ id: "101", properties: { email: "a@b.com" } }],
      numErrors: 1,
      errors: [{ status: "error", message: "Duplicate email" }],
    });

    const execute = getExecute(createCreateCrmObjectsTool(client));
    const result = await execute(
      {
        objectType: "contacts",
        records: [
          { properties: { email: "a@b.com" }, associations: [] },
          { properties: { email: "a@b.com" }, associations: [] },
        ],
      },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({
      results: [{ id: "101", properties: { email: "a@b.com" } }],
      numErrors: 1,
      errors: [{ status: "error", message: "Duplicate email" }],
      skippedAssociations: undefined,
    });
  });

  it("returns error object when SDK throws", async () => {
    const { client, create } = createMockClient();
    create.mockRejectedValue(new Error("429 Too Many Requests"));

    const execute = getExecute(createCreateCrmObjectsTool(client));
    const result = await execute(
      {
        objectType: "deals",
        records: [{ properties: { dealname: "Big Deal" }, associations: [] }],
      },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({ error: "429 Too Many Requests" });
  });
});

// -- Update CRM Objects --

describe("createUpdateCrmObjectsTool", () => {
  function createMockClient() {
    const update = vi.fn<(objectType: string, request: unknown) => Promise<unknown>>();
    const client = { crm: { objects: { batchApi: { update } } } } as unknown as Client;
    return { client, update };
  }

  it("maps records to { id, properties } and passes correct shape to SDK", async () => {
    const { client, update } = createMockClient();
    update.mockResolvedValue({ status: "COMPLETE", results: [] });

    const execute = getExecute(createUpdateCrmObjectsTool(client));
    await execute(
      {
        objectType: "contacts",
        records: [
          { id: "1", properties: { firstname: "Alice" } },
          { id: "2", properties: { firstname: "Bob" } },
        ],
      },
      TOOL_CONTEXT,
    );

    expect(update).toHaveBeenCalledWith("contacts", {
      inputs: [
        { id: "1", properties: { firstname: "Alice" } },
        { id: "2", properties: { firstname: "Bob" } },
      ],
    });
  });

  it("normalizes response without numErrors/errors fields", async () => {
    const { client, update } = createMockClient();
    update.mockResolvedValue({
      status: "COMPLETE",
      results: [{ id: "1", properties: { firstname: "Updated" } }],
    });

    const execute = getExecute(createUpdateCrmObjectsTool(client));
    const result = await execute(
      { objectType: "contacts", records: [{ id: "1", properties: { firstname: "Updated" } }] },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({
      results: [{ id: "1", properties: { firstname: "Updated" } }],
      numErrors: 0,
      errors: [],
    });
  });

  it("returns error object when SDK throws", async () => {
    const { client, update } = createMockClient();
    update.mockRejectedValue(new Error("404 Not Found"));

    const execute = getExecute(createUpdateCrmObjectsTool(client));
    const result = await execute(
      { objectType: "deals", records: [{ id: "99", properties: { dealname: "Gone" } }] },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({ error: "404 Not Found" });
  });
});

// -- Upsert CRM Objects --

describe("createUpsertCrmObjectsTool", () => {
  function createMockClient() {
    const upsert = vi.fn<(objectType: string, request: unknown) => Promise<unknown>>();
    const client = { crm: { objects: { batchApi: { upsert } } } } as unknown as Client;
    return { client, upsert };
  }

  it("passes idProperty on each input and maps to SDK shape", async () => {
    const { client, upsert } = createMockClient();
    upsert.mockResolvedValue({ status: "COMPLETE", results: [] });

    const execute = getExecute(createUpsertCrmObjectsTool(client));
    await execute(
      {
        objectType: "contacts",
        idProperty: "email",
        records: [
          { id: "alice@co.com", properties: { firstname: "Alice" } },
          { id: "bob@co.com", properties: { firstname: "Bob" } },
        ],
      },
      TOOL_CONTEXT,
    );

    expect(upsert).toHaveBeenCalledWith("contacts", {
      inputs: [
        { id: "alice@co.com", idProperty: "email", properties: { firstname: "Alice" } },
        { id: "bob@co.com", idProperty: "email", properties: { firstname: "Bob" } },
      ],
    });
  });

  it("includes new flag from upsert response", async () => {
    const { client, upsert } = createMockClient();
    upsert.mockResolvedValue({
      status: "COMPLETE",
      results: [
        { id: "101", properties: { email: "alice@co.com" }, _new: true },
        { id: "102", properties: { email: "bob@co.com" }, _new: false },
      ],
    });

    const execute = getExecute(createUpsertCrmObjectsTool(client));
    const result = await execute(
      {
        objectType: "contacts",
        idProperty: "email",
        records: [
          { id: "alice@co.com", properties: { firstname: "Alice" } },
          { id: "bob@co.com", properties: { firstname: "Bob" } },
        ],
      },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({
      results: [
        { id: "101", properties: { email: "alice@co.com" }, new: true },
        { id: "102", properties: { email: "bob@co.com" }, new: false },
      ],
      numErrors: 0,
      errors: [],
    });
  });

  it("normalizes response with numErrors for partial failures", async () => {
    const { client, upsert } = createMockClient();
    upsert.mockResolvedValue({
      status: "COMPLETE",
      results: [{ id: "101", properties: { email: "alice@co.com" }, _new: true }],
      numErrors: 1,
      errors: [{ status: "error", message: "Invalid idProperty value: bad" }],
    });

    const execute = getExecute(createUpsertCrmObjectsTool(client));
    const result = await execute(
      {
        objectType: "contacts",
        idProperty: "email",
        records: [
          { id: "alice@co.com", properties: { firstname: "Alice" } },
          { id: "bad", properties: {} },
        ],
      },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({
      results: [{ id: "101", properties: { email: "alice@co.com" }, new: true }],
      numErrors: 1,
      errors: [{ status: "error", message: "Invalid idProperty value: bad" }],
    });
  });

  it("returns error object when SDK throws", async () => {
    const { client, upsert } = createMockClient();
    upsert.mockRejectedValue(new Error("400 Bad Request"));

    const execute = getExecute(createUpsertCrmObjectsTool(client));
    const result = await execute(
      { objectType: "contacts", idProperty: "email", records: [{ id: "bad", properties: {} }] },
      TOOL_CONTEXT,
    );

    expect(result).toEqual({ error: "400 Bad Request" });
  });
});

// -- Get Properties --

describe("createGetPropertiesTool", () => {
  function createMockClient() {
    const getAll = vi.fn<(objectType: string) => Promise<unknown>>();
    const client = { crm: { properties: { coreApi: { getAll } } } } as unknown as Client;
    return { client, getAll };
  }

  it("maps properties to { name, label, type, fieldType, options } shape", async () => {
    const { client, getAll } = createMockClient();
    getAll.mockResolvedValue({
      results: [
        {
          name: "email",
          label: "Email",
          type: "string",
          fieldType: "text",
          options: [],
          groupName: "contactinformation",
          hidden: false,
        },
        {
          name: "lifecyclestage",
          label: "Lifecycle Stage",
          type: "enumeration",
          fieldType: "radio",
          options: [
            { label: "Subscriber", value: "subscriber", displayOrder: 0, hidden: false },
            { label: "Lead", value: "lead", displayOrder: 1, hidden: false },
          ],
          groupName: "contactinformation",
          hidden: false,
        },
      ],
    });

    const execute = getExecute(createGetPropertiesTool(client));
    const result = await execute({ objectType: "contacts" }, TOOL_CONTEXT);

    expect(getAll).toHaveBeenCalledWith("contacts");
    expect(result).toEqual({
      results: [
        { name: "email", label: "Email", type: "string", fieldType: "text", options: [] },
        {
          name: "lifecyclestage",
          label: "Lifecycle Stage",
          type: "enumeration",
          fieldType: "radio",
          options: [
            { label: "Subscriber", value: "subscriber" },
            { label: "Lead", value: "lead" },
          ],
        },
      ],
    });
  });

  it("excludes hidden properties from results", async () => {
    const { client, getAll } = createMockClient();
    getAll.mockResolvedValue({
      results: [
        {
          name: "email",
          label: "Email",
          type: "string",
          fieldType: "text",
          options: [],
          hidden: false,
        },
        {
          name: "hs_internal",
          label: "Internal",
          type: "string",
          fieldType: "text",
          options: [],
          hidden: true,
        },
        { name: "firstname", label: "First Name", type: "string", fieldType: "text", options: [] },
      ],
    });

    const execute = getExecute(createGetPropertiesTool(client));
    const result = await execute({ objectType: "contacts" }, TOOL_CONTEXT);

    const names = (result as { results: Array<{ name: string }> }).results.map((p) => p.name);
    expect(names).toEqual(["email", "firstname"]);
  });

  it("strips extra SDK fields from options, keeping only label and value", async () => {
    const { client, getAll } = createMockClient();
    getAll.mockResolvedValue({
      results: [
        {
          name: "priority",
          label: "Priority",
          type: "enumeration",
          fieldType: "select",
          options: [
            {
              label: "High",
              value: "high",
              displayOrder: 0,
              hidden: false,
              description: "Top priority",
            },
          ],
        },
      ],
    });

    const execute = getExecute(createGetPropertiesTool(client));
    const result = await execute({ objectType: "deals" }, TOOL_CONTEXT);

    expect(result).toEqual({
      results: [
        {
          name: "priority",
          label: "Priority",
          type: "enumeration",
          fieldType: "select",
          options: [{ label: "High", value: "high" }],
        },
      ],
    });
  });

  it("returns error object when SDK throws", async () => {
    const { client, getAll } = createMockClient();
    getAll.mockRejectedValue(new Error("401 Unauthorized"));

    const execute = getExecute(createGetPropertiesTool(client));
    const result = await execute({ objectType: "contacts" }, TOOL_CONTEXT);

    expect(result).toEqual({ error: "401 Unauthorized" });
  });
});

// -- Search Owners --

describe("createSearchOwnersTool", () => {
  function createMockClient() {
    const getPage = vi.fn<(email?: string, after?: string, limit?: number) => Promise<unknown>>();
    const client = { crm: { owners: { ownersApi: { getPage } } } } as unknown as Client;
    return { client, getPage };
  }

  it("passes email, after, limit in correct param order", async () => {
    const { client, getPage } = createMockClient();
    getPage.mockResolvedValue({ results: [], paging: undefined });

    const execute = getExecute(createSearchOwnersTool(client));
    await execute({ email: "sara@test.com", after: "cursor-1", limit: 5 }, TOOL_CONTEXT);

    expect(getPage).toHaveBeenCalledWith("sara@test.com", "cursor-1", 5);
  });

  it("falls back to empty string for nullish firstName/lastName", async () => {
    const { client, getPage } = createMockClient();
    getPage.mockResolvedValue({
      results: [{ id: "owner-1", email: "a@b.com", firstName: null, lastName: undefined }],
      paging: undefined,
    });

    const execute = getExecute(createSearchOwnersTool(client));
    const result = await execute({ email: undefined, after: undefined, limit: 20 }, TOOL_CONTEXT);

    expect(result).toMatchObject({
      results: [{ id: "owner-1", email: "a@b.com", firstName: "", lastName: "" }],
    });
  });

  it("extracts pagination cursor", async () => {
    const { client, getPage } = createMockClient();
    getPage.mockResolvedValue({
      results: [{ id: "o1", email: "a@b.com", firstName: "A", lastName: "B" }],
      paging: { next: { after: "page-2" } },
    });

    const execute = getExecute(createSearchOwnersTool(client));
    const result = await execute({ email: undefined, after: undefined, limit: 20 }, TOOL_CONTEXT);

    expect(result).toMatchObject({ hasMore: true, nextCursor: "page-2" });
  });

  it("returns error object when SDK throws", async () => {
    const { client, getPage } = createMockClient();
    getPage.mockRejectedValue(new Error("rate limited"));

    const execute = getExecute(createSearchOwnersTool(client));
    const result = await execute({ email: undefined, after: undefined, limit: 20 }, TOOL_CONTEXT);

    expect(result).toEqual({ error: "rate limited" });
  });
});

// -- Get Pipelines --

describe("createGetPipelinesTool", () => {
  function createMockClient() {
    const getAll = vi.fn<(objectType: string) => Promise<unknown>>();
    const client = { crm: { pipelines: { pipelinesApi: { getAll } } } } as unknown as Client;
    return { client, getAll };
  }

  it("maps pipelines with stages sorted by displayOrder", async () => {
    const { client, getAll } = createMockClient();
    getAll.mockResolvedValue({
      results: [
        {
          id: "pipeline-1",
          label: "Sales Pipeline",
          displayOrder: 0,
          stages: [
            { id: "s2", label: "Closed Won", displayOrder: 2, metadata: { probability: "1.0" } },
            {
              id: "s0",
              label: "Appointment Scheduled",
              displayOrder: 0,
              metadata: { probability: "0.2" },
            },
            { id: "s1", label: "Contract Sent", displayOrder: 1, metadata: { probability: "0.8" } },
          ],
        },
      ],
    });

    const execute = getExecute(createGetPipelinesTool(client));
    const result = await execute({ objectType: "deals" }, TOOL_CONTEXT);

    expect(getAll).toHaveBeenCalledWith("deals");
    expect(result).toEqual({
      results: [
        {
          id: "pipeline-1",
          label: "Sales Pipeline",
          displayOrder: 0,
          stages: [
            {
              id: "s0",
              label: "Appointment Scheduled",
              displayOrder: 0,
              metadata: { probability: "0.2" },
            },
            { id: "s1", label: "Contract Sent", displayOrder: 1, metadata: { probability: "0.8" } },
            { id: "s2", label: "Closed Won", displayOrder: 2, metadata: { probability: "1.0" } },
          ],
        },
      ],
    });
  });

  it("returns empty results for account with no pipelines", async () => {
    const { client, getAll } = createMockClient();
    getAll.mockResolvedValue({ results: [] });

    const execute = getExecute(createGetPipelinesTool(client));
    const result = await execute({ objectType: "tickets" }, TOOL_CONTEXT);

    expect(result).toEqual({ results: [] });
  });

  it("returns error object when SDK throws", async () => {
    const { client, getAll } = createMockClient();
    getAll.mockRejectedValue(new Error("403 Forbidden"));

    const execute = getExecute(createGetPipelinesTool(client));
    const result = await execute({ objectType: "deals" }, TOOL_CONTEXT);

    expect(result).toEqual({ error: "403 Forbidden" });
  });
});

// -- Manage Associations --

describe("createManageAssociationsTool", () => {
  function createMockClient() {
    const createDefault = vi.fn().mockResolvedValue(undefined);
    const archive = vi.fn().mockResolvedValue(undefined);
    const getPage =
      vi.fn<
        (
          fromType: string,
          fromId: string,
          toType: string,
          after?: string,
          limit?: number,
        ) => Promise<unknown>
      >();
    const client = {
      crm: { associations: { v4: { basicApi: { createDefault, archive, getPage } } } },
    } as unknown as Client;
    return { client, createDefault, archive, getPage };
  }

  it("calls createDefault for link action", async () => {
    const { client, createDefault } = createMockClient();
    const execute = getExecute(createManageAssociationsTool(client));

    const result = await execute(
      {
        action: "link",
        fromObjectType: "deals",
        fromObjectId: "123",
        toObjectType: "contacts",
        toObjectId: "456",
        limit: 100,
      },
      TOOL_CONTEXT,
    );

    expect(createDefault).toHaveBeenCalledWith("deals", "123", "contacts", "456");
    expect(result).toEqual({
      status: "success",
      action: "link",
      from: { objectType: "deals", objectId: "123" },
      to: { objectType: "contacts", objectId: "456" },
    });
  });

  it("calls archive for unlink action", async () => {
    const { client, archive } = createMockClient();
    const execute = getExecute(createManageAssociationsTool(client));

    const result = await execute(
      {
        action: "unlink",
        fromObjectType: "companies",
        fromObjectId: "789",
        toObjectType: "deals",
        toObjectId: "012",
        limit: 100,
      },
      TOOL_CONTEXT,
    );

    expect(archive).toHaveBeenCalledWith("companies", "789", "deals", "012");
    expect(result).toEqual({
      status: "success",
      action: "unlink",
      from: { objectType: "companies", objectId: "789" },
      to: { objectType: "deals", objectId: "012" },
    });
  });

  it("lists associated objects with pagination", async () => {
    const { client, getPage } = createMockClient();
    getPage.mockResolvedValue({
      results: [
        { toObjectId: "c1", associationTypes: [] },
        { toObjectId: "c2", associationTypes: [] },
      ],
      paging: { next: { after: "page-2" } },
    });

    const execute = getExecute(createManageAssociationsTool(client));
    const result = await execute(
      {
        action: "list",
        fromObjectType: "deals",
        fromObjectId: "123",
        toObjectType: "contacts",
        limit: 50,
      },
      TOOL_CONTEXT,
    );

    expect(getPage).toHaveBeenCalledWith("deals", "123", "contacts", undefined, 50);
    expect(result).toEqual({
      status: "success",
      action: "list",
      from: { objectType: "deals", objectId: "123" },
      toObjectType: "contacts",
      results: [{ toObjectId: "c1" }, { toObjectId: "c2" }],
      hasMore: true,
      nextCursor: "page-2",
    });
  });

  it("forwards after pagination cursor to getPage", async () => {
    const { client, getPage } = createMockClient();
    getPage.mockResolvedValue({ results: [], paging: undefined });

    const execute = getExecute(createManageAssociationsTool(client));
    await execute(
      {
        action: "list",
        fromObjectType: "deals",
        fromObjectId: "123",
        toObjectType: "contacts",
        after: "cursor-page-3",
        limit: 100,
      },
      TOOL_CONTEXT,
    );

    expect(getPage).toHaveBeenCalledWith("deals", "123", "contacts", "cursor-page-3", 100);
  });

  it("returns error when link/unlink missing toObjectId", async () => {
    const { client } = createMockClient();
    const execute = getExecute(createManageAssociationsTool(client));

    const result = await execute(
      {
        action: "link",
        fromObjectType: "deals",
        fromObjectId: "123",
        toObjectType: "contacts",
        limit: 100,
      },
      TOOL_CONTEXT,
    );

    expect(result).toMatchObject({
      status: "error",
      error: "toObjectId is required for link/unlink actions",
    });
  });

  it("returns failure status when API throws", async () => {
    const { client, createDefault } = createMockClient();
    createDefault.mockRejectedValue(new Error("API error: 400"));
    const execute = getExecute(createManageAssociationsTool(client));

    const result = await execute(
      {
        action: "link",
        fromObjectType: "contacts",
        fromObjectId: "1",
        toObjectType: "companies",
        toObjectId: "2",
        limit: 100,
      },
      TOOL_CONTEXT,
    );

    expect(result).toMatchObject({ status: "error", action: "link", error: "API error: 400" });
  });
});

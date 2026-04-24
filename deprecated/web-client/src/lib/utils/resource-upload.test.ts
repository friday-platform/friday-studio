import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceResource, uploadResource } from "./resource-upload.ts";

vi.mock("@atlas/oapi-client", () => ({ getAtlasDaemonUrl: () => "http://localhost:8080" }));

describe("uploadResource", () => {
  const fetchSpy =
    vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts multipart/form-data to resource upload endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ resource: { type: "table", slug: "data", name: "data" } }), {
        status: 201,
      }),
    );

    const file = new File(["col1,col2\na,b"], "data.csv", { type: "text/csv" });
    const result = await uploadResource(file, "ws-1");

    expect(result).toMatchObject({ ok: true });
    expect(fetchSpy).toHaveBeenCalledOnce();

    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error("Expected fetch to have been called");
    const [url, init] = call;
    expect(url).toBe("http://localhost:8080/api/workspaces/ws-1/resources/upload");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it("returns status 409 on slug conflict", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Resource "data" already exists' }), { status: 409 }),
    );

    const file = new File(["content"], "data.csv", { type: "text/csv" });
    const result = await uploadResource(file, "ws-1");

    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it("returns error on network failure", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const file = new File(["content"], "data.csv", { type: "text/csv" });
    const result = await uploadResource(file, "ws-1");

    expect(result).toMatchObject({ ok: false, status: 0, error: "Network error" });
  });

  it("encodes workspaceId in URL", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ resource: { type: "table", slug: "d", name: "d" } }), {
        status: 201,
      }),
    );

    const file = new File(["x"], "d.csv", { type: "text/csv" });
    await uploadResource(file, "ws with spaces");

    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error("Expected fetch to have been called");
    const [url] = call;
    expect(url).toContain("ws%20with%20spaces");
  });
});

describe("replaceResource", () => {
  const fetchSpy =
    vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends PUT to resource slug endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ resource: { type: "table", slug: "data", name: "data" } }), {
        status: 200,
      }),
    );

    const file = new File(["new,data"], "data.csv", { type: "text/csv" });
    const result = await replaceResource(file, "ws-1", "data");

    expect(result).toMatchObject({ ok: true });

    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error("Expected fetch to have been called");
    const [url, init] = call;
    expect(url).toBe("http://localhost:8080/api/workspaces/ws-1/resources/data");
    expect(init?.method).toBe("PUT");
  });

  it("returns 422 error for incompatible file type", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Table resources require a CSV file" }), {
        status: 422,
      }),
    );

    const file = new File(["not csv"], "report.pdf", { type: "application/pdf" });
    const result = await replaceResource(file, "ws-1", "my-table");

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      error: "Table resources require a CSV file",
    });
  });

  it("returns error on network failure", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const file = new File(["content"], "data.csv", { type: "text/csv" });
    const result = await replaceResource(file, "ws-1", "data");

    expect(result).toMatchObject({ ok: false, status: 0, error: "Network error" });
  });
});

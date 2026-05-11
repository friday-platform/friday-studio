/**
 * @vitest-environment happy-dom
 *
 * Dispatcher tests for the bare `/artifacts/[id]` route. Asserts that the
 * loader picks the correct subpath renderer per mime type — and that
 * `text/markdown` lands on `/markdown` rather than `/table` (the regression
 * the dispatcher was previously failing on).
 */
import { describe, expect, it, vi } from "vitest";
import { load } from "./+page.ts";

type FetchImpl = (url: string | URL) => Promise<Response>;

function mockMetaFetch(mimeType: string | undefined): FetchImpl {
  return vi.fn(async (url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (!u.includes("/artifacts/")) throw new Error(`unhandled: ${u}`);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        artifact: {
          title: "t",
          data: mimeType ? { mimeType, originalName: "t" } : { originalName: "t" },
        },
      }),
    } as unknown as Response;
  }) as FetchImpl;
}

interface RedirectError {
  status?: number;
  location?: string;
}

async function captureRedirect(artifactId: string, fetch: FetchImpl): Promise<RedirectError> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: SvelteKit load event has many unused fields
    await (load as any)({ params: { id: artifactId }, fetch });
  } catch (err) {
    return err as RedirectError;
  }
  throw new Error("expected a redirect");
}

describe("/artifacts/[id] dispatcher", () => {
  it("redirects text/markdown to the /markdown viewer", async () => {
    const err = await captureRedirect("art_md", mockMetaFetch("text/markdown"));
    expect(err.status).toBe(307);
    expect(err.location).toBe("/artifacts/art_md/markdown");
  });

  it("redirects text/csv to the /table viewer", async () => {
    const err = await captureRedirect("art_csv", mockMetaFetch("text/csv"));
    expect(err.status).toBe(307);
    expect(err.location).toBe("/artifacts/art_csv/table");
  });

  it("redirects application/json to the /table viewer", async () => {
    const err = await captureRedirect("art_json", mockMetaFetch("application/json"));
    expect(err.status).toBe(307);
    expect(err.location).toBe("/artifacts/art_json/table");
  });

  it("redirects text/html to the /table viewer", async () => {
    const err = await captureRedirect("art_html", mockMetaFetch("text/html"));
    expect(err.status).toBe(307);
    expect(err.location).toBe("/artifacts/art_html/table");
  });

  it("strips charset params before deciding the route", async () => {
    const err = await captureRedirect(
      "art_md_charset",
      mockMetaFetch("text/markdown; charset=utf-8"),
    );
    expect(err.status).toBe(307);
    expect(err.location).toBe("/artifacts/art_md_charset/markdown");
  });

  it("falls through to the file-info card for non-tabular, non-markdown mimes", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: SvelteKit load event has many unused fields
    const result = await (load as any)({
      params: { id: "art_bin" },
      fetch: mockMetaFetch("application/octet-stream"),
    });
    expect(result).toMatchObject({
      artifactId: "art_bin",
      mimeType: "application/octet-stream",
    });
  });
});

/**
 * SSR render test for `mcp-credentials-list.svelte`.
 *
 * Guards the `@tanstack/svelte-table` alpha→beta API surface this component
 * relies on. A pure type-check (svelte-check) only proves the symbols line
 * up; this drives the RUNTIME path — `createTable({ features })`, feature
 * wiring (`getRowModel`/`getHeaderGroups`/`getVisibleCells`), `FlexRender`,
 * and `renderSnippet` — and asserts the credential rows actually render.
 *
 * The beta bump renamed the `createTable` option `_features` → `features`;
 * without it `getRowModel()` is wired against the wrong feature set and the
 * `<Table.Root>` prop type breaks. This test fails loudly if that regresses.
 */

import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import CredentialsList from "./mcp-credentials-list.svelte";

const noop = () => {};

const baseProps = {
  providerType: "apikey" as const,
  onReplace: noop,
  onRemove: noop,
  onReauthenticate: noop,
  onReinstall: noop,
};

describe("mcp-credentials-list", () => {
  it("renders a row per credential with label, type and status", () => {
    const { body } = render(CredentialsList, {
      props: {
        ...baseProps,
        credentials: [
          {
            id: "cred-1",
            label: "Production key",
            type: "apikey",
            status: "ready",
            createdAt: "2026-01-15T00:00:00.000Z",
          },
          {
            id: "cred-2",
            label: "Staging key",
            type: "apikey",
            status: "expired",
            createdAt: "2026-02-20T00:00:00.000Z",
          },
        ],
      },
    });

    // Both rows' labels made it through createTable → getRowModel → FlexRender.
    expect(body).toContain("Production key");
    expect(body).toContain("Staging key");
    // The display-column cell snippet (renderSnippet) rendered status + type.
    expect(body).toContain("Ready");
    expect(body).toContain("Expired");
    expect(body).toContain("API Key");
    // Formatted createdAt proves the cell snippet ran end to end.
    expect(body).toContain("January");
    expect(body).toContain("2026");
  });

  it("renders an empty table body without throwing for zero credentials", () => {
    const { body } = render(CredentialsList, {
      props: { ...baseProps, credentials: [] },
    });
    // No rows, but the component (and the table runtime) rendered cleanly.
    expect(body).not.toContain("Production key");
    expect(typeof body).toBe("string");
  });
});

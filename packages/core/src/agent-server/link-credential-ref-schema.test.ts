/**
 * Drift guard for the locally re-declared `LinkCredentialRefSchema`.
 *
 * `agent-server/types.ts` re-declares the schema because the MCP server side
 * runs a different Zod version than `@atlas/agent-sdk`. The two must validate
 * the *same* set of values — this runs a representative value set through both
 * and asserts they agree on accept/reject. If the agent-sdk schema changes,
 * this fails until the local copy is updated to match.
 */

import { LinkCredentialRefSchema as SdkSchema } from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";
import { LinkCredentialRefSchema as LocalSchema } from "./types.ts";

const CASES: { name: string; value: unknown }[] = [
  { name: "provider-only ref", value: { from: "link", provider: "github", key: "token" } },
  { name: "id-only ref", value: { from: "link", id: "cred_abc", key: "token" } },
  { name: "id + provider ref", value: { from: "link", id: "c", provider: "p", key: "k" } },
  { name: "neither id nor provider", value: { from: "link", key: "token" } },
  { name: "empty id", value: { from: "link", id: "", key: "token" } },
  { name: "empty provider", value: { from: "link", provider: "", key: "token" } },
  { name: "wrong `from` literal", value: { from: "env", provider: "p", key: "k" } },
  { name: "missing key", value: { from: "link", provider: "p" } },
  { name: "extra unknown field", value: { from: "link", provider: "p", key: "k", extra: 1 } },
  { name: "not an object", value: "from:link" },
];

describe("LinkCredentialRefSchema — agent-server copy matches agent-sdk", () => {
  for (const { name, value } of CASES) {
    it(`agrees on: ${name}`, () => {
      const sdkOk = SdkSchema.safeParse(value).success;
      const localOk = LocalSchema.safeParse(value).success;
      expect(localOk).toBe(sdkOk);
    });
  }
});

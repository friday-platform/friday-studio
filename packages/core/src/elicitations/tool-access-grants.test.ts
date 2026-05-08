import type { NatsConnection } from "nats";
import { beforeAll, describe, expect, it } from "vitest";
import { getTestNc } from "../../../../vitest.setup.ts";
import { JetStreamToolAccessGrantAdapter } from "./tool-access-grants.ts";

let nc: NatsConnection;

beforeAll(() => {
  nc = getTestNc();
});

describe("JetStreamToolAccessGrantAdapter", () => {
  it("persists allow-always grants by workspace and tool", async () => {
    const adapter = new JetStreamToolAccessGrantAdapter(nc);
    const workspaceId = `ws-grant-${crypto.randomUUID()}`;
    const toolName = "gmail/send_email";

    const before = await adapter.hasGrant({ workspaceId, toolName });
    expect.assert(before.ok === true);
    expect(before.data).toBe(false);

    const grant = await adapter.grantAlways({
      workspaceId,
      toolName,
      sourceElicitationId: "elc_1",
      grantedBy: "user@example.com",
    });
    expect.assert(grant.ok === true);
    expect(grant.data.scope).toBe("workspace");

    const rebound = new JetStreamToolAccessGrantAdapter(nc);
    const after = await rebound.hasGrant({ workspaceId, toolName });
    expect.assert(after.ok === true);
    expect(after.data).toBe(true);

    const otherWorkspace = await rebound.hasGrant({
      workspaceId: `${workspaceId}-other`,
      toolName,
    });
    expect.assert(otherWorkspace.ok === true);
    expect(otherWorkspace.data).toBe(false);
  });
});

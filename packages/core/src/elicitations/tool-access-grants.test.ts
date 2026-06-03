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

  it("listForWorkspace returns granted tool entries scoped to the workspace", async () => {
    const adapter = new JetStreamToolAccessGrantAdapter(nc);
    const wsA = `ws-list-a-${crypto.randomUUID()}`;
    const wsB = `ws-list-b-${crypto.randomUUID()}`;

    const empty = await adapter.listForWorkspace({ workspaceId: wsA });
    expect.assert(empty.ok === true);
    expect(empty.data).toEqual([]);

    await adapter.grantAlways({ workspaceId: wsA, toolName: "fs_write_file" });
    await adapter.grantAlways({ workspaceId: wsA, toolName: "gmail/send_email" });
    await adapter.grantAlways({ workspaceId: wsB, toolName: "bash" });

    const listA = await adapter.listForWorkspace({ workspaceId: wsA });
    expect.assert(listA.ok === true);
    const sortedA = [...listA.data].sort((a, b) => a.toolName.localeCompare(b.toolName));
    expect(sortedA).toEqual([
      { toolName: "fs_write_file", bareToolName: "fs_write_file" },
      { toolName: "gmail/send_email", bareToolName: "send_email", serverId: "gmail" },
    ]);

    const listB = await adapter.listForWorkspace({ workspaceId: wsB });
    expect.assert(listB.ok === true);
    expect(listB.data).toEqual([{ toolName: "bash", bareToolName: "bash" }]);
  });

  it("listForWorkspace round-trips workspace ids containing reserved characters", async () => {
    const adapter = new JetStreamToolAccessGrantAdapter(nc);
    // Hex-encoded keying must keep `.`/`/` in ids from colliding with the
    // KV key separator. Use a unique suffix so reruns don't accumulate.
    const workspaceId = `ws.with/sep-${crypto.randomUUID()}`;
    await adapter.grantAlways({ workspaceId, toolName: "bash" });

    const list = await adapter.listForWorkspace({ workspaceId });
    expect.assert(list.ok === true);
    expect(list.data).toEqual([{ toolName: "bash", bareToolName: "bash" }]);
  });

  it("grantAlways derives serverId from a qualified toolName when caller doesn't pass it", async () => {
    const adapter = new JetStreamToolAccessGrantAdapter(nc);
    const workspaceId = `ws-derive-${crypto.randomUUID()}`;

    const grant = await adapter.grantAlways({
      workspaceId,
      toolName: "google-calendar/list_events",
    });
    expect.assert(grant.ok === true);
    expect(grant.data.serverId).toBe("google-calendar");

    // hasGrant lookup by the original (qualified) name still resolves —
    // the KV key is derived from `toolName`, not from `serverId/bareName`,
    // so callers that look up by the LLM-facing string keep working.
    const seen = await adapter.hasGrant({ workspaceId, toolName: "google-calendar/list_events" });
    expect.assert(seen.ok === true);
    expect(seen.data).toBe(true);
  });

  it("grantAlways accepts an explicit serverId that overrides toolName parsing", async () => {
    const adapter = new JetStreamToolAccessGrantAdapter(nc);
    const workspaceId = `ws-explicit-${crypto.randomUUID()}`;

    const grant = await adapter.grantAlways({
      workspaceId,
      toolName: "send_email",
      serverId: "gmail",
    });
    expect.assert(grant.ok === true);
    expect(grant.data.serverId).toBe("gmail");

    const list = await adapter.listForWorkspace({ workspaceId });
    expect.assert(list.ok === true);
    expect(list.data).toEqual([
      { toolName: "send_email", bareToolName: "send_email", serverId: "gmail" },
    ]);
  });
});

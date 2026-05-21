import { beforeAll, describe, expect, it } from "vitest";
import { getTestNc } from "../../../../vitest.setup.ts";
import { emitWorkspaceSetupElicitation } from "./emit-workspace-setup.ts";
import { ElicitationStorage, initElicitationStorage } from "./storage.ts";

describe("emitWorkspaceSetupElicitation", () => {
  beforeAll(() => {
    initElicitationStorage(getTestNc());
  });

  it("creates a workspace-setup elicitation with the supplied scope + payload", async () => {
    const setupRequirements = [
      { kind: "variable" as const, name: "region", schema: { type: "string" as const } },
    ];

    const result = await emitWorkspaceSetupElicitation({
      workspaceId: `ws-${crypto.randomUUID()}`,
      sessionId: `chat-${crypto.randomUUID()}`,
      setupRequirements,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const elicitation = result.data;
    expect(elicitation.kind).toBe("workspace-setup");
    expect(elicitation.question).toBe("Finish setting up this workspace");
    expect(elicitation.setupRequirements).toEqual(setupRequirements);

    const expiresAt = new Date(elicitation.expiresAt).getTime();
    const sixMonthsMs = 6 * 30 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThan(Date.now() + sixMonthsMs);
  });

  it("scopes the elicitation to the supplied workspaceId + sessionId", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `chat-${crypto.randomUUID()}`;

    const result = await emitWorkspaceSetupElicitation({
      workspaceId,
      sessionId,
      setupRequirements: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.workspaceId).toBe(workspaceId);
    expect(result.data.sessionId).toBe(sessionId);

    const listed = await ElicitationStorage.list({ workspaceId, sessionId });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]?.kind).toBe("workspace-setup");
  });
});

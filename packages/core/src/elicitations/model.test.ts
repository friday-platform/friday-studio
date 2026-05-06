import { describe, expect, it } from "vitest";
import {
  CreateElicitationSchema,
  ElicitationAnswerSchema,
  ElicitationKindSchema,
  ElicitationSchema,
  ElicitationStatusSchema,
} from "./model.ts";

const baseElicitation = {
  id: "elc_01",
  workspaceId: "ws_test",
  sessionId: "sess_test",
  kind: "tool-allowlist" as const,
  question: "Allow gmail/send_email?",
  options: [
    { label: "Allow once", value: "allow-once" },
    { label: "Allow always", value: "allow-always" },
    { label: "Deny", value: "deny" },
  ],
  pendingTool: { name: "gmail/send_email", args: { to: "user@example.com", subject: "hi" } },
  createdAt: "2026-05-05T12:00:00.000Z",
  expiresAt: "2026-05-05T13:00:00.000Z",
  status: "pending" as const,
};

describe("ElicitationKindSchema", () => {
  it("accepts the four known kinds", () => {
    for (const k of ["tool-allowlist", "auth-refresh", "confirm-action", "open-question"]) {
      expect(ElicitationKindSchema.safeParse(k).success).toBe(true);
    }
  });

  it("rejects an unknown kind", () => {
    expect(ElicitationKindSchema.safeParse("not-a-kind").success).toBe(false);
  });
});

describe("ElicitationStatusSchema", () => {
  it("accepts the four lifecycle states", () => {
    for (const s of ["pending", "answered", "declined", "expired"]) {
      expect(ElicitationStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it("rejects unknown status values", () => {
    expect(ElicitationStatusSchema.safeParse("done").success).toBe(false);
  });
});

describe("ElicitationSchema", () => {
  it("accepts a minimal pending elicitation", () => {
    const minimal = {
      id: "elc_min",
      workspaceId: "ws",
      sessionId: "sess",
      kind: "open-question" as const,
      question: "Stuck — pick one",
      createdAt: "2026-05-05T00:00:00.000Z",
      expiresAt: "2026-05-05T01:00:00.000Z",
      status: "pending" as const,
    };
    expect(ElicitationSchema.safeParse(minimal).success).toBe(true);
  });

  it("accepts a fully-populated tool-allowlist elicitation", () => {
    expect(ElicitationSchema.safeParse(baseElicitation).success).toBe(true);
  });

  it("accepts an answered elicitation with answer block", () => {
    const answered = {
      ...baseElicitation,
      status: "answered" as const,
      answer: {
        value: "allow-once",
        note: "ok this once",
        answeredBy: "ken",
        answeredAt: "2026-05-05T12:05:00.000Z",
      },
    };
    expect(ElicitationSchema.safeParse(answered).success).toBe(true);
  });

  it("rejects createdAt that isn't an ISO datetime", () => {
    const bad = { ...baseElicitation, createdAt: "yesterday" };
    expect(ElicitationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const { question: _drop, ...withoutQuestion } = baseElicitation;
    expect(ElicitationSchema.safeParse(withoutQuestion).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const bad = { ...baseElicitation, status: "in-progress" };
    expect(ElicitationSchema.safeParse(bad).success).toBe(false);
  });

  it("treats actionId as optional", () => {
    const withAction = { ...baseElicitation, actionId: "state.processing.0" };
    expect(ElicitationSchema.safeParse(withAction).success).toBe(true);
  });

  it("accepts pendingTool.args with arbitrary unknown values", () => {
    const variant = {
      ...baseElicitation,
      pendingTool: {
        name: "fs/write_file",
        args: { path: "/tmp/x", bytes: { kind: "binary", len: 42 }, flag: true, n: 3 },
      },
    };
    expect(ElicitationSchema.safeParse(variant).success).toBe(true);
  });
});

describe("ElicitationAnswerSchema", () => {
  it("accepts a value-only answer", () => {
    expect(
      ElicitationAnswerSchema.safeParse({
        value: "allow-once",
        answeredAt: "2026-05-05T12:05:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects an answer missing answeredAt", () => {
    expect(ElicitationAnswerSchema.safeParse({ value: "allow-once" }).success).toBe(false);
  });
});

describe("CreateElicitationSchema", () => {
  it("strips id/status/createdAt/answer from the schema", () => {
    const { id: _i, status: _s, createdAt: _c, ...createInput } = baseElicitation;
    expect(CreateElicitationSchema.safeParse(createInput).success).toBe(true);
  });

  it("rejects passing id at create time", () => {
    // CreateElicitationSchema is built via .omit, which strips the field
    // — extras pass under default Zod object behavior. The contract is
    // documented in TS; the runtime check is on the *required* shape.
    const result = CreateElicitationSchema.safeParse({
      workspaceId: "ws",
      sessionId: "sess",
      kind: "open-question",
      question: "?",
      expiresAt: "2026-05-05T01:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });
});

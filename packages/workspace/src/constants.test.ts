import { describe, expect, it } from "vitest";
import { WORKSPACE_DIRECT_CHAT_SIGNAL_TYPE } from "./constants.ts";

describe("WORKSPACE_DIRECT_CHAT_SIGNAL_TYPE", () => {
  it("matches the wire value the runtime auto-injects and the interactivity check matches", () => {
    expect(WORKSPACE_DIRECT_CHAT_SIGNAL_TYPE).toBe("chat");
  });
});

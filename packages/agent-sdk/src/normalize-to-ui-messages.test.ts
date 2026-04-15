import { describe, expect, it } from "vitest";
import { normalizeToUIMessages } from "./normalize-to-ui-messages.ts";

describe("normalizeToUIMessages", () => {
  it("wraps a plain string as a user UIMessage array", () => {
    const result = normalizeToUIMessages("hello");
    expect(result).toHaveLength(1);
    const msg = result[0];
    expect(msg).toMatchObject({ role: "user", parts: [{ type: "text", text: "hello" }] });
    // id should be a UUID string
    expect(typeof (msg as Record<string, unknown>).id).toBe("string");
    expect((msg as Record<string, unknown>).id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("wraps an empty string as a user UIMessage (delegates rejection to validateAtlasUIMessages)", () => {
    const result = normalizeToUIMessages("");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "" }] });
  });

  it("passes through a UIMessage array as-is", () => {
    const messages = [
      { role: "user", id: "msg-1", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", id: "msg-2", parts: [{ type: "text", text: "hello" }] },
    ];
    const result = normalizeToUIMessages(messages);
    expect(result).toBe(messages); // same reference
  });

  it("wraps a single UIMessage object in an array", () => {
    const msg = { role: "user", id: "msg-1", parts: [{ type: "text", text: "hi" }] };
    const result = normalizeToUIMessages(msg);
    expect(result).toEqual([msg]);
  });

  it("wraps non-string/non-object values for downstream rejection", () => {
    const result = normalizeToUIMessages(42);
    expect(result).toEqual([42]);
  });

  it("wraps null for downstream rejection", () => {
    // null passes typeof === 'object' check but is excluded
    const result = normalizeToUIMessages(null);
    expect(result).toEqual([null]);
  });
});

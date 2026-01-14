import { assertEquals } from "@std/assert";
import { createFailTool } from "./fail-tool.ts";

Deno.test("createFailTool - calls onFail with reason when executed", async () => {
  let capturedInput: { reason: string } | null = null;

  const tool = createFailTool({
    onFail: (input) => {
      capturedInput = input;
    },
  });

  // AI SDK types execute as optional, but createFailTool always provides it
  // biome-ignore lint/style/noNonNullAssertion: createFailTool always provides execute
  const result = await tool.execute!(
    { reason: "Missing credentials" },
    { toolCallId: "test-call-id", messages: [] },
  );

  assertEquals(capturedInput, { reason: "Missing credentials" });
  assertEquals(result, { failed: true, reason: "Missing credentials" });
});

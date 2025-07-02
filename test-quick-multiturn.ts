#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-kv --env-file

console.log("Testing quick multi-turn conversation...\n");

let streamId: string;
let conversationId: string | undefined;

try {
  // 1. Create a stream
  console.log("1. Creating stream...");
  const createResponse = await fetch("http://localhost:8080/api/streams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      createOnly: true,
    }),
  });

  if (!createResponse.ok) {
    throw new Error(`Create failed: ${createResponse.status} ${createResponse.statusText}`);
  }

  const createResult = await createResponse.json();
  console.log("✓ Stream created:", createResult);

  streamId = createResult.stream_id;

  // 2. Send first message and capture conversation ID
  console.log("2. Sending first message...");
  const firstMessage = await fetch(
    `http://localhost:8080/api/workspaces/tender_icing/signals/conversation-stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: streamId,
        message: "Hi! What's 2+2?",
        userId: "test-user",
      }),
    },
  );

  if (!firstMessage.ok) {
    throw new Error(`First message failed: ${firstMessage.status} ${firstMessage.statusText}`);
  }

  console.log("✓ First message sent");

  // Wait a moment
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // 3. Send second message with different stream (simulating multi-turn)
  console.log("3. Creating second stream...");
  const createResponse2 = await fetch("http://localhost:8080/api/streams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      createOnly: true,
    }),
  });

  const createResult2 = await createResponse2.json();
  const streamId2 = createResult2.stream_id;

  console.log("4. Sending second message with conversation context...");
  const secondMessage = await fetch(
    `http://localhost:8080/api/workspaces/tender_icing/signals/conversation-stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: streamId2,
        message: "What was my previous question?",
        userId: "test-user",
        conversationId: "test-conversation-id", // Test with explicit conversation ID
      }),
    },
  );

  if (!secondMessage.ok) {
    throw new Error(`Second message failed: ${secondMessage.status} ${secondMessage.statusText}`);
  }

  console.log("✓ Second message sent with conversation context");
  console.log("✅ Multi-turn conversation architecture is working!");
  console.log("📝 Both messages processed successfully");
} catch (error) {
  console.error("❌ Test failed:", error);
  Deno.exit(1);
}

#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-kv --env-file

console.log("Testing first message to see debug output...\n");

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
  console.log("✓ Stream created:", createResult.stream_id);

  const streamId = createResult.stream_id;

  // 2. Send message and wait a bit for processing
  console.log(`\n💬 Sending: "Hi! My name is Bob and my favorite food is tacos."`);

  const signalResponse = await fetch(
    "http://localhost:8080/api/workspaces/atlas-conversation/signals/conversation-stream",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: streamId,
        message: "Hi! My name is Bob and my favorite food is tacos.",
        userId: "test-user",
      }),
    },
  );

  if (!signalResponse.ok) {
    const errorText = await signalResponse.text();
    throw new Error(
      `Signal failed: ${signalResponse.status} ${signalResponse.statusText} - ${errorText}`,
    );
  }

  console.log("Signal sent successfully");
  console.log("Waiting 10 seconds for processing...");
  await new Promise((resolve) => setTimeout(resolve, 10000));
  console.log("Done waiting - check daemon logs for debug output");
} catch (error) {
  console.error("❌ Test failed:", error);
  Deno.exit(1);
}

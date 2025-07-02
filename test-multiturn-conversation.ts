#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-kv --env-file

console.log("Testing multi-turn conversation...\\n");

let streamId: string;

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
  const sseUrl = `http://localhost:8080${createResult.sse_url}`;

  // 2. Setup SSE listener for both messages
  console.log("2. Connecting to SSE...");
  const eventSource = new EventSource(sseUrl);
  let messageCount = 0;
  let conversationId: string | undefined;

  const ssePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      eventSource.close();
      reject(new Error("SSE timeout after 30 seconds"));
    }, 30000);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log(`📡 Event: ${data.type}`, data);

      // Extract conversation ID from the first message
      if (data.type === "message_chunk" && data.data?.conversationId) {
        conversationId = data.data.conversationId;
      }

      if (data.type === "message_complete") {
        messageCount++;
        console.log(`\\n🎯 Message ${messageCount} complete!\\n`);

        if (messageCount === 2) {
          clearTimeout(timeout);
          eventSource.close();
          resolve({ messageCount, conversationId });
        }
      }
    };

    eventSource.onerror = (error) => {
      clearTimeout(timeout);
      eventSource.close();
      reject(error);
    };
  });

  // 3. Send first message
  console.log("3. Sending first message...");
  const firstMessage = await fetch(
    `http://localhost:8080/api/workspaces/tender_icing/signals/conversation-stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: streamId,
        message: "Hello! What's your name?",
        userId: "test-user",
      }),
    },
  );

  if (!firstMessage.ok) {
    throw new Error(`First message failed: ${firstMessage.status} ${firstMessage.statusText}`);
  }

  console.log("✓ First message sent");

  // 4. Wait a bit, then send second message
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log("4. Sending second message with conversation context...");
  const secondMessage = await fetch(
    `http://localhost:8080/api/workspaces/tender_icing/signals/conversation-stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: streamId,
        message: "Can you remember what I just asked you?",
        userId: "test-user",
        conversationId: conversationId, // Include conversation ID for continuity
      }),
    },
  );

  if (!secondMessage.ok) {
    throw new Error(`Second message failed: ${secondMessage.status} ${secondMessage.statusText}`);
  }

  console.log("✓ Second message sent");

  // 5. Wait for both responses
  const result = await ssePromise;
  console.log(`\\n🎉 Multi-turn test completed! Processed ${result.messageCount} messages`);
  console.log(`📝 Conversation ID: ${result.conversationId}`);
} catch (error) {
  console.error("❌ Test failed:", error);
  Deno.exit(1);
}

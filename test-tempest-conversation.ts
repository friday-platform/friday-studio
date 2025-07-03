#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-kv --env-file

console.log("Testing Tempest conversation agent with history...\n");

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

  // Helper function to send a message and get response
  async function sendMessage(message: string, userId = "test-user"): Promise<string> {
    console.log(`\n💬 Sending: "${message}"`);

    const signalResponse = await fetch(
      "http://localhost:8080/api/workspaces/atlas-conversation/signals/conversation-stream",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamId: streamId,
          message: message,
          userId: userId,
        }),
      },
    );

    if (!signalResponse.ok) {
      const errorText = await signalResponse.text();
      throw new Error(
        `Signal failed: ${signalResponse.status} ${signalResponse.statusText} - ${errorText}`,
      );
    }

    // Connect to SSE to get the response
    const sseUrl = `http://localhost:8080/api/stream/${streamId}/stream`;

    return new Promise((resolve, reject) => {
      const eventSource = new EventSource(sseUrl);
      let fullResponse = "";

      const timeout = setTimeout(() => {
        eventSource.close();
        reject(new Error("SSE timeout after 15 seconds"));
      }, 15000);

      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === "message_chunk" && data.data?.content) {
          fullResponse = data.data.content;
        } else if (data.type === "message_complete" || data.data?.complete) {
          clearTimeout(timeout);
          eventSource.close();
          resolve(fullResponse);
        }
      };

      eventSource.onerror = (error) => {
        clearTimeout(timeout);
        eventSource.close();
        reject(error);
      };
    });
  }

  // 2. Send first message telling agent about favorite food
  const response1 = await sendMessage("Hi! My name is Bob and my favorite food is tacos.");
  console.log("🤖 Response 1:", response1);

  // 3. Send second message asking about name and food - should remember
  await new Promise((resolve) => setTimeout(resolve, 1000)); // Brief pause
  const response2 = await sendMessage("What is my name and what is my favorite food?");
  console.log("🤖 Response 2:", response2);

  // 4. Check if the agent remembered
  if (response2.toLowerCase().includes("bob") && response2.toLowerCase().includes("tacos")) {
    console.log("\n🎉 SUCCESS: Tempest conversation agent remembered the conversation history!");
  } else {
    console.log(
      "\n❌ FAILURE: Tempest conversation agent did not remember the conversation history.",
    );
    console.log("Expected response to mention 'Bob' and 'tacos' but got:", response2);
  }
} catch (error) {
  console.error("❌ Test failed:", error);
  Deno.exit(1);
}

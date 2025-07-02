#!/usr/bin/env -S deno run --allow-all

// Test conversation with history by sending different messages

async function testConversation() {
  const baseUrl = "http://localhost:8080";

  // Create a new conversation session
  console.log("Creating conversation session...");
  const createResponse = await fetch(`${baseUrl}/system/conversation/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: "test-user",
      scope: { workspaceId: "system" },
      message: "Hi, my name is John",
      createOnly: true,
    }),
  });

  const { session_id, response_channel } = await createResponse.json();
  console.log("Session created:", { session_id, response_channel });

  // Send first message with name
  console.log("\nSending first message...");
  const firstResponse = await fetch(`${baseUrl}/system/conversation/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: "test-user",
      sessionId: session_id,
      conversationId: session_id,
      scope: { workspaceId: "system" },
      message: "Hi, my name is John",
    }),
  });

  console.log("First message sent");

  // Wait for first message to complete
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Send second message asking if the agent remembers
  console.log("\nSending second message...");
  const secondResponse = await fetch(`${baseUrl}/system/conversation/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: "test-user",
      sessionId: session_id,
      conversationId: session_id,
      scope: { workspaceId: "system" },
      message: "Do you remember my name?",
    }),
  });

  console.log("Second message sent");

  // Connect to SSE stream to see the response
  const sseUrl = `${baseUrl}${response_channel.url}`;
  console.log("\nConnecting to SSE stream:", sseUrl);

  const eventSource = new EventSource(sseUrl);
  let messageContent = "";

  return new Promise((resolve) => {
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === "message_chunk") {
        messageContent = data.data.content;
        console.log("Response:", messageContent);

        // Check if the agent remembers the name
        if (messageContent.includes("John")) {
          console.log("\n✅ SUCCESS: Agent remembered the name!");
          eventSource.close();
          resolve(true);
        }
      }

      if (data.type === "message_complete") {
        if (!messageContent.includes("John")) {
          console.log("\n❌ FAILED: Agent did not remember the name");
          console.log("Response was:", messageContent);
        }
        eventSource.close();
        resolve(messageContent.includes("John"));
      }
    };

    eventSource.onerror = (error) => {
      console.error("SSE Error:", error);
      eventSource.close();
      resolve(false);
    };

    // Timeout after 10 seconds
    setTimeout(() => {
      console.log("\n❌ TIMEOUT: No response received");
      eventSource.close();
      resolve(false);
    }, 10000);
  });
}

// Run the test
testConversation().then((success) => {
  console.log("\nTest completed:", success ? "PASSED" : "FAILED");
  Deno.exit(success ? 0 : 1);
});

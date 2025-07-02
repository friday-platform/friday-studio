#!/usr/bin/env -S deno run --allow-all

// Test the conversation system end-to-end with session reuse

const userId = "test-user";

console.log("Creating conversation session...");

// Create session
const createResponse = await fetch("http://localhost:8080/system/conversation/stream", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    userId,
    scope: { workspaceId: "system" },
    createOnly: true,
  }),
});

if (!createResponse.ok) {
  console.error("Failed to create session:", await createResponse.text());
  Deno.exit(1);
}

const sessionData = await createResponse.json();
console.log("Session created:", sessionData);
const sessionId = sessionData.session_id;

// Function to listen to SSE stream
async function listenToStream(messageNum: number) {
  console.log(`\n--- Message ${messageNum} ---`);
  console.log("Connecting to SSE stream...");
  const sseUrl = `http://localhost:8080${sessionData.response_channel.url}`;
  console.log("SSE URL:", sseUrl);

  const eventSource = new EventSource(sseUrl);
  let messageContent = "";

  return new Promise<void>((resolve, reject) => {
    eventSource.onopen = () => {
      console.log("SSE connection opened");
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "message_chunk") {
          messageContent = data.data.content;
          console.log(`Message progress: ${messageContent}`);
        } else if (data.type === "message_complete") {
          console.log(`\nFinal message: ${messageContent}`);
          console.log("Message complete!");
          eventSource.close();
          resolve();
        } else {
          console.log(`Event type: ${data.type}`, data);
        }
      } catch (e) {
        console.log("Raw SSE message:", event.data);
      }
    };

    eventSource.onerror = (error) => {
      console.error("SSE error:", error);
      eventSource.close();
      reject(error);
    };

    // Timeout after 10 seconds
    setTimeout(() => {
      console.error("Timeout waiting for response");
      eventSource.close();
      reject(new Error("Timeout"));
    }, 10000);
  });
}

// Send first message
console.log("\nSending first message...");
const message1Response = await fetch("http://localhost:8080/system/conversation/stream", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    userId,
    sessionId: sessionId,
    conversationId: sessionId,
    scope: { workspaceId: "system" },
    message: "Hello, how are you?",
  }),
});

if (!message1Response.ok) {
  console.error("Failed to send first message:", await message1Response.text());
  Deno.exit(1);
}

const message1Data = await message1Response.json();
console.log("First message sent, new session:", message1Data.session_id);

// Listen to first response
await listenToStream(1);

// Wait a bit
await new Promise((resolve) => setTimeout(resolve, 1000));

// Send second message
console.log("\nSending second message...");
const message2Response = await fetch("http://localhost:8080/system/conversation/stream", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    userId,
    sessionId: sessionId,
    conversationId: sessionId,
    scope: { workspaceId: "system" },
    message: "What can you help me with?",
  }),
});

if (!message2Response.ok) {
  console.error("Failed to send second message:", await message2Response.text());
  Deno.exit(1);
}

const message2Data = await message2Response.json();
console.log("Second message sent, session:", message2Data.session_id);

// Listen to second response
await listenToStream(2);

console.log("\nTest completed successfully!");
Deno.exit(0);

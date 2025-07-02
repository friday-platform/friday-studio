#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-kv --env-file

console.log("Testing simple direct conversation...\n");

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

  const streamId = createResult.stream_id;
  const sseUrl = `http://localhost:8080${createResult.sse_url}`;

  // 2. Connect to SSE
  console.log("2. Connecting to SSE...");
  const ssePromise = (async () => {
    const eventSource = new EventSource(sseUrl);
    let eventCount = 0;
    const events: any[] = [];

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        eventSource.close();
        reject(new Error("SSE timeout after 10 seconds"));
      }, 10000);

      eventSource.onmessage = (event) => {
        eventCount++;
        const data = JSON.parse(event.data);
        events.push(data);
        console.log(`📡 Event ${eventCount}:`, data);

        if (data.type === "message_complete" || data.data?.complete) {
          clearTimeout(timeout);
          eventSource.close();
          resolve({ eventCount, events });
        }
      };

      eventSource.onerror = (error) => {
        clearTimeout(timeout);
        eventSource.close();
        reject(error);
      };
    });
  })();

  // 3. Send a direct conversation message (no workspace)
  console.log("3. Sending conversation message...");
  setTimeout(async () => {
    const messageResponse = await fetch("http://localhost:8080/api/streams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: streamId,
        message: "Hello! This is a direct conversation test.",
        userId: "test-user",
      }),
    });

    if (!messageResponse.ok) {
      throw new Error(`Message failed: ${messageResponse.status} ${messageResponse.statusText}`);
    }

    const messageResult = await messageResponse.json();
    console.log("✓ Message sent:", messageResult);
  }, 1000);

  // 4. Wait for SSE events
  const result = await ssePromise;
  console.log(`\n🎉 Test completed! Received ${result.eventCount} events`);
} catch (error) {
  console.error("❌ Test failed:", error);
  Deno.exit(1);
}

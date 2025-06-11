console.log("[TestWorker] Starting...");

self.onmessage = (event) => {
  console.log("[TestWorker] Received:", event.data);

  if (event.data.type === "init") {
    console.log("[TestWorker] Initializing...");
    self.postMessage({ type: "initialized" });
  }
};

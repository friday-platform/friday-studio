import { assertEquals } from "@std/assert";
import { findAvailablePort, getNextAvailablePort } from "../../src/utils/port-finder.ts";

Deno.test("findAvailablePort - finds available port in default range", () => {
  const port = findAvailablePort();
  assertEquals(port >= 8080 && port <= 8180, true, "Port should be in default range");
});

Deno.test("findAvailablePort - respects preferred port if available", () => {
  // Find a known available port first
  const availablePort = findAvailablePort({ startPort: 9000, endPort: 9100 });

  // Request that specific port as preferred
  const port = findAvailablePort({ preferredPort: availablePort, startPort: 9000, endPort: 9100 });

  assertEquals(port, availablePort, "Should return preferred port when available");
});

Deno.test("findAvailablePort - finds alternative when preferred is occupied", () => {
  // Create a listener to occupy a port - make sure to use same hostname
  const occupiedPort = 19200;
  const listener = Deno.listen({ port: occupiedPort, hostname: "localhost" });

  try {
    const port = findAvailablePort({
      preferredPort: occupiedPort,
      startPort: 19200,
      endPort: 19210,
      host: "localhost",
    });

    assertEquals(port !== occupiedPort, true, "Should not return occupied port");
    assertEquals(port >= 19200 && port <= 19210, true, "Should be in specified range");
  } finally {
    listener.close();
  }
});

Deno.test("findAvailablePort - handles fully occupied range", () => {
  // Occupy a small range of ports
  const listeners = [];
  for (let p = 19300; p <= 19302; p++) {
    listeners.push(Deno.listen({ port: p, hostname: "localhost" }));
  }

  try {
    const port = findAvailablePort({ startPort: 19300, endPort: 19302, host: "localhost" });

    // Should fall back to random port outside the range
    assertEquals(port < 19300 || port > 19302, true, "Should find port outside occupied range");
  } finally {
    listeners.forEach((l) => l.close());
  }
});

Deno.test("getNextAvailablePort - finds next available port", () => {
  const startPort = 19400;
  const listener = Deno.listen({ port: startPort, hostname: "localhost" });

  try {
    const port = getNextAvailablePort(startPort, "localhost");
    assertEquals(port > startPort, true, "Should find port after start port");
  } finally {
    listener.close();
  }
});

Deno.test("findAvailablePort - respects custom host", () => {
  const port = findAvailablePort({ host: "127.0.0.1", startPort: 9500, endPort: 9510 });

  assertEquals(port >= 9500 && port <= 9510, true, "Should find port in range");

  // Verify the port is actually available on that host
  const listener = Deno.listen({ port, hostname: "127.0.0.1" });
  listener.close();
});

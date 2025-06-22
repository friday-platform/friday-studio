# Test Utilities

This directory contains common utilities for integration and unit tests across the Atlas project.

## Overview

The test utilities provide reusable functionality for:

- **Port Management**: Finding available ports for test servers
- **Server Management**: Base classes and interfaces for test servers
- **Async Utilities**: Delays, retries, timeouts, and URL waiting
- **Test Environment**: Resource management and cleanup
- **Random Data**: Test ID generation and random strings

## Core Utilities

### Port Management

```typescript
import { findAvailablePort, isPortAvailable } from "../utils/test-utils.ts";

// Find any available port in the default range (8000-9999)
const port = await findAvailablePort();

// Find available port in custom range
const customPort = await findAvailablePort(3000, 4000);

// Check if specific port is available
const available = await isPortAvailable(8080);
```

### Server Management

```typescript
import { BaseTestServer, TestServer } from "../utils/test-utils.ts";

// Extend BaseTestServer for consistent behavior
class MyTestServer extends BaseTestServer {
  async start(): Promise<number> {
    this.port = await this.findPort();
    // Start your server implementation
    return this.port;
  }
}

// Or implement TestServer interface
class CustomServer implements TestServer {
  async start(): Promise<number> {
    /* implementation */
  }
  async stop(): Promise<void> {
    /* implementation */
  }
  getPort(): number {
    /* implementation */
  }
  getBaseUrl(): string {
    /* implementation */
  }
}
```

### Test Environment & Cleanup

```typescript
import { createTestEnvironment } from "../utils/test-utils.ts";

Deno.test("My integration test", async () => {
  const env = createTestEnvironment();

  // Start servers and register for cleanup
  const server1Port = await env.startServer(new MyTestServer());
  const server2Port = await env.startServer(new AnotherTestServer());

  try {
    // Run your tests
  } finally {
    // Cleanup all registered resources
    await env.cleanup();
  }
});
```

### Async Utilities

```typescript
import { delay, retryWithBackoff, waitForUrl, withTimeout } from "../utils/test-utils.ts";

// Simple delay
await delay(1000); // Wait 1 second

// Retry with exponential backoff
const result = await retryWithBackoff(
  async () => {
    // Operation that might fail
    return await fetch("/api/endpoint");
  },
  3, // max attempts
  100, // base delay ms
);

// Add timeout to any operation
const data = await withTimeout(
  longRunningOperation(),
  5000, // 5 second timeout
  "Operation took too long",
);

// Wait for server to be ready
await waitForUrl("http://localhost:8080/health", 10000);
```

### Random Data Generation

```typescript
import { generateTestId, randomString } from "../utils/test-utils.ts";

// Generate random string
const id = randomString(8); // "a7b3x9m2"

// Generate unique test ID
const testId = generateTestId("user"); // "user-a7b3x9m2-1703123456789"
```

## Example Usage in Test Files

### Basic Integration Test

```typescript
import { assertEquals } from "@std/assert";
import { delay, findAvailablePort } from "../utils/test-utils.ts";
import { MyTestServer } from "./my-test-server.ts";

Deno.test("Basic server functionality", async () => {
  const server = new MyTestServer();

  try {
    const port = await server.start();

    // Wait for server to be ready
    await delay(100);

    // Test server functionality
    const response = await fetch(server.getBaseUrl() + "/ping");
    assertEquals(response.status, 200);
  } finally {
    await server.stop();
  }
});
```

### Advanced Integration Test with Environment

```typescript
import { assertEquals } from "@std/assert";
import { createTestEnvironment, waitForUrl } from "../utils/test-utils.ts";
import { APIServer, DatabaseServer } from "./test-servers.ts";

Deno.test("Full stack integration", async () => {
  const env = createTestEnvironment();

  try {
    // Start database server
    const dbPort = await env.startServer(new DatabaseServer());
    const dbUrl = `http://localhost:${dbPort}`;

    // Start API server
    const apiPort = await env.startServer(new APIServer({ dbUrl }));
    const apiUrl = `http://localhost:${apiPort}`;

    // Wait for both servers to be ready
    await waitForUrl(dbUrl + "/health");
    await waitForUrl(apiUrl + "/health");

    // Run integration tests
    const response = await fetch(apiUrl + "/api/users");
    assertEquals(response.status, 200);
  } finally {
    // Automatically cleanup all servers
    await env.cleanup();
  }
});
```

### Concurrent Testing

```typescript
import { assertEquals } from "@std/assert";
import { findAvailablePort } from "../utils/test-utils.ts";
import { MyTestServer } from "./my-test-server.ts";

Deno.test("Concurrent requests", async () => {
  const servers = await Promise.all([
    new MyTestServer().start(),
    new MyTestServer().start(),
    new MyTestServer().start(),
  ]);

  try {
    // Test all servers concurrently
    const responses = await Promise.all(
      servers.map((server) => fetch(server.getBaseUrl() + "/ping")),
    );

    responses.forEach((response) => {
      assertEquals(response.status, 200);
    });
  } finally {
    await Promise.all(servers.map((server) => server.stop()));
  }
});
```

## Benefits

### Consistency

- Standardized port allocation across all test suites
- Common patterns for server lifecycle management
- Consistent error handling and cleanup

### Reliability

- Automatic port conflict resolution
- Proper resource cleanup to prevent test pollution
- Retry logic for flaky operations

### Reusability

- Base classes reduce boilerplate in test servers
- Common utilities prevent code duplication
- Extensible patterns for different test scenarios

### Maintainability

- Centralized test infrastructure
- Easy to update utilities across all tests
- Clear separation of test logic from infrastructure

## Future Enhancements

- **Database Utilities**: Common database setup/teardown patterns
- **Mock Factories**: Standardized mock data generation
- **Performance Testing**: Load testing utilities and metrics
- **Network Simulation**: Utilities for testing network failures
- **Container Support**: Docker/container management utilities

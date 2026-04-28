# @atlas/logger

Atlas logging with Winston-style interface and dual output.

## Overview

Replaces the 500+ line `AtlasLogger` with a ~150 line implementation:

- Winston-style interface: `logger.info(message, context)` and `logger.child()`
- Writes structured JSON to disk files + human-readable output to console
- Color-coded console output with automatic TTY detection
- Uses `writeFile` from `node:fs/promises` - no file handle management
- No resource cleanup needed
- Console output captured by Deno's OpenTelemetry

## Installation

```typescript
import { createLogger, logger } from "@atlas/logger";
import type { LogContext, Logger } from "@atlas/logger";
```

## Usage

### Basic Logging

```typescript
import { logger } from "@atlas/logger";

logger.info("User authenticated", { userId: "123", sessionId: "abc" });
logger.error("Database connection failed", { error: "timeout", retries: 3 });
logger.debug("Processing request", { requestId: "req-456" });
```

### Error Logging

Error objects are automatically serialized with full context:

```typescript
try {
  await riskyOperation();
} catch (error) {
  // Error objects are fully serialized with stack, cause chain, and custom properties
  logger.error("Operation failed", { error, userId: "123" });
}
```

### Child Loggers

```typescript
import { logger } from "@atlas/logger";

// Child logger includes context automatically
const childLogger = logger.child({
  workerId: "worker-1",
  workspaceId: "ws-123",
});

childLogger.info("Task completed");
childLogger.error("Task failed", { reason: "timeout" });
```

### Factory Functions

```typescript
import { createLogger } from "@atlas/logger";

const dbLogger = createLogger({
  component: "database",
  version: "2.1",
});

dbLogger.info("Connection established");
```

## Output Formats

### Console Output

Console output includes color coding for log levels:

```
[18:29:50.330] INFO (atlas): User authenticated {"userId":"123","sessionId":"abc"}
[18:29:50.331] ERROR (atlas): Database connection failed {"error":"timeout","retries":3}
[18:29:50.332] INFO (atlas:worker): Task completed {"workerId":"worker-1","workspaceId":"ws-123"}
```

**Color Scheme:**

- `FATAL`: Bold Red - Critical issues requiring immediate attention
- `ERROR`: Red - Errors that need fixing
- `WARN`: Yellow - Warnings requiring caution
- `INFO`: Cyan - General information
- `DEBUG`: Gray - Detailed debugging information
- `TRACE`: Magenta - Most verbose tracing

**Color Control:**

- Colors automatically disabled when not in a TTY (pipes, redirects)
- Set `NO_COLOR=1` to disable colors
- Set `FORCE_COLOR=1` to force colors even in non-TTY environments
- Colors disabled during testing (`DENO_TESTING=true`)

### File Output (JSON)

```json
{
  "timestamp": "2025-07-31T18:29:50.330Z",
  "level": "info",
  "message": "User authenticated",
  "pid": 1234,
  "hostname": "hostname",
  "context": { "userId": "123", "sessionId": "abc" }
}
```

### Error Serialization

Error objects include full context:

```json
{
  "timestamp": "2025-07-31T18:29:50.330Z",
  "level": "error",
  "message": "Operation failed",
  "pid": 1234,
  "hostname": "hostname",
  "context": {
    "userId": "123",
    "error": {
      "name": "TypeError",
      "message": "Cannot read property 'x' of null",
      "stack": "TypeError: Cannot read property...\n  at func (file.ts:10:5)",
      "code": "ERR_INVALID_ARG",
      "cause": {
        "name": "Error",
        "message": "Network timeout",
        "stack": "Error: Network timeout..."
      }
    }
  }
}
```

## File Paths

**User Mode:**

- `~/.atlas/logs/global.log` - Daemon and non-workspace logs
- `~/.atlas/logs/workspaces/{workspaceId}.log` - Workspace-specific logs

**System Service Mode:**

- `/var/log/atlas/global.log` - System daemon logs
- `/var/log/atlas/workspaces/{workspaceId}.log` - System workspace logs

**Path Detection:**

- `FRIDAY_LOGS_DIR` environment variable override
- `.atlas` directory detection for compiled binaries
- Windows/Unix home directory detection
- System service detection (root user, `FRIDAY_SYSTEM_MODE=true`, `atlas` user)

## API Reference

### Logger Interface

```typescript
interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}
```

### Exports

```typescript
// Default logger instance
export const logger: Logger;

// Factory function
export function createLogger(context?: LogContext): Logger;

// Backward compatibility (singleton pattern)
export const AtlasLogger: {
  getInstance(): Logger;
  resetInstance(): void; // no-op
};

// Type exports
export type { LogContext, LogEntry, Logger };
```

## Migration

### From Old Logger

```typescript
// OLD: async logging
import { AtlasLogger } from "../src/utils/logger.ts";
const logger = AtlasLogger.getInstance();
await logger.info("Message", { context });

// NEW: sync logging
import { logger } from "@atlas/logger";
logger.info("Message", { context });
```

### Child Logger Creation

```typescript
// OLD: createChildLogger method
const childLogger = logger.createChildLogger({ workerId, workspaceId });

// NEW: child method
const childLogger = logger.child({ workerId, workspaceId });
```

### Backward Compatibility

Existing singleton code still works:

```typescript
import { AtlasLogger } from "@atlas/logger";
const logger = AtlasLogger.getInstance();
logger.info("Message"); // No longer async, but works
```

## Testing

Skips logging when `DENO_TESTING=true`:

```typescript
import { createLogger } from "@atlas/logger";

const testLogger = createLogger({ test: true });
testLogger.info("Silent in tests");
```

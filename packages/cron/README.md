# @atlas/cron

Daemon-level cron management service that enables scheduled automation in Atlas' signal-driven
architecture. CronManager runs independently of workspace lifecycles, allowing workspaces to sleep
while maintaining reliable timer execution.

## Overview

The cron package is a critical component of Atlas' resource efficiency strategy. By centralizing
timer management at the daemon level, workspaces can remain dormant until triggered by scheduled
events, dramatically reducing resource consumption while maintaining automation reliability.

## Key Features

- **Daemon-Level Service**: Runs as part of the Atlas daemon, independent of workspace lifecycles
- **Persistent State**: Uses KV storage to survive daemon restarts and maintain timer schedules
- **Signal-Driven Integration**: Generates timer signals that wake sleeping workspaces
- **Concurrency-Safe**: Thread-safe operations with mutex locks for timer management
- **Timezone-Aware**: Full timezone support for global scheduling requirements
- **Error Resilient**: Continues scheduling even after execution failures

## Architectural Position

```
Atlas Daemon
├── CronManager (this package)
│   ├── Timer Registry (in-memory)
│   ├── KV Storage (persistent state)
│   └── Wake-up Callbacks → WorkspaceRuntime
│
├── WorkspaceRuntime
│   ├── Signal Processing
│   └── WorkspaceSupervisor → SessionSupervisor → Agents
```

CronManager sits at the daemon level, managing timers for all workspaces. When timers fire, they
generate signals that wake dormant workspaces through the standard Atlas signal processing pipeline.

## Integration with Atlas Daemon

### Initialization

CronManager is initialized as part of the Atlas daemon startup sequence:

```typescript
import { CronManager } from "@atlas/cron";
import { createKVStorage } from "@atlas/storage";

// During daemon initialization
const kvStorage = await createKVStorage({ type: "deno-kv" });
await kvStorage.initialize();

const cronManager = new CronManager(kvStorage, logger);

// Configure the wake-up mechanism
cronManager.setWakeupCallback(async (workspaceId, signalId, signalData) => {
  // This callback bridges CronManager to WorkspaceRuntime
  const runtime = await getOrCreateWorkspaceRuntime(workspaceId);
  await runtime.processSignal(signalData);
});

// Start the service
await cronManager.start();
```

### Timer Registration

Timers are registered when workspaces configure cron-based signals:

```typescript
// When workspace initializes with cron signal configuration
await cronManager.registerTimer({
  workspaceId: "analytics-workspace",
  signalId: "daily-report",
  schedule: "0 9 * * *", // Daily at 9 AM
  timezone: "America/New_York",
});
```

### Runtime Operations

```typescript
// Workspace cleanup - remove all timers
await cronManager.unregisterWorkspaceTimers("analytics-workspace");

// Get system statistics
const stats = cronManager.getStats();
// Returns: { totalTimers, nextExecution }

// Check if the cron manager is running
const isRunning = cronManager.isRunning; // boolean
```

## Signal-Driven Timer Model

### Workspace Configuration

Timers are defined as signals in workspace configuration:

```yaml
# workspace.yml
signals:
  daily-summary:
    provider: "schedule"
    config:
      schedule: "0 9 * * *" # Daily at 9 AM
      timezone: "America/New_York"

  hourly-sync:
    provider: "schedule"
    config:
      schedule: "0 * * * *" # Every hour
      timezone: "UTC"
```

### Signal Data Structure

When timers fire, they generate signals with the following structure:

```typescript
interface CronTimerSignalData {
  id: string; // Signal ID from configuration
  timestamp: string; // ISO 8601 timestamp
  data: {
    scheduled: string; // Original cron expression
    timezone: string; // Configured timezone
    nextRun: string; // Next scheduled execution
  };
}
```

## Cron Expression Support

CronManager uses standard cron expressions with optional seconds field:

### Standard Format (5 fields)

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-7, Sunday = 0 or 7)
│ │ │ │ │
* * * * *
```

### Extended Format (6 fields with seconds)

```
┌───────────── second (0-59)
│ ┌───────────── minute (0-59)
│ │ ┌───────────── hour (0-23)
│ │ │ ┌───────────── day of month (1-31)
│ │ │ │ ┌───────────── month (1-12)
│ │ │ │ │ ┌───────────── day of week (0-7)
│ │ │ │ │ │
* * * * * *
```

### Common Patterns

- `*/5 * * * *` - Every 5 minutes
- `0 */2 * * *` - Every 2 hours
- `0 9 * * 1-5` - Weekdays at 9 AM
- `0 0 1 * *` - First day of each month
- `*/10 * * * * *` - Every 10 seconds (extended format)

## Persistence and Recovery

### Storage Schema

```typescript
// KV Storage key pattern: ["cron_timers", "{workspaceId}:{signalId}"]
// Stored data is TimerInfo serialized with ISO 8601 date strings
interface StoredTimerData {
  workspaceId: string;
  signalId: string;
  schedule: string;
  timezone: string;
  nextExecution: string; // ISO 8601
  lastExecution?: string; // ISO 8601
}
```

### Recovery Behavior

1. **Daemon Restart**: All timers are restored from KV storage
2. **Expired Timers**: Next execution is recalculated if past due
3. **Failed Persistence**: Retries with exponential backoff
4. **Corrupted Data**: Skipped with error logging, doesn't affect other timers

## Concurrency and Thread Safety

### Locking Mechanism

CronManager uses a mutex-based locking system to ensure thread-safe operations:

```typescript
class TimerOperationLock {
  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
}
```

All timer operations (register, unregister, execute) are protected by locks to prevent:

- Race conditions during concurrent registrations
- Double execution of timers
- State corruption during persistence

### Graceful Shutdown

CronManager tracks all pending operations and ensures clean shutdown:

1. **Operation Tracking**: All async operations are tracked
2. **Shutdown Sequence**: Waits for pending operations to complete
3. **State Persistence**: Final state is persisted before shutdown
4. **Timer Cleanup**: All active intervals are cleared

## Error Handling and Resilience

### Registration Errors

- **Invalid Cron Expression**: Fails fast with clear error message
- **Duplicate Registration**: Skipped with warning log
- **Storage Failure**: Operation fails but CronManager remains operational

### Execution Errors

- **Callback Failures**: Logged but timer continues scheduling
- **Timeout Protection**: Wake-up callbacks have 30-second timeout
- **Next Execution**: Always calculated even after failures

### Storage Errors

- **Persistence Retry**: Exponential backoff with jitter (max 3 attempts)
- **Recovery Failures**: Individual timer skipped, others continue
- **Corruption Handling**: Invalid data logged and skipped

### Monitoring

- **Metrics**: Export stats via `getStats()` for monitoring
- **Logging**: Structured logs with timer context
- **Health Checks**: Check `isRunning` property for liveness probes

## API Reference

### CronManager Class

```typescript
class CronManager {
  constructor(storage: KVStorage, logger: Logger);

  // State
  isRunning: boolean; // Public read-only property

  // Lifecycle
  start(): Promise<void>;
  shutdown(): Promise<void>;

  // Timer Management
  registerTimer(config: TimerConfig): Promise<void>;
  unregisterWorkspaceTimers(workspaceId: string): Promise<void>;

  // Statistics
  getStats(): { totalTimers: number; nextExecution?: Date };

  // Configuration
  setWakeupCallback(callback: WorkspaceSignalTriggerCallback): void;
}
```

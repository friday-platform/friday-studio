# @atlas/cron

Daemon-level cron management for Atlas workspaces that enables reliable scheduled automation while
allowing workspaces to sleep for resource efficiency.

## Features

- **Persistent Timer Storage**: Uses KV storage to maintain timer state across daemon restarts
- **Workspace Sleep Compatibility**: Timers run independently of workspace runtime lifecycle
- **Wake-up Mechanism**: Automatically activates sleeping workspaces when timers fire
- **Centralized Management**: Single daemon-level service manages all workspace timers
- **Error Recovery**: Robust error handling ensures timers continue even after failures

## Architecture

```
AtlasDaemon → CronManager → KV Storage (persistent)
                   ↓
           Individual Timers → Wake Up Workspaces
```

## Usage

### Basic Setup

```typescript
import { CronManager } from "@atlas/cron";
import { createKVStorage } from "@atlas/storage";

// Initialize with KV storage and logger
const kvStorage = await createKVStorage({ type: "deno-kv" });
await kvStorage.initialize();

const cronManager = new CronManager(kvStorage, logger);

// Set workspace wakeup callback
cronManager.setWakeupCallback(async (workspaceId, signalId, signalData) => {
  const runtime = await getOrCreateWorkspaceRuntime(workspaceId);
  await runtime.processSignal(signalData, signalData.data);
});

// Start the cron manager
await cronManager.start();
```

### Timer Registration

```typescript
// Register a timer for a workspace signal
await cronManager.registerTimer({
  workspaceId: "topic-summarizer",
  signalId: "timer-github-scan",
  schedule: "*/30 * * * *", // Every 30 minutes
  timezone: "UTC",
  description: "Automated GitHub repository discovery",
});
```

### Timer Management

```typescript
// List active timers
const activeTimers = cronManager.listActiveTimers();

// Get specific timer info
const timer = cronManager.getTimer("workspace-id", "signal-id");

// Unregister a timer
await cronManager.unregisterTimer("workspace-id", "signal-id");

// Unregister all timers for a workspace
await cronManager.unregisterWorkspaceTimers("workspace-id");

// Get statistics
const stats = cronManager.getStats();
console.log(`Active timers: ${stats.activeTimers}`);
```

### Lifecycle Management

```typescript
// Shutdown cleanly (persists state)
await cronManager.shutdown();
```

## Timer Configuration

Timers are configured using cron expressions with timezone support:

```yaml
# In workspace.yml
signals:
  timer-github-scan:
    provider: "cron-scheduler"
    schedule: "*/30 * * * *" # Every 30 minutes
    timezone: "UTC"
    description: "Automated timer signal"
```

## Supported Cron Expressions

The cron manager uses the `cron-parser` library and supports standard cron expressions:

- `*/30 * * * *` - Every 30 minutes
- `0 9 * * 1` - Every Monday at 9 AM
- `0 0 * * *` - Daily at midnight
- `0 12 * * 1-5` - Weekdays at noon

## Storage Schema

Timers are persisted in KV storage with the following structure:

```typescript
// Storage key: ["cron_timers", "workspaceId:signalId"]
interface PersistedTimerData {
  workspaceId: string;
  signalId: string;
  schedule: string;
  timezone: string;
  description?: string;
  nextExecution?: string; // ISO string
  lastExecution?: string; // ISO string
  isActive: boolean;
  registeredAt: string; // ISO string
}
```

## Error Handling

The cron manager includes comprehensive error handling:

- **Invalid Cron Expressions**: Validated at registration time
- **Execution Failures**: Timers continue scheduling even after execution errors
- **Storage Failures**: Graceful degradation with logging
- **Workspace Wake-up Failures**: Isolated per-timer, doesn't affect other timers

## Integration with Atlas Daemon

The cron manager integrates seamlessly with the Atlas daemon lifecycle:

1. **Initialization**: Loads persisted timers on daemon startup
2. **Registration**: Automatically discovers cron signals in workspace configurations
3. **Execution**: Wakes up workspaces when timers fire
4. **Cleanup**: Persists state and cleans up timers on daemon shutdown

## Testing

Run the test suite:

```bash
deno task test
```

The package includes comprehensive tests for:

- Timer registration and unregistration
- Cron expression parsing and validation
- Storage persistence and recovery
- Error recovery scenarios
- Workspace integration patterns

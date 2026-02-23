# Signal Details Schedule Editor

## Problem Statement

The signal-details component on job pages displays parsed cron data with
dropdowns but they're purely presentational — no state management, no event
handlers, no API persistence. Users can't actually change a signal's schedule or
switch between manual (webhook) and scheduled triggers.

## Solution

Make the signal-details dropdowns functional with client-side state (`$state`
runes), a cron adapter for bidirectional conversion, and optimistic updates to
the workspace config API. Users can switch between manual and scheduled triggers,
configure frequency/days/time, and see changes persist immediately.

## User Stories

1. As a workspace owner, I want to switch a signal from scheduled to manual, so
   that I can trigger it on demand via webhook
2. As a workspace owner, I want to switch a signal from manual to scheduled, so
   that it runs automatically on a cron
3. As a workspace owner, I want to select hourly frequency, so that the signal
   fires every hour
4. As a workspace owner, I want to select daily frequency with a specific time,
   so that the signal fires once per day at that time
5. As a workspace owner, I want to select weekly frequency with a specific day
   and time, so that the signal fires once per week
6. As a workspace owner, I want to select custom frequency with multiple days, so
   that the signal fires on specific days of the week
7. As a workspace owner, I want to type a time in 24h format and have it
   auto-convert to 12h on blur, so that I don't have to think about conversion
8. As a workspace owner, I want to switch between AM/PM and hourly intervals, so
   that I can control whether the signal runs at a specific time or every N hours
9. As a workspace owner, I want to see the frequency dropdown label reflect my
   day selection (e.g. "Every Monday, Tuesday"), so that I know what's configured
   at a glance
10. As a workspace owner, I want changes to persist immediately without a save
    button, so that the UI feels responsive
11. As a workspace owner, I want to see a toast if an update fails and have the
    UI revert, so that I know something went wrong
12. As a workspace owner, I want selecting all 7 days to normalize to "Daily"
    when I close the dropdown, so that redundant state is cleaned up automatically

## Implementation Decisions

### State Model

Flat object managed with `$state`:

```typescript
type Mode = "manual" | "schedule";
type Interval = "hourly" | "daily" | "weekly" | "custom";
type Period = "AM" | "PM" | "Hours";

interface ScheduleState {
  mode: Mode;
  interval: Interval;
  days: string[];     // e.g. ["Monday", "Tuesday"]
  time: string;       // "9:00" (AM/PM) or "3" (Hours)
  period: Period;
  timezone: string;   // IANA timezone, e.g. "America/New_York"
}
```

### Cron Adapter

Two pure functions in a colocated `cron.ts` module:

- `parseCron(cron: string) -> ScheduleState` — parse cron string into UI state
- `buildCron(state: ScheduleState) -> string` — serialize UI state to cron

Conversion examples:

| State | Cron |
|-------|------|
| `{ interval: "hourly" }` | `0 * * * *` |
| `{ interval: "daily", time: "9:00", period: "AM" }` | `0 9 * * *` |
| `{ interval: "daily", time: "2:30", period: "PM" }` | `30 14 * * *` |
| `{ interval: "daily", time: "12:00", period: "PM" }` | `0 12 * * *` |
| `{ interval: "weekly", days: ["Monday"], time: "9:00", period: "AM" }` | `0 9 * * 1` |
| `{ interval: "weekly", days: ["Friday"], time: "5:00", period: "PM" }` | `0 17 * * 5` |
| `{ interval: "custom", days: ["Monday", "Friday"], time: "9:00", period: "AM" }` | `0 9 * * 1,5` |
| `{ interval: "custom", days: ["Monday", "Wednesday"], time: "8:00", period: "PM" }` | `0 20 * * 1,3` |
| `{ interval: "custom", days: ["Monday"], time: "3", period: "Hours" }` | `0 */3 * * 1` |
| `{ interval: "custom", days: ["Tuesday", "Thursday"], time: "6", period: "Hours" }` | `0 */6 * * 2,4` |
| Custom w/ all 7 days, time: "9:00", period: "AM" | `0 9 * * *` (normalizes to daily) |
| Custom w/ all 7 days, time: "3", period: "Hours" | `0 */3 * * *` (normalizes to daily) |

### Component Structure

```
jobs/[jobId]/(components)/
  signal-details.svelte   — owns all state, dropdowns, persistence
  cron.ts                 — pure parseCron / buildCron functions
```

Props: `signal`, `workspaceId`, `signalId`.

### Dropdown Visibility Rules

| Frequency | Days list | Time selector | Period options | Timezone |
|-----------|-----------|---------------|---------------|----------|
| Hourly | hidden | hidden | — | hidden |
| Daily | hidden | shown | AM/PM only | shown |
| Weekly | shown (single select) | shown | AM/PM only | shown |
| Custom | shown (multi-select) | shown | AM/PM + Hours | shown |

Manual mode hides all frequency/time/day controls.

### Frequency Dropdown Trigger Labels

- Hourly: "Every hour"
- Daily: "Every day"
- Weekly w/ 1 day: "Every Monday"
- Custom w/ 2 days: "Every Monday, Tuesday"
- Custom w/ 3+ days: "Every Mon, Tue, Wed, ..."
- Custom w/ all 7: "Every day" (normalizes to Daily on dropdown close)

### Period Dropdown Behavior

- AM/PM shows "at" prefix text, Hours shows "every" prefix
- Switching AM/PM to Hours: `"9:00"` becomes `"9"`
- Switching Hours to AM/PM: `"5"` becomes `"5:00"`, values > 13 reset to
  `"9:00" AM`

### Time Input Behavior

- During typing: block non-digit/colon characters (Hours mode: digits only)
- On blur: convert 24h to 12h (e.g. `"14:00"` becomes `"2:00"`, period flips to
  PM)

### Mode Switch Defaults

- Manual to Schedule: defaults to Monday at 9am (`0 9 * * 1`)
- Schedule to Manual: `provider: "http"` with path `/webhooks/{signalId}`

### All-7-Days Normalization

When custom frequency has all 7 days selected and the user closes the dropdown,
silently reset to Daily interval. No API call needed — the cron is identical.

`DropdownMenu.Root` accepts `onOpenChange`, a `ChangeFn<boolean>` from melt-ui's
`overridable` pattern. It receives `{ curr, next }` (previous and incoming open
state) and returns the final boolean value. The normalization hooks into the
closing transition:

```typescript
function handleFrequencyOpenChange({  next }: { next: boolean }) {
  // Normalize on close: all 7 days → daily
  if (!next && state.interval === "custom" && state.days.length === 7) {
    state.interval = "daily";
    state.days = [];
  }
  return next;
}
```

Pass to the frequency dropdown: `<DropdownMenu.Root onOpenChange={handleFrequencyOpenChange}>`

### Timezone Dropdown

Shown after the time input for all frequencies except hourly. Defaults to the
signal's current `config.timezone` value (or the user's browser timezone via
`Intl.DateTimeFormat().resolvedOptions().timeZone` for new schedules).

**Curated list (~35 timezones)** grouped by continent using `DropdownMenu.Label`:

- **Americas:** New York, Chicago, Denver, Los Angeles, Anchorage, Toronto,
  Vancouver, Mexico City, Sao Paulo, Buenos Aires, Bogota
- **Europe:** London, Paris, Berlin, Amsterdam, Madrid, Rome, Stockholm, Moscow,
  Istanbul
- **Asia:** Dubai, Kolkata, Singapore, Tokyo, Shanghai, Hong Kong, Seoul,
  Bangkok, Jakarta
- **Pacific:** Auckland, Honolulu, Sydney, Melbourne, Perth
- **Africa:** Cairo, Lagos, Johannesburg, Nairobi

**Display format:** IANA value with underscores replaced by spaces, e.g.
"America/New York", "Asia/Hong Kong". Just `tz.replace(/_/g, " ")`.

**Sorting:** Both groups and items within groups are sorted by proximity to the
client's current timezone offset. The continent containing the user's timezone
appears first, and within each group, closest offsets sort to the top.

**Trigger label:** Same format, e.g. "America/New York".

### Persistence

- Every state change builds a new cron string and fires
  `PUT /api/workspaces/{workspaceId}/config/signals/{signalId}`
- Optimistic: UI state updates immediately
- On API failure: revert to previous state snapshot, show error toast
- Mode switches send full signal replacement (provider + config)

### Backend Change

Remove the provider type change restriction in
`packages/config/src/mutations/signals.ts` (the guard at lines 70-75 that
returns `invalid_operation` when provider changes). The PUT endpoint already
validates the full signal against `WorkspaceSignalConfigSchema`, so switching
between `"http"` and `"schedule"` with valid configs works without the guard.

## Testing Decisions

### Cron Adapter (`cron.ts`)

Unit tests for both directions — pure functions with clear inputs/outputs. Test
all interval types, edge cases (all days, midnight, noon), and round-trip
stability (`parseCron(buildCron(state))` === `state`).

### Backend Mutation

Update the existing test in `signals.test.ts` that asserts provider changes
fail — it should now assert they succeed.

### Component

No component tests needed for this iteration — behavior is best validated
manually through the UI. The cron adapter tests cover the logic.

## Out of Scope

- Monthly schedules
- Minute-level granularity (always minute 0)
- Creating/deleting signals (only editing existing ones)
- Validating cron expressions server-side beyond what Zod already does

## Further Notes

- The `Select` component in the codebase is single-select only. Day selection
  uses `DropdownMenu.Item` with `checked` props and `closeOnClick={false}`.
- The existing `parseCronSchedule` function in signal-details.svelte will be
  replaced by the new `parseCron` in `cron.ts`.

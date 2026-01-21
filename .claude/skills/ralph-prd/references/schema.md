# PRD.json Schema

Complete schema for Ralph PRD files.

## Top-Level Structure

```typescript
interface PRD {
  meta: Meta;
  scope: Scope;
  tasks: Task[];
  complete: boolean;
}
```

## Meta

```typescript
interface Meta {
  id: string; // "prd-2026-01-21-rate-limiting"
  title: string; // Human readable title
  designDoc: string; // Path to source design document
  created: string; // ISO 8601 timestamp
}
```

## Scope

```typescript
interface Scope {
  goal: string; // One sentence goal
  successCriteria: string[]; // All must be true for PRD complete
  outOfScope: string[]; // Explicitly excluded items
}
```

**successCriteria examples:**

- "Requests beyond limit return 429"
- "All tests pass"
- "Endpoint responds in <100ms"

**outOfScope examples:**

- "Rate limiting other endpoints"
- "Admin override capability"
- "Redis-backed distributed limiting"

## Task

```typescript
interface Task {
  id: string; // "task-1", "task-2", etc.
  description: string; // What to implement
  anchor: string; // Starting file path
  tier: "backend" | "api" | "frontend";
  tdd?: TDD; // Optional, omit if TDD doesn't fit
  verification: string[]; // Commands that must pass
  acceptanceCriteria: string[]; // Human-readable done criteria
  passes: boolean; // Agent sets true when complete
}
```

## TDD Phases

```typescript
interface TDD {
  red: string; // Specific failing test to write
  green: string; // Minimal implementation to pass
  refactor?: string; // Optional cleanup step
}
```

**red phase requirements:**

- Must be specific enough to write without exploration
- Include assertion details: "asserting X returns Y when given Z"
- Reference test file location if not obvious

**green phase requirements:**

- Describe minimal implementation approach
- Don't over-specify - agent figures out details

**refactor phase:**

- Optional
- Only include if specific cleanup is warranted

## Verification Commands by Tier

### Backend

```json
"verification": [
  "deno check",
  "deno lint",
  "deno task test src/path/to/file.test.ts"
]
```

### API

```json
"verification": [
  "deno check",
  "deno lint",
  "deno task test src/path/to/file.test.ts",
  "curl -s localhost:8080/endpoint | jq '.status'"
]
```

### Frontend

```json
"verification": [
  "deno check",
  "deno lint",
  "deno task test apps/web-client/src/path/to/file.test.ts",
  "agent-browser navigate http://localhost:1420/route",
  "agent-browser snapshot"
]
```

## Complete Example

```json
{
  "meta": {
    "id": "prd-2026-01-21-rate-limiting",
    "title": "Rate Limiting for Prompt Endpoint",
    "designDoc": "docs/plans/2026-01-21-rate-limiting-design.md",
    "created": "2026-01-21T10:30:00Z"
  },
  "scope": {
    "goal": "Prevent abuse by limiting prompt requests to 10/minute per user",
    "successCriteria": [
      "Requests beyond limit return 429 with Retry-After header",
      "Limit resets after 60 seconds",
      "Authenticated users tracked by ID, anonymous by IP",
      "All tests pass",
      "No type errors"
    ],
    "outOfScope": [
      "Rate limiting other endpoints",
      "Admin override capability",
      "Distributed rate limiting with Redis"
    ]
  },
  "tasks": [
    {
      "id": "task-1",
      "description": "Add rate limiting middleware with sliding window counter",
      "anchor": "src/services/middleware/rate-limit.ts",
      "tier": "backend",
      "tdd": {
        "red": "Write test asserting RateLimiter.check() returns { allowed: false, remaining: 0 } after 10 calls within 60s window",
        "green": "Implement sliding window counter using Map<string, number[]> with timestamp pruning",
        "refactor": "Extract window duration and limit as config parameters"
      },
      "verification": [
        "deno check",
        "deno lint",
        "deno task test src/services/middleware/rate-limit.test.ts"
      ],
      "acceptanceCriteria": [
        "RateLimiter.check(key) returns { allowed: boolean, remaining: number, resetAt: number }",
        "Window slides - old timestamps pruned on each check",
        "Thread-safe for concurrent requests"
      ],
      "passes": false
    },
    {
      "id": "task-2",
      "description": "Integrate rate limiter into prompt endpoint",
      "anchor": "apps/atlasd/routes/chat.ts",
      "tier": "api",
      "tdd": {
        "red": "Write test asserting 11th request within 60s returns 429 with Retry-After header",
        "green": "Add rate limiting middleware to prompt route, extract user ID or IP as key"
      },
      "verification": [
        "deno check",
        "deno lint",
        "deno task test apps/atlasd/routes/chat.test.ts",
        "curl -s -w '%{http_code}' localhost:8080/chat -d '{}'  | tail -1"
      ],
      "acceptanceCriteria": [
        "429 response includes Retry-After header with seconds until reset",
        "Authenticated requests use user ID as rate limit key",
        "Anonymous requests use IP address as rate limit key"
      ],
      "passes": false
    }
  ],
  "complete": false
}
```

## progress.txt Format

```
## 2026-01-21T10:45:00Z - task-1
Commit: a1b2c3d (feat: add rate limiting middleware with sliding window)

Decision: Used Map<string, number[]> instead of Redis. Simpler for single-instance daemon, can migrate later if needed.

---

## 2026-01-21T11:20:00Z - task-2
Commit: e4f5g6h (feat: integrate rate limiter into prompt endpoint)

Tuning: Agent initially tried per-route middleware registration. All Hono middleware in this codebase uses app-level registration in apps/atlasd/app.ts.

---
```

### progress.txt Fields

| Field    | When to include                                             |
| -------- | ----------------------------------------------------------- |
| Commit   | Always - SHA + conventional message                         |
| Decision | When a non-obvious choice was made                          |
| Blocker  | When something unexpected blocked progress                  |
| Tuning   | When agent behavior should be refined for future iterations |

Keep entries terse. Sacrifice grammar for concision.

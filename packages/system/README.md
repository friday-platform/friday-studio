# @atlas/system

System-level components for Friday: a built-in workspace (`system`) for
background and maintenance operations, plus the system agents that run inside
both system and user workspaces.

## System workspace

A single bundled workspace, `system`, ships with every Friday install. It is
registered automatically when the `WorkspaceManager` initializes — no
filesystem dependency, no runtime download.

### Layout

```
packages/system/workspaces/
├── system.yml   # the system workspace's WorkspaceConfig
└── mod.ts       # reads system.yml at module init and exports SYSTEM_WORKSPACES
```

### Definition (`system.yml`)

A standard workspace YAML, parsed through `WorkspaceConfigSchema`:

```yaml
version: '1.0'
workspace:
  name: System
  description: System workspace for background and maintenance operations for this Friday instance.
memory:
  own:
    - name: reflections
      type: long_term
      strategy: narrative
```

The workspace ID is the map key in `SYSTEM_WORKSPACES` (`"system"`), not a
field inside the YAML.

### Registration (`mod.ts`)

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import { parse } from "@std/yaml";

const systemYaml = readFileSync(
  fileURLToPath(new URL("./system.yml", import.meta.url)),
  "utf-8",
);

export const SYSTEM_WORKSPACES: Record<string, WorkspaceConfig> = {
  system: WorkspaceConfigSchema.parse(parse(systemYaml)),
} as const;

export type SystemWorkspaceId = keyof typeof SYSTEM_WORKSPACES;
```

The `WorkspaceManager` consumes `SYSTEM_WORKSPACES` and merges its entries
into the registry on init. Lookups go through `manager.find({ id: "system" })`
like any other workspace.

### Adding another system workspace

1. Add a new YAML next to `system.yml` (e.g. `monitoring.yml`).
2. In `mod.ts`, read it the same way as `systemYaml` and add an entry to
   `SYSTEM_WORKSPACES` keyed by the workspace ID you want to expose.
3. The new workspace is registered automatically on next daemon start.

## System agents

The `agents/` directory contains the agents shipped with Friday. Each
subdirectory is a self-contained agent (prompt, tools, helpers, tests):

- `workspace-chat/` — the chat-time agent users talk to. Authors and edits
  workspaces, agents, jobs, and skills.
- `judge-agent/` — runs the in-loop quality / validation checks used by the
  FSM engine when an LLM action requests external validation.
- `session-supervisor/` — orchestrates multi-step sessions, tracks delegation,
  and decides when a supervised run is finished.

Top-level helpers (`capabilities.ts`, `link-context.ts`, `mod.ts`) are shared
across agents — they expose capability discovery and supervisor / link runtime
context.

System agents work against any workspace, not just the `system` workspace —
that workspace is purely for background and maintenance signals, while the
agents themselves are invoked anywhere chat / FSM execution needs them.

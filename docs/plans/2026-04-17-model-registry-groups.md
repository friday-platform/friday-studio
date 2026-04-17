# Model Registry & Named Groups — Design Plan

**Date:** 2026-04-17
**Author:** lcf
**Source:** Transcript (LCF + Ronnie, 2026-04-17) + reading PR #2894 (merged on main)
**Status:** Draft — needs review before implementation starts

---

## Why this exists

Two pieces are already live:

- **PR #2894** landed a per-role model config in `friday.yml`
  (`labels` / `classifier` / `planner` / `conversational`) with per-role default
  chains, DI through `AgentContext` + `WorkspaceRuntime`, and load-time
  validation. The plumbing is done.
- The **Settings page** this branch just shipped (4.2/4.2b/4.2c) wires the
  existing endpoints into a UI: read `friday.yml` models, write them back,
  error-visualize bad provider IDs.

The transcript clarifies the *product* intent, and it diverges from the
current shape. What actually needs to happen:

1. **User-facing names, not Friday internals.** "labels / classifier /
   planner / conversational" are *our* archetypes. The user wants to think
   in terms of *use cases*: **fast**, **coding**, **deep thinking**,
   (later: image). Internal roles should alias to user-visible groups,
   not the other way round.

2. **One-default bootstrap.** "If you just apply a model, it sets the model
   for everything." A new operator with one Anthropic key must be able to
   paste it and have everything work. No 4-key config ritual.

3. **Named groups with primary + fallbacks.** Per group: one primary, any
   number of fallbacks. Auto-fallback walks the list when credentials miss
   (current default-chain logic already does this — just needs to be
   user-configurable, not hardcoded).

4. **Auto-surface the credential each model needs.** Picking a Groq model
   should visibly require `GROQ_API_KEY` next to the picker. Currently the
   user has to know "anthropic → ANTHROPIC_API_KEY" etc. out-of-band.

5. **Agents negotiate for a model, don't hardcode one.** An agent built on
   the Friday SDK says "I need a coding model" or "I accept `[anthropic:
   claude-sonnet-4-6, anthropic:claude-haiku-4-5]`"; the daemon resolves
   against its registry and hands back the model + credentials.

6. **Everything stays on Vercel AI SDK.** Don't reinvent the provider layer.
   Model strings stay `provider:model` as PR #2894 established.

---

## What we already have (from PR #2894)

| Piece | Where | Behavior |
|---|---|---|
| `PlatformModels.get(role)` | `packages/llm/src/platform-models.ts` | Pre-traced `LanguageModelV3` per archetype |
| `DEFAULT_PLATFORM_MODELS` | same file | Per-role fallback chain (internal, hardcoded) |
| `createPlatformModels(config)` | same file | Walks chain; throws `PlatformModelsConfigError` on bad input |
| `friday.yml` loader | `packages/config/src/filesystem-atlas-source.ts` | Parses + validates via `AtlasConfigSchema` |
| `AtlasConfigSchema.models` | `packages/config/src/atlas.ts` | `{ labels?, classifier?, planner?, conversational? }` |
| DI threading | `AgentContext.platformModels`, `WorkspaceRuntime.options.platformModels` | Constructed once at daemon boot |
| Credential check | `hasCredential(provider)` in platform-models.ts | `PROVIDER_ENV_VARS` table; `LITELLM_API_KEY` universal |
| Provider registry | `packages/llm/src/registry.ts` | `createProviderRegistry({ anthropic, openai, google, groq, 'claude-code' })` |
| Settings page endpoints | `apps/atlasd/routes/config.ts` (this branch) | `GET/PUT /api/config/env`, `GET/PUT /api/config/models` |
| Settings UI | `tools/agent-playground/src/routes/settings/+page.svelte` | Editable per-role + collapsible env vars |

**What PR #2894 doesn't do:**
- No concept of "default for everything"
- No user-defined groups
- Role names are Friday-internal; user has to know what
  "labels/classifier/planner/conversational" mean
- No UI hint about which env var a picked model needs

---

## Target `friday.yml` shape

```yaml
version: "1.0"
workspace:
  name: atlas-platform

models:
  # One-default bootstrap — used anywhere no more specific match is found.
  # Single `provider:model` string, same format PR #2894 established.
  default: anthropic:claude-sonnet-4-6

  # Named groups. Three are built-in (fast / coding / deep-thinking);
  # users can add their own. Each group has a primary + ordered fallbacks.
  groups:
    fast:
      primary: groq:openai/gpt-oss-120b
      fallbacks:
        - anthropic:claude-haiku-4-5
    coding:
      primary: anthropic:claude-sonnet-4-6
      # no fallbacks — falls back to `default` if creds missing
    deep-thinking:
      primary: anthropic:claude-opus-4-7
      fallbacks:
        - anthropic:claude-sonnet-4-6

  # Legacy per-archetype keys kept for PR #2894 compat. On load, each one
  # aliases to a group (rules below). Present in schema so friday.yml from
  # before this change keeps working.
  labels: ~           # aliases to `fast`
  classifier: ~       # aliases to `fast`
  planner: ~          # aliases to `coding`
  conversational: ~   # aliases to `coding`
```

**Resolution order** for any request:

1. If the caller asks for a specific role/group and `models.<role>` is set →
   use that string directly.
2. Else resolve via group alias → group's `primary`.
3. If primary lacks credentials → walk group's `fallbacks` in order.
4. If group is exhausted / undefined → fall back to `models.default`.
5. If `models.default` lacks credentials → throw at startup with the same
   `PlatformModelsConfigError` shape (aggregated per-role).

The existing `DEFAULT_PLATFORM_MODELS` constant becomes the **factory default**
for when the user has defined nothing — so zero-config "I just set
`ANTHROPIC_API_KEY`" still works.

---

## Phased rollout

Each phase is shippable on its own. They're ordered so the user-visible
win lands in phase 1 and phases 2-5 are additive.

### Phase 1 — `models.default` (~half day) 🎯 ship first

Adds the "paste one key, everything works" experience on top of PR #2894's
wiring without changing the role model.

**Code changes:**

1. `packages/config/src/atlas.ts` — `PlatformModelsSchema` gains optional
   `default: ModelIdSchema.optional()`.
2. `packages/llm/src/platform-models.ts` — `resolveRole` falls back through
   `userConfig.default` → built-in chain → error.
3. `apps/atlasd/routes/config.ts` — `GET /api/config/models` returns
   `{ default: string | null, roles: [...] }`; `PUT` accepts a `default` key.
4. Settings UI — primary "Default model" field at top of the Models section;
   per-role fields render under an "Advanced: per-role overrides"
   `<details>`, collapsed by default.

**QA:** empty `friday.yml` + `ANTHROPIC_API_KEY` → zero-config still works.
Set `models.default: anthropic:claude-haiku-4-5` only → all four resolved
roles show Haiku. Override one role → that role diverges; others still
follow default.

---

### Phase 2 — Named groups (~1 day)

Introduces `models.groups`. Roles alias to groups. Users can add/remove
groups.

**Schema:**

```ts
const ModelGroupSchema = z.object({
  primary: ModelIdSchema,
  fallbacks: z.array(ModelIdSchema).optional(),
});
const PlatformModelsSchema = z.object({
  default: ModelIdSchema.optional(),
  groups: z.record(z.string(), ModelGroupSchema).optional(),
  labels: ModelIdSchema.optional(),       // back-compat
  classifier: ModelIdSchema.optional(),   // back-compat
  planner: ModelIdSchema.optional(),      // back-compat
  conversational: ModelIdSchema.optional(),
});
```

**Built-in aliases** (code, not config):
- `labels → fast`
- `classifier → fast`
- `planner → coding`
- `conversational → coding`

Aliases are overridable: if `models.classifier` is set explicitly, it wins
over the group mapping.

**API additions:**
- `PlatformModels.getByGroup(name)` — resolves group → primary → fallbacks → default.
- `PlatformModels.listGroups()` — `{ name, primary, fallbacks, resolved }[]`
  for the settings page.
- `PUT /api/config/models` accepts the new `default` + `groups` fields.

**UI:** Settings adds a **Groups** sub-section between "Default" and
"Advanced". Per group: name (read-only for built-ins, editable for custom),
primary input, fallback list with add/remove. "Currently active" subline
like today.

---

### Phase 3 — Credential surfacing (~half day)

Every model picker shows *right next to it* which env var is required and
whether it's set. No more "why isn't my Groq model working" mystery.

**Code changes:**
1. `PROVIDER_ENV_VARS` is already a table in `packages/llm/src/util.ts`.
   Export it through `@atlas/llm/mod.ts`.
2. `GET /api/config/models` includes `{ required_env: [{ var: "GROQ_API_KEY", present: true }] }`
   per entry, derived by parsing `provider:model` → looking up provider →
   checking if env var is set.
3. Settings UI: badge next to each model input —
   "🔑 GROQ_API_KEY missing" (red) / "✓ GROQ_API_KEY set" (green). Click-through
   scrolls to the env vars section with the right key focused.

---

### Phase 4 — Agent SDK model negotiation (~1-2 days)

Today's `AgentContext.platformModels.get("classifier")` is a hardcoded
string. The transcript wants agents to *declare* what they need:

```ts
// In an agent definition
createAgent({
  id: "my-agent",
  models: {
    // Either: ask for a built-in group
    group: "coding",
    // Or: accept any of these specific models (first credentialed wins)
    accepts: ["anthropic:claude-sonnet-4-6", "anthropic:claude-haiku-4-5"],
  },
  ...
});
```

**Resolution order:** explicit `accepts[]` → `group` → default.

**Code changes:**
1. `AgentMetadata` in `@atlas/agent-sdk` gets a `models?: AgentModelRequest`
   field.
2. `PlatformModels.resolve({ accepts?, group? })` — new method that unifies
   both paths.
3. Bundled agents (workspace-chat, web, etc.) migrate from
   `registry.languageModel("anthropic:claude-sonnet-4-6")` to
   `ctx.platformModels.resolve({ group: "coding" })`.
4. Backwards-compat: existing `ctx.platformModels.get("classifier")` calls
   keep working via alias table.

This is the phase that makes built-in agents respect operator config. Right
now a lot of hardcoded `registry.languageModel("anthropic:claude-sonnet-4-6")`
calls (I counted ~20 in the repo) bypass `PlatformModels` entirely —
that's why "you can't control the model" for bundled agents.

---

### Phase 5 — One-key onboarding card (~2 hours)

Top of Settings page: a "Get started" card that's visible while
`models.default` isn't set. One field ("Anthropic API key"), one button
("Use Claude for everything"). On save: writes `ANTHROPIC_API_KEY` to `.env`
and `models.default: anthropic:claude-sonnet-4-6` to `friday.yml`.

Dismissable + disappears once `default` is set.

---

### Phase 6 — Hot reload (~1-2 days, separate design call)

Unblocks changes-take-effect-immediately. Options to explore:

- **`POST /api/config/reload`** — daemon re-reads friday.yml, constructs a
  new `PlatformModels`, swaps it into the context map. Old in-flight
  sessions keep their old reference; new ones get the new one.
- **SIGHUP** — classic unix-style trigger; same swap.
- **File watcher** — friday.yml mtime change triggers the above.

Atomic swap is the hard part. `PlatformModels` is threaded into
`AgentContext` + `WorkspaceRuntime.options` at construction time. Need to
audit which of those hold live references vs. lazy getters. Likely a small
refactor to replace `platformModels: PlatformModels` with
`getPlatformModels: () => PlatformModels` in a few call sites.

---

## Data migration

`friday.yml` files from before this change:

```yaml
models:
  labels: groq:openai/gpt-oss-120b
  classifier: anthropic:claude-haiku-4-5
  planner: anthropic:claude-sonnet-4-6
  conversational: anthropic:claude-sonnet-4-6
```

…keep working. Schema stays backwards-compatible. `models.default` and
`models.groups` are both optional; `labels`/`classifier`/`planner`/
`conversational` are kept as optional escape hatches.

On the UI side, show a one-time "Migrate to groups" CTA when the page
detects per-role-only config — one click writes the equivalent groups
definition and deletes the per-role keys.

---

## Known hard parts

1. **Hardcoded `registry.languageModel("anthropic:claude-...")` sites.**
   About 20 across bundled agents + workspace agents. Phase 4 has to touch
   each of them. Risk: missing one means "you can't control that model"
   stays true for that agent even after the settings land.

2. **Fallback walking across groups.** If `coding` primary fails creds,
   should we walk `coding.fallbacks[]`, then `default`, then throw? Or
   throw if `coding.fallbacks[]` exhausts? Proposal: walk within the group,
   then *once* fall back to `default`. Don't cascade across unrelated
   groups.

3. **UI for custom-named groups.** Built-in group names (`fast`, `coding`,
   `deep-thinking`) have semantics the UI can explain. User-named groups
   are opaque labels. Render them, but flag that Friday's internal aliases
   only map to the built-ins — so a custom group is only reachable via an
   agent's explicit request.

4. **Hot reload vs. concurrent sessions.** A session that started on old
   config shouldn't mid-flight switch to a new resolver. Phase 6 design
   call has to address this.

---

## Open questions

- **Image models** — the transcript mentioned "later" but doesn't block v1.
  `models.groups.image` falls out of the schema for free if we want it.
- **Per-workspace override** — a workspace could want different groups from
  the daemon-wide config. Not in v1, but the groups schema could be lifted
  into `workspace.yml` later without breaking anything.
- **Credential hints for non-env-var providers** — `claude-code` is
  credentialed via CLI, not env var. UI should say "✓ Claude CLI available"
  instead of asking for a key.
- **Pricing implications of model choice** — transcript doesn't ask for
  this, but `getByGroup("fast")` implicitly means "cheap." Worth surfacing
  a rough $/token next to each pick? Small UX polish, not a gate.

---

## Definition of done for v1

- [ ] Phase 1 ships: `models.default` works, UI is primary/advanced split
- [ ] Phase 2 ships: `models.groups` + built-in aliases
- [ ] Phase 3 ships: credential badges in UI
- [ ] Phase 4 ships: at least the workspace-chat + web agents migrated to
      `resolve({ group })`; rest tracked as follow-up
- [ ] Phase 5 ships: onboarding card

**Phase 6 (hot reload) is explicitly *not* gating v1.** Everyone tolerates
a restart today and the transcript treats reload as "we can think" — so
ship without it and iterate.

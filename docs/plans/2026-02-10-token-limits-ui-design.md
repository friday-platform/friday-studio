# TEM-3390: Token Limits UI

## Problem Statement

Users have no visibility into their LLM budget consumption. They don't know how
much of their monthly limit they've used until they hit the wall. We need
passive, progressive warnings that surface usage before it becomes a problem.

## Solution

Show usage warnings in two places at two thresholds:

- **Sidebar** (≥50% used): Persistent card with progress bar, remaining
  percentage, and upgrade CTA
- **Chat input** (≥75% used): Inline red warning next to "Add files" so it's
  visible right where they're about to spend more tokens

## User Stories

1. As a user who has consumed 50% of my monthly budget, I want to see a usage
   indicator in the sidebar, so that I'm aware I'm halfway through my limit
2. As a user who has consumed 75% of my monthly budget, I want to see a warning
   in the chat input area, so that I'm reminded before sending another message
3. As a user approaching my limit, I want to see how much budget I have
   remaining as a percentage, so that I can gauge how much runway I have left
4. As a user approaching my limit, I want a clear path to upgrade, so that I can
   take action without searching for contact info
5. As a user under 50% usage, I want no usage indicators cluttering the UI, so
   that the interface stays clean when there's nothing to worry about
6. As a user between 50-74% usage, I want to see the sidebar warning only, so
   that I'm informed without being nagged in my primary interaction area
7. As a user at or above 75% usage, I want to see warnings in both the sidebar
   and chat input, so that the urgency is proportional to my consumption

## Implementation Decisions

### App Context Abstraction

Add a `$derived` `usage` property to the existing `AppContext` class in
`app-context.svelte.ts`. This centralizes all threshold logic so components
just read boolean flags:

```
usage = $derived.by(() => {
  const raw = this.user?.usage ?? 0;
  return {
    fraction: raw,                          // 0-1 from API
    percent: Math.round(raw * 100),         // e.g. 75
    remaining: Math.round((1 - raw) * 100), // e.g. 25
    showSidebarWarning: raw >= 0.5,
    showInputWarning: raw >= 0.75,
  };
});
```

The `usage` field on `UserIdentity` is already available — it's `spend /
max_budget` (0-1 range) returned by `/api/me` via the Persona service querying
LiteLLM.

### Sidebar Warning (≥50%)

- Location: bottom of the `<nav>` element, above the `?` help button
- Conditionally rendered with `{#if ctx.usage.showSidebarWarning}`
- Components:
  - Progress bar (CSS custom property `--usage` drives fill width)
  - Bold heading: "{remaining}% left"
  - Muted description: "You've used {percent}% of your monthly limit."
  - Underlined link: "Contact us to Upgrade." → `mailto:hello@hellofriday.ai`

### Chat Input Warning (≥75%)

- Location: inside the `.commands` div in `message-form.svelte`, between "Add
  files" and the submit button
- Conditionally rendered with `{#if ctx.usage.showInputWarning}`
- Components:
  - Red `InfoCircled` icon + red text: "{percent}% of limit used"
- Naturally positioned by the existing `justify-content: space-between` flex
  layout

### Files Modified

- `apps/web-client/src/lib/app-context.svelte.ts` — add `usage` derived property
- `apps/web-client/src/lib/components/app/sidebar.svelte` — add usage card
- `apps/web-client/src/lib/modules/conversation/message-form.svelte` — add
  inline warning

### What's Out of Scope

- Behavior at 100% usage (blocking sends, disabling input) — separate ticket
- Polling/refreshing usage during a session — uses the value from initial
  `/api/me` load
- Backend changes — the `usage` field already exists on `UserIdentity`

## Out of Scope

- Blocking or disabling chat at 100% usage
- Real-time usage updates during a session (e.g. via polling or SSE)
- Customizable thresholds
- Admin-facing usage dashboards
- Backend/API changes

## Further Notes

The `usage` value from `/api/me` is a snapshot from session start. If a user
burns through their remaining budget within a single session, the UI won't
update until the next page load. This is acceptable for now — real-time tracking
is a separate concern.

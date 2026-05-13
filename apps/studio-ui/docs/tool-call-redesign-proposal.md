# Tool Call UI Redesign Proposal

## Problem

The current tool-call cards in `chat-message-list.svelte` are flat, cramped, and generic. Three specific pain points:

1. **It's hard to tell what a tool is actually doing.** The arg preview (`blizzard.com`, `exit 0 · 120ms`, etc.) is squeezed into a single horizontal row alongside the tool name and status. The most important information — the *action* — competes for space.
2. **No visual identity per tool type.** `web_fetch`, `run_code`, `delegate`, and `read_file` all look identical. There's no scannable color or icon signal.
3. **Doesn't use the `@atlas/ui` token system.** Cards use ad-hoc `light-dark(hsl(...), ...)` values instead of `--text-bright`, `--text-faded`, `--blue-primary`, `--yellow-primary`, `--surface-bright`, etc. They feel pasted-in rather than native.

## Proposal Summary

Extract tool-call rendering into a new `tool-call-card.svelte` component. Restructure each card as a **vertical two-row block** with a **color-coded left accent border** and **category icon**. Prioritize the *action description* (arg preview) over the *tool name*. Replace text-only status with a **small color-coded status badge**.

The JSON input/output drawers stay mostly as-is (your feedback: "input/output as json is totally fine").

---

## Before / After

### Before (current)
```
[ spinner ] web_fetch   blizzard.com      running… (3.2s)
```
Horizontal, everything jammed into one line. Tool name gets equal weight as the URL.

### After (proposed)
```
┌─────────────────────────────────────────────────────┐
│ 🌐  Fetching blizzard.com              ● Running 3s │
│        web_fetch                                      │
└─────────────────────────────────────────────────────┘
         ▼ input  ▼ output
```
- Icon + action first, large and readable.
- Tool name small and muted below.
- Status is a right-aligned pill/badge, color-coded.
- Left border tinted blue for web tools.

---

## Component Design

### Card Layout

```
┌────────────────────────────────────────┐
│▓▓  {icon}  {action preview}    {badge} │  ← accent border left
│           {toolName}  ·  {argExtra}   │
└────────────────────────────────────────┘
   ▼ input      ▼ output      ▼ error
```

- **Row 1**: `icon` (20×20) + **action preview** (large, `font-size-2`, `--text-bright`) + **status badge** (right-aligned, pill shape).
- **Row 2**: `toolName` (small, `font-size-1`, `--text-faded`, mono) + optional extra info (duration, byte count).
- **Left border**: 3px solid, color = tool category.

### Tool Category Accents

| Tool | Icon (Heroicons) | Left Border | Status Badge Base |
|---|---|---|---|
| `web_fetch` | `globe-alt` (solid, 20px) | `--blue-primary` | blue |
| `web_search` | `magnifying-glass` (solid) | `--blue-primary` | blue |
| `run_code` | `code-bracket-square` (solid) | `--green-primary` | green |
| `read_file` | `document-text` (solid) | `--yellow-primary` | yellow |
| `write_file` | `document-arrow-up` (solid) | `--yellow-primary` | yellow |
| `list_files` | `folder-open` (solid) | `--yellow-primary` | yellow |
| `delegate` | `users` or `rocket-launch` (solid) | `--color-accent` | purple |
| `load_skill` | `bolt` (solid) | `--yellow-primary` | yellow |
| `memory_save` | `bookmark-square` (solid) | `--color-accent` | purple |
| `connect_service` | `link` (solid) | `--text-faded` | neutral |
| Generic / unknown | `wrench` (solid, from `@atlas/ui`) | `--color-border-1` | neutral |

### Status Badges

| State | Badge | Example |
|---|---|---|
| `input-streaming` / `input-available` | **Pulsing blue dot** + elapsed time | `● 3.2s` |
| `output-available` | **Green check** + duration | `✓ 1.2s` |
| `output-error` | **Red X** + short error | `✗ Connection timeout` |
| `output-denied` | **Yellow slash** | `Denied` |
| `approval-requested` | **Yellow clock** | `Needs approval` |

### Delegate / Nested Cards

Delegates feel like a **sub-session**, not just a nested `<details>`.

- Distinct background: `--surface-dark` tint.
- Left indent with a **subtle vertical line** (`--color-border-1`) instead of the heavy 2px block.
- Header row gets a **"sub-agent"** label pill (small, `--color-accent` tinted).
- Reasoning and progress blocks are styled as a **thought-feed** (chronological, muted, monospace) rather than a raw `<pre>`.

### Group Collapse (≥3 tools)

When a message has 3+ tools, the current single-line summary stays, but styled as a **compact header bar** with a running-count badge and a single pulsing dot when active.

### Hover / Active States

- Card hover: `translateY(-1px)` + `--shadow-1` (subtle lift).
- Details `<summary>` hover: text brightens, cursor pointer.
- Copy button: unchanged (it already works well).

### Colors — Strict Token Mapping

Remove all raw `light-dark(hsl(...), ...)` from tool-card CSS. Map to `@atlas/ui` tokens:

| Current | Replace With |
|---|---|
| `light-dark(hsl(220 16% 95%), ...)` | `--surface-dark` |
| `light-dark(hsl(217 80% 95%), ...)` | `--surface` with a `--blue-primary` tint overlay |
| `light-dark(hsl(10 80% 95%), ...)` | `--surface` with a `--red-primary` tint overlay |
| `light-dark(hsl(220 10% 40%), ...)` | `--text-faded` |
| `light-dark(hsl(220 10% 45%), ...)` | `--text-faded` |
| `light-dark(hsl(217 60% 80%), ...)` | `--color-info` |

For tinted surfaces (in-progress / error states), use `background-color: color-mix(in srgb, <token>, transparent 92%)` rather than custom HSL.

---

## Required New Icons (Heroicons — solid, 20×20 viewBox)

Please add these to `packages/ui/src/lib/icons/` (or wherever you stash new ones). I need:

1. `globe-alt` — for web_fetch
2. `magnifying-glass` — for web_search
3. `code-bracket-square` — for run_code
4. `document-text` — for read_file
5. `document-arrow-up` — for write_file
6. `folder-open` — for list_files
7. `users` (or `rocket-launch` if you prefer) — for delegate
8. `bolt` — for load_skill
9. `bookmark-square` — for memory_save
10. `link` — for connect_service
11. `check-circle` (solid, 16px) — success badge
12. `x-circle` (solid, 16px) — error badge
13. `clock` (solid, 16px) — approval/waiting badge
14. `chevron-right` / `chevron-down` (solid, 16px) — expand/collapse chevrons for delegate and group drawers (only if we want to replace the current `▸` text caret)

If some of these already exist in `@atlas/ui` (I saw `IconSmall.Check` and `Icons.TriangleRight`), just point me at them and I'll use those.

---

## Implementation Plan

1. **Wait for icons** — you paste in the SVGs, I wire them up.
2. **Create `tool-call-card.svelte`** — extract all tool rendering from `chat-message-list.svelte` into this component. Keep `chat-message-list.svelte` as the list + message orchestration layer only.
3. **Restyle the group summary** — compact bar with count badge.
4. **Delegate nesting restyle** — thinner indent, tinted background, thought-feed layout for reasoning.
5. **Type-check & test** — verify with an actual chat that produces tools.

---

## Open Questions

- **Delegate icon**: `users` (team/people feel) or `rocket-launch` (agent/action feel)?
- **Tool category mapping**: Do you want the color accents on the left border *only*, or also a tiny background tint across the whole card? I propose left border only — subtle but scannable.
- **Run code output preview**: Right now `run_code` shows `exit 0 · 120ms`. Should we also show the language (e.g., `python · exit 0 · 120ms`) in row 2?
- **Progress lines during streaming**: Currently they're just monospace text lines. Should they get a tiny left dot (like a commit history) to feel like a timeline?

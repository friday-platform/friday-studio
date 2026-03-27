## Problem Statement

The skill detail page has UX issues that prevent it from being v1-complete:
the title/name distinction is confusing, the instructions editor doesn't let
users see raw markdown, description textarea sizing is buggy, deletion has no
confirmation, and browser-back discards unsaved changes.

## Solution

Restructure the skill detail page to use `name` (kebab-case slug) as the sole
identifier, consolidate all editing into the main column, replace the
ProseMirror WYSIWYG with a raw-markdown/preview tab pair, add a deletion
confirmation dialog, and fix the save-on-navigate bug.

## User Stories

1. As a skill author, I want the skill's kebab-case name to be the primary
   identifier, so that there is no confusion between title and name
2. As a skill author, I want to edit the name inline at the top of the page, so
   that I can set it without hunting in a sidebar
3. As a skill author, I want the name input to enforce kebab-case, so that I
   can't accidentally create invalid identifiers
4. As a skill author, I want to see labeled "Description" and "Instructions"
   sections in the main column, so the page is self-documenting
5. As a skill author, I want to write instructions in raw markdown, so I have
   full control over formatting
6. As a skill author, I want to preview rendered markdown in a separate tab, so
   I can verify the output before saving
7. As a skill author, I want the description textarea to resize correctly as I
   type, without layout glitches
8. As a skill author, I want a confirmation dialog when I delete a skill, so I
   don't accidentally destroy work
9. As a skill author, I want my changes saved when I click the browser back
   button, so I don't lose work

## Implementation Decisions

### Layout restructure

Remove the sidebar. The main column becomes the sole editing surface:

1. **Name** (top, where title was) — editable input, kebab-case enforced,
   labeled
2. **Description** (below name) — auto-sizing textarea, labeled, keeps existing
   auto-generation logic
3. **Instructions** (below description) — tabbed editor (Edit / Preview),
   labeled
4. **Actions dropdown** — moves to the top-right of the main column

### Title removal

- Drop the `title` field from the draft state entirely
- The `name` field (kebab-case slug) replaces it as the primary identifier
- The `Page.Title` component is replaced with a labeled kebab-case input
- The `publishSkill` call stops sending `title`
- On the list page, display `name` where `title` was shown

### Name input behavior

- Input enforces kebab-case on every keystroke (strip invalid chars, lowercase,
  collapse hyphens)
- Placeholder: `skill-name`

### URL changes

- Route moves from `/skills/[skillId]/[[namespace]]/[[name]]` to
  `/skills/[skillId]/[[name]]`
- Remove the `[[namespace]]` param directory from the route tree
- Update `app-context.svelte.ts` route helper to drop namespace arg
- Namespace is always hardcoded to `"friday"` when calling `publishSkill`
- The URL name is set on first creation; subsequent name edits don't update the
  URL (avoids jarring navigation during editing)

### Instructions editor — Edit/Preview tabs

- Replace the ProseMirror `MarkdownEditor` with a tab pair
- **Edit tab**: plain `<textarea>` for raw markdown input (monospace font)
- **Preview tab**: read-only rendered markdown using the `MarkdownContent`
  component (`$lib/components/primitives/markdown-content.svelte`), which
  renders markdown to HTML via `@lezer/markdown`. This is the same component
  used for message responses and artifact display throughout the app.
- Use melt-ui tabs inline for the Edit/Preview switcher
- Default to the Edit tab

### Description textarea fix

- The current mirror-based auto-sizing does not work at all
- Replace the broken manual implementation with the `Textarea` component from
  `$lib/components/textarea.svelte`, which is the same component used in the
  message form. It uses a hidden `<p>` mirror element with matching styles,
  measures via `getBoundingClientRect()`, and reactively updates height on
  every value change. This handles both growth and shrink correctly.
- **XSS prevention**: the current broken implementation uses
  `descriptionMirror.innerHTML = ...` which is an XSS vector if user input
  contains HTML/script tags. The `Textarea` component avoids this — its mirror
  element uses Svelte text binding (`{value}`) which auto-escapes content,
  never `innerHTML`. Do not use `innerHTML` with user-provided content anywhere
  in this page.
- **Instructions preview XSS**: `MarkdownContent` renders via `{@html}`. The
  codebase already uses DOMPurify to sanitize rendered markdown elsewhere —
  follow the same pattern for the instructions preview to prevent raw
  HTML/script injection.

### Deletion confirmation dialog

- Keep the existing `DropdownMenu` pattern for the actions menu
- When the user clicks "Remove", always show a `Dialog` with:
  - **Title**: "Remove skill?"
  - **Description**: "This skill will be permanently removed. Any agents
    using this skill will no longer have access to it."
  - **Confirm button**: "Remove Skill"
  - **Cancel button**: "Cancel"
- On confirm, proceed with deletion
- Use the existing `Dialog` component (`Dialog.Root`, `Dialog.Content`,
  `Dialog.Header`, `Dialog.Footer`, `Dialog.Button`, `Dialog.Cancel`)

### Save-on-navigate bug fix

- The current `beforeNavigate` fires `save()` but the mutation is async —
  the page can unload before the request completes
- Fix: cancel the navigation in `beforeNavigate`, trigger save, then navigate
  programmatically in the mutation's `onSuccess` callback
- **Loop guard**: the programmatic `goto()` in `onSuccess` will re-trigger
  `beforeNavigate`. Skip the cancel/save when `navigation.type === "goto"`
  (programmatic navigation) to avoid an infinite loop. The chat-provider
  already uses this pattern.
- Also add a `beforeunload` handler as a safety net for hard browser navigation
  (tab close, URL bar navigation) — this shows the browser's native "unsaved
  changes" dialog when dirty

## Testing Decisions

- Test external behavior through the component's public interface, not internal
  state
- **Name input**: verify kebab-case enforcement (strips uppercase, spaces,
  special chars)
- **Tab switching**: verify Edit/Preview tabs toggle visibility of the correct
  content
- **Deletion dialog**: verify dialog always appears when Remove is clicked
- **Save-on-navigate**: verify `beforeNavigate` cancels navigation and triggers
  save when dirty; verify `goto` navigations are not cancelled (loop guard)
- Prior art: look for existing component tests in the web-client for patterns
  (e.g., testing with `@testing-library/svelte` or Vitest)

## Out of Scope

- Namespace selection UI (always "friday")
- Skill archive/file uploads (behind feature flags)
- Skill references (behind feature flags)
- Reusable tab component extraction (build inline first)
- Server-side changes to the publish API
- Skill list page redesign (beyond showing `name` instead of `title`)

## Further Notes

- The `publishSkill` API already accepts `title` as optional — dropping it from
  the client payload should be backward-compatible
- The `toSlug` utility already exists for kebab-case conversion and can be
  reused for the name input enforcement

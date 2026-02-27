# ProseMirror Markdown Editor for Skill Detail Page

## Context

The skill detail page (`/skills/[skillId]`) needs an editor for skill content. Skills store content as markdown strings. The reference ProseMirror editor at `~/Documents/prosemirror/editor` provides patterns to adapt from, minus its mention plugin and with markdown roundtripping added.

## New Dependencies

Install in `apps/web-client/package.json`:

- `prosemirror-state`, `prosemirror-view`, `prosemirror-model` — core
- `prosemirror-schema-basic`, `prosemirror-schema-list` — node/mark specs
- `prosemirror-example-setup` — input rules + keymap builders (schema-aware)
- `prosemirror-markdown` — markdown <-> ProseMirror doc (brings `markdown-it`)
- `prosemirror-commands`, `prosemirror-keymap` — commands and keymap plugin
- `prosemirror-history` — undo/redo
- `prosemirror-inputrules` — input rule system
- `prosemirror-dropcursor`, `prosemirror-gapcursor` — cursor helpers

## New Files

All under `apps/web-client/src/lib/components/markdown-editor/`:

### 1. `schema.ts` — ProseMirror schema

Cherry-pick from `prosemirror-schema-basic` and `prosemirror-schema-list`:

**Nodes:** `doc`, `paragraph`, `heading` (1-3), `text`, `hard_break`, `blockquote`, `code_block`, `bullet_list`, `ordered_list`, `list_item`, `table`, `table_row`, `table_header`, `table_cell`

**Marks:** `strong`, `em`, `code`

**Excluded:** horizontal_rule, image, link

Table nodes are minimal read-only specs (`parseDOM`/`toDOM` only, `isolating: true` on cells). Use `addListNodes()` from `prosemirror-schema-list` for list node wiring.

### 2. `markdown.ts` — markdown <-> ProseMirror

Uses `prosemirror-markdown`'s `MarkdownParser` and `MarkdownSerializer` with `markdown-it`.

**Parser:** Configure `markdown-it` with default preset (has GFM tables). Map tokens: `paragraph`, `heading`, `blockquote`, `code_block`, `fence`, `ordered_list`, `bullet_list`, `list_item`, `table`, `tr`, `th`, `td`, `em`, `strong`, `code_inline`, `hardbreak`. Set `ignore: true` for unsupported tokens (image, link, hr, etc.).

**Serializer:** Standard node serializers for paragraph, heading, blockquote, code_block, lists. Custom table serializer that outputs GFM pipe-table syntax (`| cell | cell |` with `| --- | --- |` separator after header row). Mark serializers: `**` for strong, `*` for em, `` ` `` for code.

Exports: `parseMarkdown(md: string): Node` and `serializeMarkdown(doc: Node): string`

### 3. `plugins.ts` — plugin assembly

```
buildInputRules(schema)     — # through ### heading, > blockquote, ``` code block, - bullet, 1. ordered, smart quotes
buildKeymap(schema)         — Mod-b, Mod-i, Mod-`, Shift-Ctrl-1..3, blockquote, code block, list indent/dedent
baseKeymap                  — standard editing commands
history()                   — undo/redo
dropCursor()                — drag indicator
gapCursor()                 — cursor in gaps
```

Uses `buildInputRules` and `buildKeymap` from `prosemirror-example-setup` individually (NOT `exampleSetup()`) to avoid the menu bar and CSS class plugins. These are schema-aware — they only add bindings for nodes/marks that exist in our schema. No floating toolbar — formatting is hotkey-only.

### 4. `editor.svelte` — Svelte component

```svelte
<MarkdownEditor value={content} onchange={handleChange} disabled={false} />
```

- Mounts ProseMirror via Svelte 5 `{@attach}` directive — action returns cleanup function that calls `view.destroy()`
- `value: string` — markdown input
- `onchange: (md: string) => void` — callback on doc change (serialized to markdown)
- `disabled: boolean` — read-only mode
- External value sync: compares serialized doc against new `value` prop, replaces state if different. `internalUpdate` flag prevents circular updates.
- Typography styles match `markdown-content.svelte` (same font sizes, weights, spacing) using `:global()` selectors scoped under `.markdown-editor`
- Table styles: collapsed borders, `--color-surface-2` borders, header bold

### 5. `index.ts` — barrel export

## Integration

Modify `apps/web-client/src/routes/(app)/skills/[skillId]/+page.svelte`:
- Import `MarkdownEditor` from `$lib/components/markdown-editor`
- Add `let content = $state(skill.content)` for local state
- Place `<MarkdownEditor value={content} onchange={...} />` in the main article column below the header
- Add sample markdown to mock data in `+page.ts` for development

## Key Design Decisions

1. **Callback not bindable** — ProseMirror manages its own state; two-way binding would fight it
2. **Individual plugin builders** — More control than `exampleSetup()`, avoids unwanted menu bar
3. **Tables read-only** — Nodes exist for parsing/rendering but no table editing commands are installed; cursor can enter cells for copy but not restructure
4. **CSS matches existing markdown-content.svelte** — Editor content looks the same as read-only rendered markdown

## What to Adapt from Reference Editor

- Schema construction with `addListNodes()`
- Plugin ordering pattern

## What NOT to Take

- Mention plugin, `MENTION_ITEMS`, mention mark, mention CSS
- `FloatingMenuView` / floating toolbar
- `bind:this` + `$effect` mounting (use `{@attach}` instead)
- DOM parser initialization (use `prosemirror-markdown` instead)
- Hardcoded CSS values (use design tokens)

## Testing

**Unit tests** (`markdown.test.ts`): Parser/serializer roundtripping for each node type — headings, paragraphs with bold/italic/code, blockquotes, code blocks, bullet lists, ordered lists, nested lists, GFM tables, mixed content. Verify unsupported elements are ignored.

**Manual verification**: Type `# ` through `### ` for headings, `> ` for blockquote, ``` for code block, `- ` for bullet, `1. ` for ordered list, Mod-b/Mod-i/Mod-` for inline formatting, Tab/Shift-Tab for list indent/dedent, Mod-z for undo, paste markdown with a table.

## Implementation Order

1. Install dependencies
2. `schema.ts`
3. `markdown.ts` + `markdown.test.ts`
4. `plugins.ts`
5. `editor.svelte` + `index.ts`
6. Integrate into skill detail page
7. CSS refinement against `markdown-content.svelte`

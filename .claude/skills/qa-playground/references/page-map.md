# Playground Page Map

Complete inventory of pages, routes, and testable elements.

---

## 1. Root Redirect

**URL:** `/`
**Expected:** Redirects to `/platform/{firstWorkspaceId}`

### Verify

- [ ] Navigation to `/` redirects to `/platform/...`
- [ ] Check `window.location.pathname` starts with `/platform/`

---

## 2. Workspace Overview

**URL:** `/platform/{id}`
**Expected:** Dashboard grid with summary cards

### Elements

- Two-row grid layout
- **Recent Runs** — SessionProgressCard with pipeline step badges
- **Jobs** card — job titles with Run buttons + overflow menus (···)
- **Integrations** — provider status (green dots, "env var" labels)
- **Signals** card — signal names with HTTP/SCHEDULE type badges, trigger URLs
- **Agents** card — agent names with type badges (GH, CLAUDE-CODE), status
- "Edit configuration" and "Export" links in top-right

### Verify

- [ ] Dashboard grid renders with all card sections
- [ ] Recent Runs card shows sessions with status badges (Complete/Failed)
- [ ] Jobs card shows job titles with Run buttons
- [ ] Signals card shows signal names with type badges (HTTP)
- [ ] Agents card shows agent names with connection status
- [ ] Sidebar: logo, "Friday" title, green health dot, workspace list, tool links

### Sidebar (tested once here, applies to all pages)

- [ ] Logo + "Friday" text renders
- [ ] Daemon health indicator shows status dot
- [ ] Tool links present: Agent Tester, Inspector, Skills
- [ ] Workspace list with color dots and titles
- [ ] Active workspace highlighted

---

## 3. Agents Page

**URL:** `/platform/{id}/agents`
**Expected:** Agent cards with full details

### Elements

- Breadcrumb: ← workspace name
- Right sidebar: "Agent types" info, agent list with type badges
- Agent cards: type badge (BUILT-IN · GH / BUILT-IN · CLAUDE-CODE), Edit button
- Each card: description, Prompt section, Output Schema table, Environment vars
- "Used in jobs" section with links to pipeline steps

### Verify

- [ ] Breadcrumb renders with back arrow to workspace
- [ ] Agent cards render with names and type badges
- [ ] Output Schema table shows properties with types
- [ ] Environment section shows required keys with status dots
- [ ] "Used in jobs" links are present and clickable
- [ ] No JS errors (especially no "Deno is not defined")
- [ ] Right sidebar shows agent list with BUILT-IN badges

---

## 4. Skills Page (Workspace)

**URL:** `/platform/{id}/skills`
**Expected:** Skill bindings list

### Elements

- Breadcrumb: ← workspace name
- Bound skills list with CATALOG badges
- Right sidebar: "Skills" info section, "Add skill" button
- Each skill: name (namespace/name), description, overflow menu (···)

### Verify

- [ ] Breadcrumb renders
- [ ] Skills list shows bound skills with badges (or empty state)
- [ ] Right sidebar shows skill count and "Add skill" button
- [ ] Overflow menu opens on skill rows

---

## 5. Jobs Page

**URL:** `/platform/{id}/jobs`
**Expected:** Job cards with pipeline diagrams and copy actions

### Elements

- Breadcrumb: ← workspace name
- Job cards: title, description, Run button, overflow menu (···)
- PipelineDiagram — signal trigger → step nodes with agent labels → connections
- Data Contracts section — schema property tables
- Right sidebar: job list with HTTP badges, RECENT RUNS with timestamps
- Overflow menu: Copy as cURL, Copy CLI command, Edit configuration

### Verify

- [ ] Job cards display with titles and descriptions
- [ ] Pipeline diagrams render (signal → steps → connections)
- [ ] Data Contracts show schema properties
- [ ] Overflow menu (···) opens with 3 options
- [ ] "Copy as cURL" copies valid curl with `-H 'Content-Type: application/json'`
      and `-d '{...}'` and full daemon URL `http://localhost:8080/...`
- [ ] "Copy CLI command" copies valid `deno task atlas signal trigger ...`
      with `--data '{...}'`
- [ ] Right sidebar shows recent runs with timestamps and durations
- [ ] Run button is present (DO NOT click)

### Copy verification technique

Use `window.__lastClipboard` (from clipboard interceptor) — NOT
`navigator.clipboard.readText()` which fails without tab focus.

---

## 6. Runs Page (Sessions)

**URL:** `/platform/{id}/sessions`
**Expected:** Session list sorted by status

### Elements

- Breadcrumb: ← workspace name
- Page title "Runs"
- SessionProgressCard list (active first, then completed/failed)
- Each card: job name, status badge (Complete/Failed), description,
  pipeline step badges with checkmarks/X marks, timestamp, duration
- Right sidebar: Integrations status, RECENT RUNS list
- Empty state: "No runs yet" with hint text

### Verify

- [ ] Page title "Runs" renders
- [ ] Session cards display with status badges
- [ ] Pipeline step badges show completion status (green check, red X, gray circle)
- [ ] Timestamps and durations display
- [ ] Cards are clickable (navigate to session detail)

---

## 7. Session Detail

**URL:** `/platform/{id}/sessions/{sessionId}`
**Expected:** Full session view with agent execution blocks

### Elements

- Breadcrumb: ← workspace name · Runs
- Session title (job name), description
- Timestamp and duration
- Agent blocks: vertical timeline with agent names and durations
- Expandable blocks with Task description, Input JSON (syntax-highlighted)
- Right sidebar: JOB name, workspace, SUMMARY, DETAILS (Run ID, Status,
  Started, Duration, Steps)
- "Complete" block at bottom

### Verify

- [ ] Breadcrumb renders with "Runs" link back to session list
- [ ] Session title and description display
- [ ] Agent blocks render with names (e.g., "Gh", "Claude Code")
- [ ] Duration shown per agent block (e.g., "Succeeded in 5 seconds")
- [ ] Expandable sections show Input JSON with syntax highlighting
- [ ] Right sidebar shows run metadata (ID, status, timestamps, step count)

---

## 8. Config Editor

**URL:** `/platform/{id}/edit`
**Expected:** Full-page CodeMirror YAML editor

### Elements

- Breadcrumb: ← workspace name
- "Edit Configuration" title
- CodeMirror editor with YAML content, line numbers, syntax highlighting
- Save button (top-right)

### Verify

- [ ] CodeMirror editor loads with YAML content
- [ ] Line numbers display
- [ ] Syntax highlighting active (keys, values, strings colored differently)
- [ ] Save button is present
- [ ] DO NOT save any changes
- [ ] DO NOT test Shift+? from this page (CodeMirror captures keystrokes)

---

## 9. CLI Cheatsheet

**Trigger:** Shift+? from any non-editor page
**Expected:** Modal overlay with searchable command reference

### How to trigger

The `computer` tool's `shift+/` key action does NOT produce a `?` key event.
Dispatch via JavaScript from `document.body`:

```javascript
document.body.dispatchEvent(new KeyboardEvent('keydown', {
  key: '?', shiftKey: true, bubbles: true
}));
```

Must dispatch from `document.body` (not `window` or `document`) because
the Svelte handler checks `e.target instanceof HTMLElement`.

### Elements

- "CLI Cheatsheet" title with TERMINAL badge and Esc button
- Search input ("Search commands...")
- Context line showing current workspace path
- Command categories: SESSIONS, SIGNALS & JOBS, WORKSPACES, etc.
- Each command: name (monospace), description, Copy button, Run button
- Command count footer (e.g., "24 commands")
- Keyboard hints: ↑↓ navigate, Enter run, Esc close

### Verify

- [ ] Modal opens via JS dispatch
- [ ] "CLI Cheatsheet" title visible with TERMINAL badge
- [ ] Search input present and functional
- [ ] Commands grouped by category
- [ ] Copy and Run buttons on each command
- [ ] Command count shows in footer
- [ ] Escape closes the modal
- [ ] DO NOT type into the terminal beyond verifying it opens

---

## 10. Agent Tester

**URL:** `/agents/bundled`
**Expected:** Two-panel agent testing interface

### Elements

- Left panel: AGENT dropdown selector, agent description, EXAMPLES buttons,
  PROMPT textarea, ENVIRONMENT editor (key-value with REQUIRED badges),
  validation message ("N required key missing"), Execute button
- Right panel: OUTPUT area with placeholder "Select an agent and enter a prompt"
- Sidebar shows "Agent Tester" as active tool

### Verify

- [ ] Agent dropdown shows available agents
- [ ] Agent description and examples render for selected agent
- [ ] Prompt textarea is present
- [ ] Environment editor shows required keys with status
- [ ] Execute button is present
- [ ] DO NOT click Execute

---

## 11. Inspector

**URL:** `/workspaces`
**Expected:** Workspace generation and file loading interface

### Elements

- "Workspace Inspector" title with subtitle
- DESCRIBE YOUR WORKSPACE textarea
- Generate button
- "OR" divider
- File drop zone: "Drop workspace.yml here or click to browse"

### Verify

- [ ] Title and subtitle render
- [ ] Textarea with placeholder is present
- [ ] Generate button is present
- [ ] File drop zone renders with dashed border

---

## 12. Skills Catalog

**URL:** `/skills`
**Expected:** Skills tree sidebar + skill upload area

### Elements

- Left panel: "Skills" title, "+ Add" button, skill tree (namespace/name)
- Right panel: file drop zone "Drop SKILL.md or skill folder here", Browse button

### Verify

- [ ] Skills tree renders in left panel
- [ ] At least one skill listed (e.g., `@tempest/pr-code-review`)
- [ ] "+ Add" button present
- [ ] File drop zone with Browse button in right panel
- [ ] Skills are clickable in the tree

---

## 13. Skill Detail

**URL:** `/skills/{namespace}/{name}`
**Expected:** Skill markdown preview with action menu

### Elements

- Breadcrumb navigation
- MarkdownContent preview of SKILL.md
- Edit button
- Overflow menu: delete, disable, publish
- Dialog confirmations for destructive actions

### Verify

- [ ] Page loads without blank screen
- [ ] Breadcrumb renders
- [ ] Markdown content or skill info displays
- [ ] No Svelte runtime errors in console
- [ ] DO NOT delete, disable, or publish

### Known Issues

This page has been observed to crash with a Svelte runtime error:
`TypeError: Cannot read properties of undefined (reading 'call')` in
`root.svelte`. If this occurs, record it as FAIL with the error details.

---

## Signal Row Interactions (test on Overview page)

Signal overflow menus have `opacity: 0` until hover. Use `find` to locate by
aria-label "Signal options" — it's clickable even when invisible.

### Verify

- [ ] Signal overflow menu opens with options
- [ ] "Copy signal URL" copies full daemon URL
      (e.g., `http://localhost:8080/api/workspaces/{id}/signals/{signalId}`)
- [ ] "Edit configuration" option is present

---

## Job Card Interactions (test on Jobs page)

Job overflow menus use aria-label "Job options".

### Verify

- [ ] Job overflow menu opens with 3 options
- [ ] "Copy as cURL" — verify clipboard contains `curl -X POST` with
      `-H 'Content-Type: application/json'`, `-d '{...}'`, and full daemon URL
- [ ] "Copy CLI command" — verify clipboard contains `deno task atlas signal
      trigger ... --data '{...}'`
- [ ] "Edit configuration" navigates to config editor with `?path=` parameter

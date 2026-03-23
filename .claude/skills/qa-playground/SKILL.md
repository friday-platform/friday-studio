---
name: qa-playground
description: >
  Performs end-to-end QA of the agent-playground UI via Chrome browser
  automation. Discovers routes from source code, crawls every page, verifies
  interactive elements, and produces a Markdown report. Use when asked to QA
  the playground, test the playground UI, or smoke test the playground.
argument-hint: "[workspace-id] (default: first visible workspace)"
allowed-tools: Bash(curl *), Bash(find *), Bash(ls *), Read, Write, Glob, Grep, ToolSearch, mcp__claude-in-chrome__*
---

# QA Playground UI

## Prerequisites

All chrome MCP tools (`mcp__claude-in-chrome__*`) are deferred. Before first
use of each tool, call `ToolSearch` with `select:mcp__claude-in-chrome__<name>`
to load its schema.

## References

- [references/page-map.md](references/page-map.md) — page inventory with
  per-page verify checklists
- [references/report-template.md](references/report-template.md) — report
  output format

## Phase 1: Environment Setup

### 1.1 Check if playground is already running

```bash
curl -sf http://localhost:5200 > /dev/null 2>&1
```

- If running: skip to Phase 2
- If not: start it (1.2)

### 1.2 Start playground

```bash
deno task dev:playground   # run in background
```

Wait for both services (poll every 2s, timeout 30s):
- `:5200` (Vite) — `curl -sf http://localhost:5200`
- `:7681` (PTY) — `curl -sf http://localhost:7681/health`

### 1.3 Check daemon

```bash
curl -sf http://localhost:8080/health
```

If not running, note it but proceed — platform pages still render from cached
workspace configs on disk.

## Phase 2: Discover Test Targets

### 2.1 Discover routes from source code

The page map is a baseline; source code is the source of truth. Scan before
testing to catch new/removed routes:

```bash
find tools/agent-playground/src/routes -name '+page.svelte' | sort
find tools/agent-playground/src/routes -name '+layout.svelte' | sort
ls tools/agent-playground/src/lib/components/
```

Compare against `references/page-map.md`. New routes: test anyway (navigate,
screenshot, check console). Removed routes: skip and note in report.

### 2.2 Create browser tab

Call `mcp__claude-in-chrome__tabs_context_mcp` then **always create a new tab**
with `mcp__claude-in-chrome__tabs_create_mcp`.

### 2.3 Install clipboard interceptor

Clipboard API fails in automation (tab not focused). Monkey-patch once via
`javascript_tool`:

```javascript
window.__lastClipboard = null;
const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
navigator.clipboard.writeText = async (text) => {
  window.__lastClipboard = text;
  try { await origWrite(text); } catch(e) {}
};
```

After copy actions, read `window.__lastClipboard` (not
`navigator.clipboard.readText()`). Re-install after full page navigations
(client-side navigations preserve it).

### 2.4 Bootstrap console tracking

Call `read_console_messages` once after first page load — tracking only begins
on first call.

### 2.5 Load page map

Read [references/page-map.md](references/page-map.md) for per-page verify
checklists.

### 2.6 Determine workspace ID

- If `$ARGUMENTS` was provided, use it as the workspace ID
- Otherwise, navigate to `http://localhost:5200/platform`, read sidebar for
  first workspace
- No workspaces → test only non-workspace pages

## Phase 3: Execute Tests

### Progress checklist

Copy and track:

```
QA Progress:
- [ ] 1. Root redirect (/)
- [ ] 2. Workspace overview (/platform/{id})
- [ ] 3. Agents (/platform/{id}/agents)
- [ ] 4. Skills (/platform/{id}/skills)
- [ ] 5. Jobs (/platform/{id}/jobs)
- [ ] 6. Runs (/platform/{id}/sessions)
- [ ] 7. Session detail (/platform/{id}/sessions/{sessionId})
- [ ] 8. Config editor (/platform/{id}/edit)
- [ ] 9. CLI cheatsheet (Shift+?)
- [ ] 10. Agent Tester (/agents/bundled)
- [ ] 11. Inspector (/workspaces)
- [ ] 12. Skills catalog (/skills)
- [ ] 13. Skill detail (/skills/{namespace}/{name})
```

### Per-page procedure

For each page:

1. **Navigate** to the URL
2. **Screenshot** via `computer` action `screenshot`
3. **Check console** — `read_console_messages` with
   `pattern: "error|Error|ERR|exception|Exception"` and `clear: true`
4. **Verify structure** — check elements per page-map.md checklist
5. **Test interactions** (non-destructive only): navigation links, dropdown
   menus, modals, copy-to-clipboard (`window.__lastClipboard`)
6. **Record result**: PASS, FAIL (with details), or SKIP (with reason)

If a page fails to load, screenshot the error state, check console, and
continue to the next page.

### Workarounds

**Shift+? cheatsheet** — `computer` key `shift+/` does not produce a `?` event
Svelte recognizes. Dispatch from `document.body` (not `window` — the handler
checks `e.target instanceof HTMLElement`):

```javascript
document.body.dispatchEvent(new KeyboardEvent('keydown', {
  key: '?', shiftKey: true, bubbles: true
}));
```

Don't test from editor pages (CodeMirror captures the keystroke).

**Overflow menus** — Signal/job overflow menus (···) have `opacity: 0` until
hover. `find` locates them by aria-label ("Signal options", "Job options") even
when invisible — click via `ref` directly.

### Safety rails

- Do NOT execute jobs, trigger signals, save config edits, or delete anything
- Do NOT click Run/Execute buttons or submit dialogs
- DO verify these buttons/forms exist and are correctly wired

### Console error policy

- **FAIL** on: uncaught exceptions, Svelte runtime errors, network 4xx/5xx for
  expected endpoints
- **Ignore**: favicon 404, HMR noise, `[vite]` prefixed messages

## Phase 4: Report

Write to `docs/qa/reports/YYYY-MM-DD-playground-ui.md` using
[references/report-template.md](references/report-template.md).

Print terminal summary:

```
Playground QA: X/Y pages passed, Z issues found
Report: docs/qa/reports/YYYY-MM-DD-playground-ui.md
```

List each failure with page and one-line description.

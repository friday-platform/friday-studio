# QA Plan: Bash Tool + Agent Operations E2E

**Context**: Branch `yaml-custom-agents` — 6 commits adding bash tool injection
in runtime.ts + BB/GH agent operations (clone, review, push) using
`ctx.tools.call("bash", ...)`. Unit/integration tests exist but nothing validates
the full stack: runtime -> WASM executor -> Python agent -> host callback -> bash
tool -> subprocess.

**Branch**: yaml-custom-agents
**Date**: 2026-04-06

## Prerequisites

- BB credentials in `~/.atlas/.env`: `BITBUCKET_EMAIL`, `BITBUCKET_TOKEN`
- GH credentials in `~/.atlas/.env`: `GH_TOKEN`
- Build toolchain available: `componentize-py`, `jco` (installed globally)

---

## Phase 0: Setup

Setup is the first thing to execute. Every subsequent case depends on these
completing successfully. If any setup case fails, stop and fix before proceeding.

### S1. Write bash-test agent fixture

**Trigger**: Create `packages/sdk-python/tests/fixtures/bash-test-agent/agent.py`
with this content:

```python
import json
from friday_agent_sdk import agent, ok, err

@agent(id="bash-test", version="1.0.0", description="Exercises bash tool through WASM")
def execute(prompt, ctx):
    """Dispatch based on prompt command."""
    cmd = json.loads(prompt)
    action = cmd.get("action", "echo")

    if action == "list-tools":
        tools = ctx.tools.list()
        return ok({"tools": [t.name for t in tools]})

    if action == "echo":
        result = ctx.tools.call("bash", {"command": "echo hello"})
        return ok({"bash_result": result})

    if action == "exit-code":
        result = ctx.tools.call("bash", {"command": "exit 42"})
        return ok({"bash_result": result})

    if action == "cwd":
        result = ctx.tools.call("bash", {"command": "pwd", "cwd": "/tmp"})
        return ok({"bash_result": result})

    if action == "env":
        result = ctx.tools.call("bash", {
            "command": "echo $QA_TEST_VAR",
            "env": {"QA_TEST_VAR": "wasm-bridge-works"}
        })
        return ok({"bash_result": result})

    if action == "clone":
        repo_url = cmd["repo_url"]
        result = ctx.tools.call("bash", {
            "command": f"git clone --depth 1 {repo_url} /tmp/qa-bash-clone-test && ls /tmp/qa-bash-clone-test"
        })
        ctx.tools.call("bash", {"command": "rm -rf /tmp/qa-bash-clone-test"})
        return ok({"bash_result": result})

    return err(f"Unknown action: {action}")
```

**Expect**: File exists at the path above.

**If broken**: N/A — this is a write step.

### S2. Build bash-test agent

**Trigger**:
```bash
deno task atlas agent build packages/sdk-python/tests/fixtures/bash-test-agent
```

**Expect**: Build succeeds. Output shows agent installed at
`~/.atlas/agents/bash-test@1.0.0/`. Verify:
```bash
ls ~/.atlas/agents/bash-test@1.0.0/agent-js/agent.js
cat ~/.atlas/agents/bash-test@1.0.0/metadata.json
```
metadata.json should contain `"id": "bash-test"`.

**If broken**: Check `componentize-py` is installed (`pip install componentize-py`).
Check `jco` is installed (`npm install -g @bytecodealliance/jco`). Check
`packages/sdk-python/wit/agent.wit` is valid. Check build error output for
missing Python imports or WIT interface mismatches.

### S3. Build BB agent

**Trigger**:
```bash
deno task atlas agent build packages/sdk-python/tests/fixtures/bb-agent
```

**Expect**: Build succeeds. Verify:
```bash
ls ~/.atlas/agents/bb@1.0.0/agent-js/agent.js
```

**If broken**: The BB agent imports `uuid`, `base64`, `re`, `json`, `dataclasses`,
`urllib.parse` — all stdlib, should be available in componentize-py. If a build
error mentions missing modules, check which import is failing. The agent also
imports from `friday_agent_sdk` — the `-p packages/sdk-python` flag must be
passed so the SDK is on the Python path.

### S4. Build GH agent

**Trigger**:
```bash
deno task atlas agent build packages/sdk-python/tests/fixtures/gh-agent
```

**Expect**: Build succeeds. Verify:
```bash
ls ~/.atlas/agents/gh@1.0.0/agent-js/agent.js
```

**If broken**: Same as S3. The GH agent imports `uuid`, `json`, `re`,
`dataclasses`, `urllib.parse`.

### S5. Extend workspace.yml

**Trigger**: Update `examples/code-agent-workspace/workspace.yml` to add three
new signals, three new agent declarations, and three new jobs.

Add to `signals:`:
```yaml
  run-bash-test:
    provider: http
    title: Run Bash Test Agent
    description: Triggers bash tool test agent
    config:
      path: /webhooks/run-bash-test
    schema:
      type: object
      properties:
        action:
          type: string
      required:
        - action
  run-bb:
    provider: http
    title: Run BB Agent
    description: Triggers Bitbucket agent
    config:
      path: /webhooks/run-bb
    schema:
      type: object
      properties:
        prompt:
          type: string
      required:
        - prompt
  run-gh:
    provider: http
    title: Run GH Agent
    description: Triggers GitHub agent
    config:
      path: /webhooks/run-gh
    schema:
      type: object
      properties:
        prompt:
          type: string
      required:
        - prompt
```

Add to `agents:`:
```yaml
  bash-test:
    type: user
    agent: bash-test
    description: Exercises bash tool through WASM
  bb:
    type: user
    agent: bb
    description: Bitbucket PR operations
  gh:
    type: user
    agent: gh
    description: GitHub PR operations
```

Add to `jobs:`:
```yaml
  bash-test-job:
    title: Bash Test
    triggers:
      - signal: run-bash-test
    fsm:
      id: bash-test-pipeline
      initial: idle
      states:
        idle:
          'on':
            run-bash-test:
              target: step_bash_test
        step_bash_test:
          entry:
            - type: agent
              agentId: bash-test
              outputTo: bash-test-output
              prompt: "{{trigger.data | json}}"
            - type: emit
              event: ADVANCE
          'on':
            ADVANCE:
              target: completed
        completed:
          type: final
      functions: {}
      tools: {}
  bb-job:
    title: BB Agent
    triggers:
      - signal: run-bb
    fsm:
      id: bb-pipeline
      initial: idle
      states:
        idle:
          'on':
            run-bb:
              target: step_bb
        step_bb:
          entry:
            - type: agent
              agentId: bb
              outputTo: bb-output
              prompt: "{{trigger.data.prompt}}"
            - type: emit
              event: ADVANCE
          'on':
            ADVANCE:
              target: completed
        completed:
          type: final
      functions: {}
      tools: {}
  gh-job:
    title: GH Agent
    triggers:
      - signal: run-gh
    fsm:
      id: gh-pipeline
      initial: idle
      states:
        idle:
          'on':
            run-gh:
              target: step_gh
        step_gh:
          entry:
            - type: agent
              agentId: gh
              outputTo: gh-output
              prompt: "{{trigger.data.prompt}}"
            - type: emit
              event: ADVANCE
          'on':
            ADVANCE:
              target: completed
        completed:
          type: final
      functions: {}
      tools: {}
```

**Expect**: workspace.yml parses without errors. YAML is valid.

**If broken**: Check YAML indentation. Check that signal names, agent IDs, and
job references are consistent. Validate with
`deno task atlas workspace list` after daemon restart.

### S6. Start daemon and verify workspace

**Trigger**:
```bash
# Stop if already running (picks up code changes on restart)
deno task atlas daemon stop 2>/dev/null
deno task atlas daemon start --detached

# Wait for startup
sleep 3

# Verify
deno task atlas daemon status
deno task atlas workspace list
```

**Expect**: Daemon running. Workspace list includes the code-agent-workspace.
No errors in startup logs:
```bash
deno task atlas logs --level error --since 30s
```

**If broken**: Check daemon logs for workspace.yml parse errors. Check that
`~/.atlas/agents/` contains all three agents (bash-test, bb, gh). Check port
8080 isn't already in use.

### S7. Verify all agents are discoverable

**Trigger**:
```bash
# Trigger the echo agent to confirm basic WASM execution still works
deno task atlas signal trigger run-echo \
  --data '{"message": "setup-check"}' \
  --workspace <workspace-slug>
```

**Expect**: Session completes with echo agent output containing "setup-check".
This confirms the existing agent infrastructure works before we test new agents.

**If broken**: If even the echo agent fails, the problem is in daemon/workspace
setup, not in our new code. Check `deno task atlas logs --since 30s`.

---

## Layer A: WASM Bridge

These cases validate that the bash tool works end-to-end through the WASM
boundary. The tools-agent fixture already tests `ctx.tools.call()` for MCP
tools — these cases prove the injected bash tool works the same way.

**Depends on**: All setup cases (S1-S7) passing.

### A1. Bash tool appears in ctx.tools.list() through WASM

**Trigger**:
```bash
deno task atlas signal trigger run-bash-test \
  --data '{"action": "list-tools"}' \
  --workspace <workspace-slug>
```
Then fetch session output:
```bash
deno task atlas session get <session-id>
```

**Expect**: The agent returns an `ok` result containing `{"tools": [...]}` where
the list includes `"bash"` alongside any MCP tools (e.g., `"echo"` from the
echo-server). This proves the bash tool injection in runtime.ts is visible
through the WASM boundary's `listTools()` host function.

**If broken**: Check `packages/workspace/src/runtime.ts:1351` — is
`mcpTools["bash"]` set before `mcpListTools` closure captures the dict? Check
`code-agent-executor.ts:498-505` — does `listTools()` serialize the bash tool's
inputSchema correctly? Check daemon logs for WASM execution errors.

### A2. Simple bash command through WASM boundary

**Trigger**:
```bash
deno task atlas signal trigger run-bash-test \
  --data '{"action": "echo"}' \
  --workspace <workspace-slug>
```

**Expect**: Agent returns `{"bash_result": {"stdout": "hello\n", "stderr": "", "exit_code": 0}}`.
This proves the full chain: Python `ctx.tools.call("bash", args)` -> JSON
serialize -> WASM `call_tool` import -> JS host `callTool` ->
`createBashTool().execute()` -> `execFile("/bin/bash", ["-c", "echo hello"])` ->
result JSON back through every layer.

**If broken**: Check `code-agent-executor.ts:486-495` — does `callTool` properly
`JSON.parse(argsJson)` and pass to `mcpToolCall`? Check `bash-tool.ts` execute
callback. Check `_types.py:52-57` — does `Tools.call()` properly
`json.dumps(args)` before calling through WIT?

### A3. Non-zero exit code propagation through WASM

**Trigger**:
```bash
deno task atlas signal trigger run-bash-test \
  --data '{"action": "exit-code"}' \
  --workspace <workspace-slug>
```

**Expect**: Agent returns `{"bash_result": {"stdout": "", "stderr": "", "exit_code": 42}}`.
The bash tool must NOT throw on non-zero exit — it returns the result and lets
the agent decide. This verifies the error doesn't get caught by the WASM
boundary's `result<string, string>` WIT type as an error variant.

**If broken**: Check `bash-tool.ts:62-70` — does the error handler resolve
(not reject) the promise? Check `code-agent-executor.ts:491-494` — if
`mcpToolCall` doesn't throw, the result should flow through as OK variant.

### A4. Custom cwd through WASM

**Trigger**:
```bash
deno task atlas signal trigger run-bash-test \
  --data '{"action": "cwd"}' \
  --workspace <workspace-slug>
```

**Expect**: Agent returns stdout containing `/tmp` (or `/private/tmp` on macOS).
Validates that the `cwd` parameter in the bash tool args survives JSON
serialization through the WASM boundary.

**If broken**: Check that `execFile` options include `cwd` from parsed args.

### A5. Custom env through WASM

**Trigger**:
```bash
deno task atlas signal trigger run-bash-test \
  --data '{"action": "env"}' \
  --workspace <workspace-slug>
```

**Expect**: Agent returns stdout containing `wasm-bridge-works`. Validates that
the `env` parameter (a `Record<string, string>`) survives JSON round-trip
through WASM and gets merged with process.env in the bash tool.

**If broken**: Check `bash-tool.ts:50-51` — env merging logic. Check JSON
serialization of nested objects through WIT boundary.

---

## Layer B: Daemon E2E

These cases validate the full daemon stack: HTTP trigger -> workspace runtime ->
FSM -> agent action -> CodeAgentExecutor -> WASM -> bash tool -> subprocess.

**Depends on**: Layer A passing (proves WASM bridge works in isolation).

### B1. Daemon health + workspace loaded

**Trigger**:
```bash
deno task atlas daemon status
deno task atlas workspace list
```

**Expect**: Daemon running, code-agent-workspace visible in workspace list with
the new agents (bash-test, bb, gh) registered.

**If broken**: Check daemon logs: `deno task atlas logs --level error`. Check
workspace.yml parsing errors.

### B2. Bash-test agent triggered via signal

**Trigger**:
```bash
deno task atlas signal trigger run-bash-test \
  --data '{"action": "echo"}' \
  --workspace <workspace-slug>
```

**Expect**: Session created, agent executes, session reaches `completed` state.
Check session output:
```bash
deno task atlas session get <session-id>
```
Agent output should contain `{"bash_result": {"stdout": "hello\n", ...}}`.

**If broken**: Check session state — did it hang in `step_bash_test`? Check
daemon logs for WASM execution errors:
`deno task atlas logs --level error --since 60s`.
Check that bash-test agent WASM is properly installed in `~/.atlas/agents/`.

### B3. Real git clone through bash-test agent via daemon

**Trigger**:
```bash
deno task atlas signal trigger run-bash-test \
  --data '{"action": "clone", "repo_url": "https://github.com/anthropics/anthropic-cookbook"}' \
  --workspace <workspace-slug>
```

**Expect**: Session completes. Agent output shows stdout containing filenames
from the cloned repo (the `ls` output). This proves a real subprocess (`git
clone`) ran inside the daemon's process context, triggered by a Python WASM
agent calling `ctx.tools.call("bash", ...)`.

**If broken**: Check if git is available in daemon's PATH. Check daemon process
cwd and permissions. Check `/tmp/qa-bash-clone-test` cleanup happened.

---

## Layer C: Agent Operations E2E

These cases validate the BB and GH agents running through the full daemon stack
with real credentials and real API calls.

**Depends on**: Layer B passing (proves daemon can trigger agents with bash tool).

### C1. BB agent: clone PR #48 through daemon

**Trigger**:
```bash
deno task atlas signal trigger run-bb \
  --data '{"prompt": "{\"operation\": \"clone\", \"pr_url\": \"https://bitbucket.org/insanelygreatteam/google_workspace_mcp/pull-requests/48\"}"}' \
  --workspace <workspace-slug>
```

**Expect**: Session completes. Agent output contains:
- `operation: "clone"`, `success: true`
- `data.repo: "insanelygreatteam/google_workspace_mcp"`
- `data.pr_number: 48`
- `data.branch` — source branch name (non-empty)
- `data.changed_files` — list of filenames from diffstat
- `data.pr_metadata.title` — non-empty string
- `data.path` — a `/tmp/bb-clone-*` path (clone actually happened on disk)

Verify clone on disk:
```bash
ls <clone-path>/.git
```

**If broken**: Check credentials: `BITBUCKET_EMAIL` and `BITBUCKET_TOKEN` must
be in daemon env (loaded from `~/.atlas/.env`). Check `deno task atlas logs`
for HTTP 401/403 from Bitbucket API. Check GIT_ASKPASS script creation in
`/tmp/bb-askpass-*`. Check that bash tool is available to BB agent (A1 must
pass first).

### C2. BB agent: repo-clone + repo-push round trip

**Trigger**:
```bash
# Step 1: Clone the repo
deno task atlas signal trigger run-bb \
  --data '{"prompt": "{\"operation\": \"repo-clone\", \"repo_url\": \"https://bitbucket.org/insanelygreatteam/google_workspace_mcp\"}"}' \
  --workspace <workspace-slug>

# Step 2: Create a test branch in the cloned dir (manual shell)
cd <clone-path-from-step-1>
git checkout -b qa-test-push-$(date +%s)
echo "QA test $(date)" > qa-test.txt
git add qa-test.txt
git commit -m "QA: test push — safe to delete"

# Step 3: Push the branch via BB agent
deno task atlas signal trigger run-bb \
  --data '{"prompt": "{\"operation\": \"repo-push\", \"path\": \"<clone-path>\", \"branch\": \"<branch-name>\", \"repo_url\": \"https://bitbucket.org/insanelygreatteam/google_workspace_mcp\"}"}' \
  --workspace <workspace-slug>
```

**Expect**:
- Step 1: `success: true`, clone dir exists with `.git/`
- Step 3: `success: true`, `data.branch` matches the test branch name

Verify on Bitbucket: branch exists in the repo. Clean up: delete the remote
branch after verification.

**If broken**: Credential issues most likely. Check that `x-bitbucket-api-token-auth`
is used as username (not the email). Check GIT_ASKPASS env var propagation
through bash tool. Check `git -c credential.helper=` disables system helpers.

### C3. BB agent: pr-inline-review on PR #48

**Trigger**:
```bash
deno task atlas signal trigger run-bb \
  --data '{"prompt": "{\"operation\": \"pr-inline-review\", \"pr_url\": \"https://bitbucket.org/insanelygreatteam/google_workspace_mcp/pull-requests/48\", \"verdict\": \"approve\", \"summary\": \"[QA e2e test] Automated validation — safe to ignore\", \"findings\": [{\"severity\": \"info\", \"category\": \"qa-test\", \"file\": \"README.md\", \"line\": 1, \"title\": \"QA Test Finding\", \"description\": \"Automated QA test finding. Safe to ignore.\", \"suggestion\": \"No change needed\"}]}"}' \
  --workspace <workspace-slug>
```

**Expect**: Session completes. Agent output:
- `posted_comments` >= 0 (may be 0 if line 1 is outside diff range)
- `failed_comments` >= 0
- `posted_comments + failed_comments == 1`
- Summary comment posted on PR #48

Verify on Bitbucket: Navigate to PR #48 comments — either an inline comment
at README.md:1 or a summary comment with the finding in a `<details>` block.

**If broken**: Check BB API response codes in daemon logs. 400/422 for inline
means the file/line is outside diff range (expected — finding falls back to
summary). 401/403 means credential issue.

### C4. GH agent: clone PR #2732 through daemon

**Trigger**:
```bash
deno task atlas signal trigger run-gh \
  --data '{"prompt": "{\"operation\": \"clone\", \"pr_url\": \"https://github.com/friday-platform/friday-studio/pull/2732\"}"}' \
  --workspace <workspace-slug>
```

**Expect**: Session completes. Agent output contains:
- `operation: "clone"`, `success: true`
- `data.repo: "friday-platform/friday-studio"`
- `data.pr_number: 2732`
- `data.branch` — head ref
- `data.base_branch` — base ref
- `data.head_sha` — 40-char hex
- `data.changed_files` — list of filenames
- `data.pr_metadata.title` — non-empty
- `data.path` — `/tmp/gh-clone-*` directory

Verify clone on disk:
```bash
ls <clone-path>/.git
```

**If broken**: Check `GH_TOKEN` in daemon env. Check GitHub API responses
(401 = bad token, 404 = wrong repo/PR). Check `GIT_CONFIG_COUNT/KEY/VALUE`
credential helper pattern in bash tool env.

### C5. GH agent: pr-review on PR #2732

**Trigger**:
```bash
deno task atlas signal trigger run-gh \
  --data '{"prompt": "{\"operation\": \"pr-review\", \"pr_url\": \"https://github.com/friday-platform/friday-studio/pull/2732\", \"body\": \"[QA e2e test] Daemon-triggered review comment — safe to ignore\"}"}' \
  --workspace <workspace-slug>
```

**Expect**: Session completes. Agent output:
- `operation: "pr-review"`, `success: true`
- `data.comment_id` — integer

Verify on GitHub: Navigate to PR #2732 — comment should be visible.

**If broken**: Check `GH_TOKEN` permissions — needs `repo` scope for comment
posting. Check that `Authorization: Bearer {token}` header is sent (not Basic
auth). Check issues API endpoint: `/repos/{nwo}/issues/{pr_number}/comments`.

### C6. GH agent: pr-inline-review on PR #2732

**Trigger**:
```bash
deno task atlas signal trigger run-gh \
  --data '{"prompt": "{\"operation\": \"pr-inline-review\", \"pr_url\": \"https://github.com/friday-platform/friday-studio/pull/2732\", \"verdict\": \"COMMENT\", \"summary\": \"[QA e2e test] Automated inline review — safe to ignore\", \"findings\": [{\"severity\": \"info\", \"category\": \"qa-test\", \"file\": \"README.md\", \"line\": 1, \"title\": \"QA Test Finding\", \"description\": \"Automated e2e validation. Safe to ignore.\"}]}"}' \
  --workspace <workspace-slug>
```

**Expect**: Session completes. Agent output:
- `posted_comments + failed_comments == 1`
- Summary comment posted with verdict + findings count

If the inline comment fails (outside diff range), the summary should contain a
`<details>` block with the failed finding.

**If broken**: Inline review comments require `commit_id` — if not provided, the
agent fetches HEAD SHA from PR metadata. Check that the metadata fetch succeeds
(needs `GH_TOKEN`). Check 422 response body for GitHub's validation error
details.

---

## Smoke Candidates

- **A2** (bash echo through WASM) — fast, deterministic, proves the core bridge
- **B2** (bash-test via daemon signal) — proves full daemon stack for code agents
- **C4** (GH clone through daemon) — proves real git + API operations e2e

These three form a minimal regression suite: if the bridge works (A2), the
daemon can trigger it (B2), and a real agent can do real work through it (C4).

---

## Cleanup Checklist

After QA run:
- [ ] Delete test branches pushed to BB repo
- [ ] Clean up `/tmp/bb-clone-*` and `/tmp/gh-clone-*` directories
- [ ] Clean up `/tmp/qa-bash-clone-test` if it wasn't auto-cleaned
- [ ] Note: review comments on PR #48 and PR #2732 are permanent (tagged as QA)

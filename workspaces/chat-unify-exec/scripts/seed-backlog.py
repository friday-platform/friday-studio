#!/usr/bin/env python3
"""Seed the thick_endive autopilot-backlog with the 9 chat-unification tasks.

Each task points at the chat-unify-exec workspace's execute-task signal.
The planner (autopilot-planner v1.6.0) reads this backlog, dedupes by id,
and dispatches tasks one at a time via the per-task cooldown gate.

Priorities are 100 → 20 descending so phases run in order.
Tasks with playwright_routes include them in the payload; the FSM's
guard_needs_browser_test will route through step_browser_test for those.

Idempotent: re-running appends new "pending" entries with the same id,
which the planner's latest-by-id dedupe will correctly shadow.
"""
import json
import urllib.request

BACKLOG_URL = "http://localhost:8080/api/memory/thick_endive/narrative/autopilot-backlog"
TARGET_WORKSPACE_NAME = "Chat Unification Exec"
TARGET_SIGNAL = "execute-task"
PLAN_DOC = "docs/plans/2026-04-15-chat-unification.md"


def resolve_target_workspace_id() -> str:
    """Look up the runtime workspace ID for the Chat Unification Exec workspace.

    Runtime IDs are random (e.g. chunky_endive, thick_endive) — never
    hardcode. Always resolve from the workspace list by human-readable name.
    """
    with urllib.request.urlopen("http://localhost:8080/api/workspaces") as r:
        body = json.load(r)
    workspaces = body if isinstance(body, list) else body.get("workspaces", [])
    for ws in workspaces:
        if ws.get("name") == TARGET_WORKSPACE_NAME:
            return ws["id"]
    raise RuntimeError(
        f"workspace {TARGET_WORKSPACE_NAME!r} not found — register it via "
        f"POST /api/workspaces/create before running this seeder"
    )

TASKS = [
    {
        "id": "chat-unify-1-kernel-visibility-flag",
        "priority": 100,
        "text": "Chat unify phase 1: ATLAS_EXPOSE_KERNEL env var hides kernel workspace from user-facing surfaces",
        "task_brief": (
            "Implement Phase 1 of " + PLAN_DOC + ". Add ATLAS_EXPOSE_KERNEL "
            "env var. When unset, the kernel workspace (runtime id "
            "thick_endive for now) is filtered out of user-facing lists "
            "(/api/workspaces list route, workspace pickers in playground "
            "and web-client). Internal paths (cron, planner, session "
            "dispatch) still see and use it. Document the var in CLAUDE.md. "
            "Do NOT rename thick_endive — that is explicitly deferred."
        ),
        "target_files": [
            "apps/atlasd/routes/workspaces/index.ts",
            "apps/atlasd/src/atlas-daemon.ts",
            "CLAUDE.md",
        ],
        "playwright_routes": ["/spaces", "/chat"],
        "playwright_assertions": [
            "workspace picker does not include thick_endive when admin flag is unset",
        ],
    },
    {
        "id": "chat-unify-2-workspace-memory-on-create",
        "priority": 90,
        "text": "Chat unify phase 2: WorkspaceManager.create seeds memory.own directories",
        "task_brief": (
            "Implement Phase 2 of " + PLAN_DOC + ". WorkspaceManager.create "
            "reads memory.own from the new workspace's config and calls a "
            "new seedMemories helper that pre-creates the narrative "
            "directory for each declared memory. MdMemoryAdapter gains a "
            "public ensureRoot() method for directory creation without "
            "appending. Existing workspaces unaffected; lazy creation on "
            "first write is preserved as the fallback."
        ),
        "target_files": [
            "packages/workspace/src/manager.ts",
            "packages/memory/src/bootstrap.ts",
            "packages/adapters-md/src/md-memory-adapter.ts",
        ],
    },
    {
        "id": "chat-unify-3-default-user-workspace-first-run",
        "priority": 85,
        "text": "Chat unify phase 3: daemon creates default user workspace on first run",
        "task_brief": (
            "Implement Phase 3 of " + PLAN_DOC + ". Daemon init checks for "
            "non-system user workspaces via the registry. If none exist, "
            "creates a 'user' workspace with stable id, memory.own of "
            "['user-profile', 'notes', 'scratchpad'], and the default chat "
            "agent config. Phase 2 ensures those memory directories get "
            "seeded. Depends on Phase 2 being completed first."
        ),
        "target_files": [
            "packages/workspace/src/first-run-bootstrap.ts",
            "packages/workspace/src/user-workspace-template.yml",
            "packages/workspace/src/manager.ts",
        ],
        "blocked_by": ["chat-unify-2-workspace-memory-on-create"],
    },
    {
        "id": "chat-unify-4-layered-chat-context",
        "priority": 80,
        "text": "Chat unify phase 4: workspace-chat agent composes primary + foreground context",
        "task_brief": (
            "Implement Phase 4 of " + PLAN_DOC + ". workspace-chat agent "
            "accepts foreground_workspace_ids from the chat signal payload "
            "and composes memory + skills + tools + resources from primary "
            "+ each foreground. Kernel is excluded from composition unless "
            "ATLAS_EXPOSE_KERNEL=1. Tool allow-list union with primary-wins "
            "on conflict. Plumb foreground_workspace_ids through the chat "
            "route and the chat SDK instance's message handler."
        ),
        "target_files": [
            "packages/system/agents/workspace-chat/workspace-chat.agent.ts",
            "apps/atlasd/src/chat-sdk/chat-sdk-instance.ts",
            "apps/atlasd/routes/workspaces/chat.ts",
        ],
        "blocked_by": ["chat-unify-1-kernel-visibility-flag"],
    },
    {
        "id": "chat-unify-5-first-chat-onboarding",
        "priority": 75,
        "text": "Chat unify phase 5: first-chat onboarding persists user name to user-profile",
        "task_brief": (
            "Implement Phase 5 of " + PLAN_DOC + ". On every chat turn, "
            "workspace-chat agent loads user/user-profile narrative. If "
            "empty or missing a name entry, the system prompt gets an "
            "onboarding clause instructing the agent to introduce itself "
            "as Friday, ask what to call the user, and call memory_save "
            "with the answer. Idempotent check-before-ask each turn. "
            "Handle decline gracefully by persisting a decline marker."
        ),
        "target_files": [
            "packages/system/agents/workspace-chat/workspace-chat.agent.ts",
            "packages/agent-sdk/src/memory-scope.ts",
        ],
        "blocked_by": [
            "chat-unify-3-default-user-workspace-first-run",
            "chat-unify-4-layered-chat-context",
        ],
        "playwright_routes": ["/chat/new"],
        "playwright_assertions": [
            "fresh user sees Friday greeting asking for name",
            "replying with a name triggers a memory save and subsequent greeting uses the name",
            "reloading preserves the greeting state",
        ],
    },
    {
        "id": "chat-unify-6-api-chat-delegates-to-user-workspace",
        "priority": 70,
        "text": "Chat unify phase 6: /api/chat delegates to user workspace; conversation agent quarantined",
        "task_brief": (
            "Implement Phase 6 of " + PLAN_DOC + ". POST /api/chat becomes "
            "a thin delegator to POST /api/workspaces/user/chat. GET "
            "/api/chat/:chatId keeps working with a fallback to load "
            "legacy chats from ~/.atlas/chats/atlas-conversation/. "
            "conversation.agent.ts and conversation.yml signal/job get "
            "LEGACY quarantine headers — DO NOT delete. The shim stays "
            "until the Phase 9 cleanup audit clears it."
        ),
        "target_files": [
            "apps/atlasd/routes/chat.ts",
            "packages/system/agents/conversation/conversation.agent.ts",
            "packages/system/workspaces/conversation.yml",
        ],
        "blocked_by": ["chat-unify-4-layered-chat-context"],
    },
    {
        "id": "chat-unify-7-web-and-cli-cutover-to-user",
        "priority": 60,
        "text": "Chat unify phase 7: web-client standalone route and CLI prompt cut over to user workspace path",
        "task_brief": (
            "Implement Phase 7 of " + PLAN_DOC + ". Web-client standalone "
            "/chat/[[chatId]] route and CLI `atlas prompt` both post "
            "directly to /api/workspaces/user/chat. `atlas prompt "
            "--workspace X` adds X to foreground_workspace_ids. The old "
            "/api/chat thin delegator stays as a legacy shim."
        ),
        "target_files": [
            "apps/web-client/src/lib/modules/conversation/load-chat.ts",
            "apps/web-client/src/lib/modules/conversation/chat-provider.svelte",
            "apps/web-client/src/routes/(app)/chat/[[chatId]]/+page.svelte",
            "apps/atlas-cli/src/commands/prompt.ts",
        ],
        "blocked_by": ["chat-unify-6-api-chat-delegates-to-user-workspace"],
        "playwright_routes": ["/chat/new", "/spaces/braised_biscuit/chat/new"],
        "playwright_assertions": [
            "standalone chat works end-to-end",
            "workspace-scoped chat works end-to-end",
            "foreground workspace memory is referenced in replies",
        ],
    },
    {
        "id": "chat-unify-8-chat-as-top-level-ui",
        "priority": 50,
        "text": "Chat unify phase 8: web-client lands on /chat with foreground workspace picker",
        "task_brief": (
            "Implement Phase 8 of " + PLAN_DOC + ". Web-client root "
            "redirects to /chat. Chat UI shows user workspace as base + "
            "empty foreground list + a picker. Toggling a workspace adds "
            "or removes it from foreground_workspace_ids in subsequent "
            "requests. /spaces/{id}/chat pre-fills foreground with that id."
        ),
        "target_files": [
            "apps/web-client/src/routes/(app)/+layout.svelte",
            "apps/web-client/src/lib/modules/conversation/chat-provider.svelte",
            "apps/web-client/src/routes/(app)/spaces/[spaceId]/chat/[[chatId]]/+page.svelte",
        ],
        "blocked_by": ["chat-unify-7-web-and-cli-cutover-to-user"],
        "playwright_routes": ["/", "/chat", "/spaces/braised_biscuit/chat/new"],
        "playwright_assertions": [
            "root redirects to /chat",
            "foreground picker toggles workspace context",
            "deep-linked workspace chat pre-fills foreground",
        ],
    },
    {
        "id": "chat-unify-9-observability-and-cleanup-audit",
        "priority": 20,
        "text": "Chat unify phase 9: chat turn session events + legacy cleanup audit doc",
        "task_brief": (
            "Implement Phase 9 of " + PLAN_DOC + ". Emit session lifecycle "
            "events from chat-sdk-instance's message handler so workspace "
            "chat turns show up in /api/sessions listings. Write a new "
            "cleanup-audit doc at docs/plans/2026-04-15-chat-unification-"
            "cleanup-audit.md enumerating every remaining reference to "
            "conversation agent, atlas-conversation workspace, "
            "conversation-stream signal, and /api/chat. Do NOT delete "
            "anything — the audit is the output."
        ),
        "target_files": [
            "apps/atlasd/src/chat-sdk/chat-sdk-instance.ts",
            "packages/core/src/stream-event-filter.ts",
            "docs/chat-architecture.md",
            "docs/plans/2026-04-15-chat-unification-cleanup-audit.md",
        ],
        "blocked_by": ["chat-unify-8-chat-as-top-level-ui"],
    },
]


def seed():
    target_id = resolve_target_workspace_id()
    print(f"target workspace: {TARGET_WORKSPACE_NAME} -> {target_id}")
    appended = 0
    for task in TASKS:
        body = {
            "id": task["id"],
            "text": task["text"],
            "metadata": {
                "status": "pending",
                "priority": task["priority"],
                "kind": "chat-unify",
                "blocked_by": task.get("blocked_by", []),
                "match_job_name": "execute-task",
                "payload": {
                    "workspace_id": target_id,
                    "signal_id": TARGET_SIGNAL,
                    "task_id": task["id"],
                    "task_brief": task["task_brief"],
                    "target_files": task.get("target_files", []),
                    "playwright_routes": task.get("playwright_routes", []),
                    "playwright_assertions": task.get("playwright_assertions", []),
                },
            },
        }
        req = urllib.request.Request(
            BACKLOG_URL,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            if resp.status in (200, 201):
                appended += 1
                print(f"  + {task['id']} (p={task['priority']})")
            else:
                print(f"  ! {task['id']}: status {resp.status}")
    print(f"\nseeded {appended}/{len(TASKS)} chat-unification tasks")


if __name__ == "__main__":
    seed()

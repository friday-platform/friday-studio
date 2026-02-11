# Learnings: TEM-3390 Token Limits UI

## Concurrent teammates can accidentally cross-contaminate commits

When two teammates work in parallel and one runs `git add` broadly (or the
pre-commit hook stages files), changes from the other teammate's WIP can get
pulled into the wrong commit. Po's commit (sidebar card) included Leela's
message-form changes even though Po claims they only touched sidebar.svelte.

**Mitigation**: Teammates should always `git add <specific-files>` instead of
`git add .` or `git add -A`. The committing skill should emphasize this for
team contexts.

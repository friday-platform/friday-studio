# Contributing to Friday Studio

Thanks for your interest in contributing. This document covers what you need
to know before opening a pull request.

## Before you start

- **Read the [CLA](./CLA.md).** Friday Studio uses an assignment-style
  Contributor License Agreement. Every commit you submit must indicate
  acceptance of the CLA (see [Signing your commits](#signing-your-commits)
  below). Pull requests with unsigned commits will not be merged.
- **Read the [LICENSE](./LICENSE).** Friday Studio is distributed under the
  Business Source License 1.1.
- For non-trivial changes, **open an issue first** to discuss the approach.
  This avoids spending time on a PR that won't land.

## Development setup

Detailed environment notes live in [`README.md`](./README.md). The short
version:

```bash
# Deno + TypeScript (core platform)
deno task dev:playground  # Daemon (auto-restart) + web playground + link + tunnel
deno task start           # Daemon only, no auto-restart
deno task typecheck       # Type check (deno check + svelte-check)
deno task lint            # Lint
deno task test $file      # Run a specific test (vitest)

# Go (operator, auth, supporting services)
go fmt ./...
golangci-lint run
go test -race ./...
```

Run typecheck, lint, and the relevant tests locally before pushing. CI runs
the same checks; failing CI blocks merge.

## Signing your commits

**Every commit must include a `Signed-off-by:` trailer.** This trailer
records your acceptance of the [CLA](./CLA.md), including the copyright
assignment in Section 2. PRs with any unsigned commit will be rejected by
the CLA bot.

The simplest way to add the trailer is the `-s` flag:

```bash
git commit -s -m "your commit message"
```

This appends a line like:

```
Signed-off-by: Your Real Name <your.email@example.com>
```

The name and email come from `git config user.name` and `git config
user.email`, so set those first if you haven't:

```bash
git config --global user.name  "Your Real Name"
git config --global user.email "your.email@example.com"
```

> **Note.** This `Signed-off-by:` trailer is **not** the lighter-weight
> [Developer Certificate of Origin](https://developercertificate.org/).
> In this Project the trailer means you accept the full CLA — including
> the copyright assignment. See [CLA Section 7](./CLA.md#7-acceptance) for
> the exact certification you make by including it.

If you forgot to sign a commit, fix it before pushing:

```bash
# Sign the most recent commit
git commit --amend --no-edit -s

# Sign every commit on this branch (interactive rebase against main)
git rebase --signoff main
```

Force-push after either of these to update the PR.

## Pull request workflow

Don't push directly to `main` — it's protected. Use a feature branch:

```bash
git checkout -b your-feature-name
# ... make changes, commit with -s ...
git push -u origin your-feature-name
gh pr create
```

PR conventions:

- **Title**: short, imperative, scoped — e.g. `fix(studio-installer): handle
  empty manifest`. Match the existing commit style (see `git log --oneline`).
- **Body**: what changed, why, and how you tested it. Link the issue if
  there is one.
- **Atomic commits**: each commit should be a self-contained, working step.
  Reviewers shouldn't need to read every commit at once to understand a
  large change, but each one should pass tests.
- **Keep CI green**: type check, lint, tests must pass before merge.

## Reporting bugs

Open a [GitHub issue](https://github.com/friday-platform/friday-studio/issues). Include:

- What you did (steps to reproduce)
- What you expected
- What actually happened
- Your environment (OS, version of Friday Studio if installed)
- Logs if relevant

For security issues, **do not file a public issue.** See
[`SECURITY.md`](./SECURITY.md) — preferred channel is a private
GitHub advisory; email security@hellofriday.ai as a fallback.

## Code style

Project-specific conventions:

- **TypeScript**: no `any`, no `as` assertions (use Zod), static imports only,
  validate external input with Zod. Use `@atlas/logger`, never `console.*`.
- **Go**: `go fmt` clean, `golangci-lint run` clean, tests run with
  `-race` flag.
- **Database**: user-scoped SQL must use `withUserContext()`. RLS policies
  enforce row isolation; bypassing them is a privilege-escalation vector.
- **No half-finished implementations.** No speculative features, no
  defensive code for impossible cases.

## Questions

For development questions, open a discussion or ask in the relevant issue.
For CLA / licensing questions, contact legal@tempest.team.

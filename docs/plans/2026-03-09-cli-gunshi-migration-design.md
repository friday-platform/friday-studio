# CLI Migration: Yargs → Gunshi

Shipped on `cli-refactor` branch, March 2026.

The Atlas CLI is migrating from yargs to gunshi — a lightweight, type-safe CLI
framework. This is an incremental migration, not a big-bang rewrite.

## What Changed

### Entry Point Router (`apps/atlas-cli/src/cli.ts`)

The entry point routes commands between two execution paths based on command
name:

- **Native commands** (`NATIVE_COMMANDS` set) → gunshi with plain text output
- **Legacy commands** (`LEGACY_COMMANDS` set) → old yargs CLI (`cli.tsx`) with
  existing behavior
- **Unknown commands** → error message to stderr + exit(1)

To migrate a command: move it from `LEGACY_COMMANDS` to `NATIVE_COMMANDS`, add
its gunshi `define()` to the `subCommands` map. When `LEGACY_COMMANDS` is empty,
delete `cli.tsx` and yargs.

### Native Version Command (`apps/atlas-cli/src/cli/commands/version.ts`)

The sole natively migrated command. Outputs `atlas v{version} ({channel})` by
default, with `--json` for structured output and `--remote` to check for
updates. Aliases: `version`, `v`.

### Integration Tests (`apps/atlas-cli/src/cli.integration.test.ts`)

Subprocess tests verifying the CLI output contract: `version` (success output),
`v` alias, legacy command routing, unknown command error.

## Key Decisions

**Router-based strangler fig instead of gunshi `lazy()` shims.** The original
plan had gunshi own all routing via `lazy()` wrappers that forwarded to old
handlers. This required redeclaring every arg in gunshi format and manually
mapping `ctx.values` → handler interfaces — ~700 lines of pure translation
boilerplate across 14 wrapper files. We pivoted to routing at the entry point:
native commands go through gunshi, everything else falls through to yargs
unchanged. Zero wrapper code, same gradual migration path.

**Plain text output by default, `--json` opt-in.** The initial design used
JSON Result envelopes for all native command output. This was dropped in favor
of human-readable text by default with a `--json` flag, matching the legacy
commands' behavior and avoiding a breaking change during migration.

**Top-level try/catch, not `onErrorCommand`.** Gunshi's `onErrorCommand` hook
re-throws after running, which would print a stack trace after any error output.
A simple try/catch around `cli()` is explicit and sufficient.

**`rendering: { header: null }` suppresses gunshi's stdout banner.** Gunshi
prints a text banner before `run()` executes. Setting `header: null` on the
command's `rendering` option suppresses it.

## Error Handling

Native commands handle errors directly within their `run()` functions. Uncaught
exceptions in gunshi commands hit the top-level catch and print via
`stringifyError`. Unknown command names produce a "Command not found" error from
the router without loading gunshi or yargs.

## Out of Scope

- Migrating individual commands to native gunshi (future PRs, one domain at a
  time)
- Deleting yargs, Ink, and legacy utils (when last command migrates)
- Schema introspection command (`atlas describe <command>`)
- MCP surface (exposing CLI as JSON-RPC tools)
- Input hardening (control char rejection, path traversal validation)
- `--dry-run` for mutating operations

## Test Coverage

Integration tests invoke the CLI as a subprocess and check stdout/stderr. They
test the output contract, not gunshi's arg parsing. Coverage: version output,
`v` alias, legacy command routing, unknown command error.

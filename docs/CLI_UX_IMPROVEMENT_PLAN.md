# Atlas CLI UX Improvement Plan

Based on the CLI best practices guide and analysis of the current implementation, this document
outlines a comprehensive plan to improve the Atlas CLI user experience, incorporating modern CLI
technologies.

## Executive Summary

The current Atlas CLI has a solid foundation with good shorthand support and logical command
structure. However, there are several areas where we can significantly improve the user experience
by following established CLI best practices and adopting modern CLI frameworks like Yargs and
@clack/prompts.

## Current State Analysis

### Strengths

- Good shorthand support (`work`, `sig`, `sesh`, etc.)
- Smart defaults for common operations
- Logical noun-verb structure for most commands
- Support for both long and short flags
- Structured subcommand architecture

### Areas for Improvement

1. **Command Structure**: Some inconsistencies in noun-verb ordering
2. **Output Handling**: No clear separation of stdout/stderr
3. **Machine-Readable Output**: Limited JSON output support
4. **Destructive Operations**: No confirmation prompts
5. **Help System**: Could be more contextual and example-driven
6. **Error Messages**: Not always helpful with suggestions
7. **Progress Indicators**: Missing for long-running operations
8. **Configuration**: Not following XDG Base Directory spec
9. **CLI Framework**: Currently using meow, could benefit from Yargs
10. **Prompts**: Basic readline, could use @clack/prompts for better UX

## Technology Stack Migration

### Phase 0: Framework Migration (Priority: Critical)

#### 0.1 Migrate from Meow to Yargs

**Important Deno Considerations:**

- Yargs is available via deno.land/x: `https://deno.land/x/yargs@v18.0.0-deno/mod.ts`
- `commandDir()` does NOT work with Deno - use the index.ts pattern instead (see below)

Yargs provides significant advantages over meow:

- **Rich Command Architecture**: Built-in `.command()` API with builders and handlers
- **Automatic Help Generation**: Context-aware help with examples
- **Shell Completions**: Built-in support for bash/zsh/fish completions
- **Validation & Coercion**: `.check()`, `.coerce()`, `.choices()` for robust input handling
- **Configuration Support**: `.config()` for JSON/YAML config files
- **Environment Variables**: `.env()` for seamless env var integration
- **Middleware**: Process commands through common handlers
- **Async Support**: `.parseAsync()` for modern async/await patterns

```typescript
// Example migration
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const argv = yargs(hideBin(process.argv))
  .scriptName("atlas")
  .usage("$0 <command> [options]")
  .command(
    "workspace <action>",
    "Manage workspaces",
    (yargs) => {
      return yargs
        .positional("action", {
          describe: "Action to perform",
          choices: ["init", "serve", "status", "list"],
        })
        .option("detached", {
          alias: "d",
          type: "boolean",
          description: "Run in background",
        });
    },
    async (argv) => {
      // Handler logic
    },
  )
  .help()
  .alias("help", "h")
  .version()
  .alias("version", "v")
  .parse();
```

#### 0.1.1 Command Organization Pattern for Deno

Since `commandDir()` doesn't work with Deno, use the index.ts pattern to organize commands:

```typescript
// src/cli/commands/index.ts
import * as workspaceCmd from "./workspace/index.ts";
import * as sessionCmd from "./session/index.ts";
import * as signalCmd from "./signal/index.ts";
import * as agentCmd from "./agent/index.ts";

export const commands = [workspaceCmd, sessionCmd, signalCmd, agentCmd];

// src/cli/commands/workspace/index.ts
import * as init from "./init.ts";
import * as serve from "./serve.ts";
import * as status from "./status.ts";
import * as list from "./list.ts";

export const command = "workspace <action>";
export const desc = "Manage Atlas workspaces";
export const aliases = ["work", "w"];

export function builder(yargs: any) {
  return yargs
    .command([init, serve, status, list])
    .demandCommand(1, "You need to specify a workspace action");
}

export function handler(argv: any) {
  // This won't be called if a subcommand matches
}

// src/cli/commands/workspace/init.ts
export const command = "init [name]";
export const desc = "Initialize a new workspace";

export function builder(yargs: any) {
  return yargs.positional("name", {
    describe: "Workspace name",
    type: "string",
    default: "my-workspace",
  });
}

export async function handler(argv: any) {
  // Implementation using @clack/prompts
  const config = await p.group({
    // ... prompt configuration
  });
}

// src/cli.tsx - main entry point
import yargs from "https://deno.land/x/yargs@v18.0.0-deno/mod.ts";
import { hideBin } from "https://deno.land/x/yargs@v18.0.0-deno/helpers.ts";
import { commands } from "./cli/commands/index.ts";

const argv = await yargs(hideBin(Deno.args))
  .scriptName("atlas")
  .usage("$0 <command> [options]")
  .command(commands)
  .help()
  .alias("help", "h")
  .version()
  .alias("version", "v")
  .demandCommand(1, "You need to specify a command")
  .recommendCommands()
  .strict()
  .parseAsync();
```

This pattern provides:

- **Clear file organization**: Each command in its own file
- **Nested command support**: Subcommands organized in subdirectories
- **Type safety**: Full TypeScript support
- **Scalability**: Easy to add new commands
- **Deno compatibility**: Works without `commandDir()`

#### 0.2 Adopt @clack/prompts for Interactive Elements

Replace basic readline interactions with beautiful, consistent prompts:

- **Modern UI**: Pre-styled, minimal components
- **Rich Components**: text, confirm, select, multiselect, autocomplete
- **Progress Indicators**: Spinners and progress bars for long operations
- **Grouping**: Organize related prompts together
- **Cancellation**: Proper CTRL+C handling with cleanup

```typescript
// Example usage
import * as p from "@clack/prompts";

// Workspace initialization
const config = await p.group({
  name: () =>
    p.text({
      message: "What is your workspace name?",
      placeholder: "my-workspace",
      validate: (value) => {
        if (!value) return "Workspace name is required";
        if (!/^[a-z0-9-]+$/.test(value)) {
          return "Use lowercase letters, numbers, and hyphens";
        }
      },
    }),
  agents: () =>
    p.multiselect({
      message: "Select agents to include:",
      options: [
        { value: "llm", label: "LLM Agent", hint: "For AI-powered tasks" },
        {
          value: "github",
          label: "GitHub Agent",
          hint: "For repository operations",
        },
        { value: "tempest", label: "Tempest Agent", hint: "Built-in agent" },
      ],
    }),
  confirm: ({ results }) =>
    p.confirm({
      message: `Create workspace "${results.name}" with ${results.agents.length} agents?`,
    }),
});

// Progress indication
const s = p.spinner();
s.start("Starting workspace server...");
// ... actual work
s.stop("Workspace server running at http://localhost:8080");
```

## Improvement Plan

### Phase 1: Command Structure & Safety (Priority: High)

#### 1.1 Standardize Noun-Verb Structure

- **Current**: Mixed patterns (e.g., `atlas ps`, `atlas define <workspace>`)
- **Proposed**: Consistent resource-action pattern
  ```
  atlas workspace init|serve|status|list|stop|restart|remove
  atlas session list|get|cancel
  atlas signal list|trigger|history
  atlas agent list|describe|test
  ```

#### 1.2 Add Destructive Action Safeguards

- Add confirmation prompts for:
  - `workspace remove`
  - `session cancel`
  - Any operation that modifies workspace state
- Implement `--force` or `--yes` flags to bypass for scripting
- Add `--dry-run` support for complex operations

#### 1.3 Improve Command Aliases

- Keep existing shorthands but make them more discoverable
- Add hidden power-user shortcuts documentation
- Consider adding common typo corrections

### Phase 2: Output & Interactivity (Priority: High)

#### 2.1 Separate stdout/stderr

- Primary data output → stdout
- Errors, warnings, progress, logs → stderr
- Enable clean piping: `atlas session list | jq '.sessions[0].id'`

#### 2.2 Add Structured Output

- Implement `--json` flag for all list/get commands
- Ensure stable JSON schema across versions
- Add `--format` option for other formats (yaml, csv)
- Example:
  ```bash
  atlas workspace list --json
  atlas session get <id> --json
  atlas signal history --json --since "1 hour ago"
  ```

#### 2.3 Improve Progress Indicators

- Add spinners for indeterminate operations (workspace initialization)
- Add progress bars for determinate operations (logs streaming)
- Send all progress indicators to stderr
- Respect `NO_COLOR` environment variable

### Phase 3: Help & Error Experience (Priority: Medium)

#### 3.1 Contextual Help System

- Resource-specific help: `atlas workspace --help`
- Action-specific help: `atlas workspace serve --help`
- Add practical examples to all help text
- Show related commands

#### 3.2 Intelligent Error Messages

- Implement typo suggestions using Levenshtein distance
- Provide actionable error messages
- Example:

  ```
  $ atlas workspace sarve
  Error: 'sarve' is not a valid workspace command.

  Did you mean?
    serve    Start workspace server
    status   Show workspace status

  Run 'atlas workspace --help' for available commands.
  ```

#### 3.3 Enhanced Examples

- Add example section to help output
- Include common use cases
- Show command composition examples

### Phase 4: Configuration & Environment (Priority: Medium)

#### 4.1 XDG Base Directory Compliance

- Move configuration to `$XDG_CONFIG_HOME/atlas/`
- Move data to `$XDG_DATA_HOME/atlas/`
- Move logs to `$XDG_STATE_HOME/atlas/logs/`
- Maintain backward compatibility with deprecation warnings

#### 4.2 Configuration Precedence

- Establish clear hierarchy:
  1. Command-line flags
  2. Environment variables (`ATLAS_*`)
  3. Config file
  4. Defaults
- Document in help text

#### 4.3 Environment Variable Support

- Add environment variables for common flags:
  - `ATLAS_WORKSPACE`: Default workspace
  - `ATLAS_OUTPUT`: Default output format
  - `ATLAS_NO_COLOR`: Disable color output
  - `ATLAS_LOG_LEVEL`: Default log level

### Phase 5: Advanced Features (Priority: Low)

#### 5.1 Interactive Mode Enhancements

- Improve TUI with better keyboard navigation
- Add command palette (Ctrl+P)
- Implement search/filter in list views

#### 5.2 Shell Completions

- Generate completions for bash, zsh, fish
- Include dynamic completion for workspace names, session IDs
- Package with installation

#### 5.3 Pipe-Aware Behavior

- Detect TTY for output formatting
- Clean output when piped
- Structured data when redirected

## Implementation Checklist

### Immediate Actions (Week 1)

- [x] Set up Yargs and @clack/prompts dependencies
- [x] Create proof-of-concept migration for one command
- [x] Design command hierarchy with Yargs command builder pattern
- [x] Implement basic prompt flows with @clack/prompts
- [x] Add `--json` flag to list/get commands
- [x] Implement confirmation prompts for destructive actions
- [x] Separate stdout/stderr in output functions
- [ ] Add `--dry-run` support for workspace operations

### Short-term (Weeks 2-3)

- [x] Complete migration to Yargs command structure (core commands done)
- [x] Replace all readline prompts with @clack/prompts
- [ ] Implement shell completion generation
- [ ] Add middleware for common operations (workspace loading, auth)
- [x] Integrate Yargs validation and coercion throughout

### Medium-term (Weeks 4-6)

- [ ] Migrate to XDG directory structure
- [ ] Implement config file support with Yargs
- [ ] Create custom @clack/prompts themes if needed
- [ ] Build comprehensive example system
- [ ] Enhance TUI with @clack/prompts components

### Long-term (Month 2+)

- [ ] Create command composition examples
- [ ] Implement pipe-aware formatting
- [ ] Add advanced TUI features
- [ ] Create comprehensive CLI testing framework

## Success Metrics

1. **User Experience**

   - Time to accomplish common tasks reduced by 50%
   - Error messages lead to successful resolution >80% of the time
   - New users can start using Atlas within 5 minutes

2. **Scriptability**

   - All data-returning commands support JSON output
   - Exit codes properly indicate success/failure
   - Machine-readable output remains stable across minor versions

3. **Safety**
   - Zero accidental data loss due to missing confirmations
   - Dry-run mode prevents configuration errors
   - Clear audit trail for all destructive operations

## Migration Guide

For existing users, we'll provide:

1. Clear deprecation warnings for changed commands
2. Automatic migration for configuration files
3. Compatibility aliases for 2 major versions
4. Comprehensive changelog with migration instructions

## Example: Improved CLI Flow with New Stack

### Current Flow

```bash
$ atlas work
$ atlas sig telephone-message --data '{"message": "Hello"}'
$ atlas ps
$ atlas logs sess_abc123
```

### Improved Flow with Yargs + @clack/prompts

```bash
# Yargs provides better help and command discovery
$ atlas workspace --help
Manage Atlas workspaces

Commands:
  atlas workspace init [name]     Initialize a new workspace
  atlas workspace serve           Start workspace server
  atlas workspace status [name]   Show workspace status
  atlas workspace list            List all workspaces

Options:
  -h, --help     Show help                                            [boolean]
  -v, --version  Show version number                                  [boolean]

Examples:
  atlas workspace init my-project    Create a new workspace
  atlas workspace serve -d           Start server in background

# Interactive workspace initialization with @clack/prompts
$ atlas workspace init
┌  Atlas Workspace Setup
│
◇  What is your workspace name?
│  my-assistant
│
◇  Select agents to include:
│  ◻ LLM Agent (For AI-powered tasks)
│  ◼ GitHub Agent (For repository operations)
│  ◼ Tempest Agent (Built-in agent)
│
◇  Configure signal triggers?
│  Yes
│
◇  Select trigger types:
│  ◼ HTTP Webhook
│  ◻ GitHub Events
│  ◼ Manual CLI
│
◇  Create workspace "my-assistant" with 2 agents and 2 triggers?
│  Yes
│
◇  Workspace created successfully!
│
└  Run 'atlas workspace serve' to start

# Progress indication for long operations
$ atlas workspace serve
◒ Starting workspace server...
✔ Workspace server running at http://localhost:8080

# Interactive signal triggering
$ atlas signal trigger
┌  Trigger Signal
│
◇  Select signal to trigger:
│  ● telephone-message
│  ○ github-webhook
│  ○ manual-task
│
◇  Enter message:
│  Hello, world!
│
◇  Additional options?
│  No
│
└  Signal triggered! Session: sess_abc123

# Beautiful task execution
$ atlas workspace health-check
┌  Running health checks
│
◇  Checking workspace configuration... ✔
◇  Validating agents... ✔
◇  Testing signal handlers... ✔
◇  Verifying database connection... ✔
│
└  All systems operational!
```

## Architecture Benefits

### Yargs Architecture Advantages

1. **Command Hierarchy**: Natural command organization with builders
2. **Validation Pipeline**: Input validation happens before execution
3. **Middleware System**: Common operations (auth, loading) in one place
4. **Configuration Cascade**: CLI flags → env vars → config files → defaults
5. **Type Safety**: Full TypeScript support with inferred types

### @clack/prompts Benefits

1. **Consistent UI**: All prompts follow the same design language
2. **Better UX**: Progress indication, grouping, and cancellation
3. **Smaller Bundle**: 80% smaller than alternatives
4. **Modern API**: Promise-based with proper async support
5. **Accessibility**: Clear visual hierarchy and keyboard navigation

## Migration Strategy

### Phase 1: Parallel Implementation

- Keep existing meow implementation
- Build new Yargs structure alongside
- Use feature flags to switch between implementations

### Phase 2: Gradual Rollout

- Enable new implementation for beta users
- Gather feedback and iterate
- Update documentation with new examples

### Phase 3: Full Migration

- Switch all users to new implementation
- Remove meow and old prompt code
- Publish migration guide for plugin authors

## Conclusion

This improvement plan addresses the major UX issues in the Atlas CLI while adopting modern,
battle-tested CLI frameworks. The phased approach allows for incremental improvements without
disrupting existing users.

The key principles guiding these improvements are:

1. **Modern Stack**: Leverage Yargs and @clack/prompts for better UX
2. **Predictability**: Consistent patterns across all commands
3. **Safety**: Protect users from destructive mistakes with confirmations
4. **Composability**: Work well with Unix pipes and scripts
5. **Discoverability**: Help users find what they need quickly
6. **Beauty**: Delight users with beautiful, minimal UI
7. **Clarity**: Clear, actionable output and error messages

By implementing these changes with Yargs and @clack/prompts, Atlas will become a best-in-class CLI
tool that developers love to use both interactively and in automation.

## Implementation Progress Tracker

### Summary of Completed Work

We have successfully migrated the core Atlas CLI commands from Meow to Yargs with @clack/prompts
integration:

- ✅ **Framework Migration**: Complete transition to Yargs with parallel CLI structure
- ✅ **Core Commands**: All major command groups (workspace, session, agent, signal) migrated
- ✅ **Interactive Prompts**: @clack/prompts integrated for beautiful user interactions
- ✅ **JSON Support**: All data commands support `--json` flag for scripting
- ✅ **Safety Features**: Confirmation prompts for destructive operations
- ✅ **Modern UX**: Ink rendering for display commands, spinners for progress indication
- ✅ **Cross-Directory Support**: All commands work from any directory with `--workspace` flag

### Phase 0: Framework Migration

- [x] Set up Yargs dependency in deno.json
- [x] Create new CLI entry point (src/cli-2.tsx) with Yargs
- [x] Implement parallel CLI structure (cli.tsx and cli-2.tsx)
- [x] Create command organization pattern without commandDir
- [x] Implement version command using Yargs pattern
- [x] Support --version and -v flags globally
- [x] Add --json support to all version outputs
- [x] Update deno tasks (atlas points to new CLI, atlas-old for legacy)
- [x] Add @clack/prompts dependency
- [x] Create first interactive prompt example (workspace init)

### Phase 1: Command Structure & Safety

#### 1.1 Standardize Noun-Verb Structure

- [x] Migrate workspace commands (init, serve, status, list, stop, restart, remove)
  - [x] workspace init - Interactive workspace creation with @clack/prompts
  - [x] workspace list - List all workspaces with JSON support
  - [x] workspace status - Show detailed workspace status with JSON support
  - [x] workspace serve - Start workspace server with detached mode
  - [x] workspace stop - Stop running workspaces
  - [x] workspace restart - Restart workspace servers
  - [x] workspace remove - Remove workspaces with confirmation prompts
- [x] Migrate session commands (list, get, cancel)
  - [x] session list - List active sessions with JSON support and Ink rendering
  - [x] session get - Get session details with JSON support and Ink rendering
  - [x] session cancel - Cancel running sessions with confirmation prompts
  - [x] ps command - Alias for session list
- [x] Migrate signal commands (list, trigger, history)
  - [x] signal list - List configured signals with JSON support and Ink rendering
  - [x] signal trigger - Trigger signals with interactive data prompt and progress indicator
  - [x] signal history - Show signal history (placeholder implementation)
- [x] Migrate agent commands (list, describe, test)
  - [x] agent list - List workspace agents with JSON support and Ink rendering
  - [x] agent describe - Show agent details with JSON support and Ink rendering
  - [x] agent test - Test agents with interactive prompts (placeholder implementation)
- [x] Migrate library commands
  - [x] library list - List library items with JSON support and Ink rendering
  - [x] library search - Search library content with JSON support
  - [x] library get - Get item details with content option and JSON support
  - [x] library templates - List available templates with JSON support
  - [x] library generate - Generate content from templates with store option
  - [x] library stats - Show library statistics with JSON support
- [x] Migrate logs commands (not in original plan but needed)
  - [x] logs - View session logs with follow, tail, and filter options
  - [x] log alias - Alias for logs command
- [x] Update all command aliases and shorthands
  - [x] workspace → work, w
  - [x] session → sesh, sess
  - [x] signal → sig
  - [x] agent → ag
  - [x] library → lib (new)
  - [x] logs → log
  - [x] ps command for session list

#### 1.2 Add Destructive Action Safeguards

- [x] Implement confirmation prompts for workspace remove
- [x] Implement confirmation prompts for session cancel
- [x] Add --force/--yes flags for scripting
- [ ] Implement --dry-run for complex operations
- [x] Create shared confirmation utility

#### 1.3 Improve Command Aliases

- [ ] Document all shorthands in help text
- [ ] Add typo correction suggestions
- [ ] Create power-user documentation

### Phase 2: Output & Interactivity

#### 2.1 Separate stdout/stderr

- [x] Create output utility functions
- [x] Route data output to stdout
- [x] Route errors/progress to stderr
- [ ] Test pipe compatibility

#### 2.2 Add Structured Output

- [x] Implement --json flag for workspace commands
  - [x] workspace list - JSON output with full workspace details
  - [x] workspace status - JSON output with health and config data
  - [x] version command - JSON output for version info
- [x] Implement --json flag for session commands
  - [x] session list - JSON output with session array and count
  - [x] session get - JSON output with full session details
- [x] Implement --json flag for signal commands
  - [x] signal list - JSON output with workspace info and signal array
  - [x] signal trigger - JSON output with trigger result and session ID
  - [x] signal history - JSON output with placeholder data
- [x] Implement --json flag for agent commands
  - [x] agent list - JSON output with workspace info and agent array
  - [x] agent describe - JSON output with full agent configuration
  - [x] agent test - JSON output with test result placeholder
- [ ] Define stable JSON schemas
- [ ] Add --format flag for yaml/csv

#### 2.3 Improve Progress Indicators

- [x] Add spinner component using @clack/prompts
- [ ] Add progress bar component
- [x] Implement NO_COLOR support (partial - checking env vars)
- [x] Add progress to long-running operations (workspace serve, stop, restart)

### Phase 3: Help & Error Experience

#### 3.1 Contextual Help System

- [ ] Add examples to all command help
- [ ] Implement resource-specific help
- [ ] Add "see also" sections
- [ ] Create getting started guide

#### 3.2 Intelligent Error Messages

- [ ] Implement Levenshtein distance for suggestions
- [ ] Add actionable error messages
- [ ] Create error message guidelines
- [ ] Add common troubleshooting tips

#### 3.3 Enhanced Examples

- [ ] Add examples to each command
- [ ] Create cookbook of common workflows
- [ ] Add interactive tutorials

### Phase 4: Configuration & Environment

#### 4.1 XDG Base Directory Compliance

- [ ] Implement XDG directory detection
- [ ] Migrate config to $XDG_CONFIG_HOME/atlas/
- [ ] Migrate data to $XDG_DATA_HOME/atlas/
- [ ] Migrate logs to $XDG_STATE_HOME/atlas/logs/
- [ ] Add migration for existing installations

#### 4.2 Configuration Precedence

- [ ] Implement config file loading with Yargs
- [ ] Document precedence in help
- [ ] Add config validation
- [ ] Create config init command

#### 4.3 Environment Variable Support

- [ ] Add ATLAS_WORKSPACE support
- [ ] Add ATLAS_OUTPUT support
- [ ] Add ATLAS_NO_COLOR support
- [ ] Add ATLAS_LOG_LEVEL support
- [ ] Document all env vars

### Phase 5: Advanced Features

#### 5.1 Interactive Mode Enhancements

- [ ] Improve TUI with @clack/prompts
- [ ] Add command palette
- [ ] Implement search/filter in lists
- [ ] Add keyboard shortcuts

#### 5.2 Shell Completions

- [ ] Generate bash completions
- [ ] Generate zsh completions
- [ ] Generate fish completions
- [ ] Add dynamic completion for IDs
- [ ] Create installation instructions

#### 5.3 Pipe-Aware Behavior

- [ ] Implement TTY detection
- [ ] Add clean output when piped
- [ ] Format structured data for pipes
- [ ] Test with common tools (jq, grep, awk)

### Migration & Documentation

- [ ] Create migration guide from old to new CLI
- [ ] Update all documentation
- [ ] Create video tutorials
- [ ] Add deprecation warnings to old commands
- [ ] Create automated migration script
- [ ] Test backward compatibility

### Testing & Quality

- [ ] Create comprehensive test suite
- [ ] Add integration tests
- [ ] Test all command combinations
- [ ] Performance benchmarking
- [ ] User acceptance testing

### Notes

- Commands should be migrated incrementally to minimize disruption
- Keep both CLIs functional during migration period
- Gather user feedback after each phase
- Prioritize most-used commands first

### Guiding Philosophy

A great Command-Line Interface (CLI) is a good citizen of the shell. It's predictable, composable
(works with pipes and other tools), and serves both human users and automation scripts. It should be
helpful, not hostile.

---

### 1. Command-Line Arguments

#### **Practice: Support both long and short flags.**

This caters to both interactive use (short) and script readability (long).

- **Do:** `my-app --verbose` and `my-app -v`
- **Don't:** `my-app -verbose` (mixing styles) or only providing one form.

#### **Practice: Allow combining short, non-argument flags.**

This is a standard convention that saves typing.

- **Do:** `tar -xvf archive.tar` is the same as `tar -x -v -f archive.tar`
- **Don't:** Require users to type `rm -r -f my-dir/`, failing on `rm -rf my-dir/`.

#### **Practice: Use `--` to stop parsing flags.**

This is essential for handling arguments that look like flags (e.g., filenames starting with a
dash).

- **Do:** `grep -- '--version' my-file.txt` (This searches for the literal string `--version`).
- **Don't:** `grep '--version' my-file.txt` (This would likely interpret `--version` as a flag for
  the grep command itself).

#### **Practice: Be helpful with typos and unknown commands.**

Suggest corrections instead of just failing.

- **Do:**

  ```
  $ git stauts
  git: 'stauts' is not a git command. See 'git --help'.

  Did you mean this?
      status
  ```

- **Don't:**
  ```
  $ git stauts
  Error: unknown command 'stauts'
  ```

#### **Practice: Clearly distinguish between subcommands, flags, and arguments.**

Use a subcommand structure for different actions.

- **Do:** `docker image prune --force` (Subcommand `image`, sub-subcommand `prune`, flag `--force`).
- **Don't:** `docker --prune-image --force` (Using flags to specify a primary action is confusing).

### 2. Standard Streams (stdin, stdout, stderr)

#### **Practice: Separate primary output from diagnostic messages.**

Send successful data output to `stdout`. Send errors, prompts, progress bars, and logs to `stderr`.
This makes your tool "pipe-friendly."

- **Do:**
  ```bash
  # Only the list of files goes into output.txt. Errors are shown on screen.
  find /etc -name "*.conf" > output.txt
  ```
- **Don't:** Print error messages (e.g., "Permission Denied") to `stdout`. This corrupts the data
  when a user tries to pipe or redirect it.

#### **Practice: Support piped input via `stdin`.**

A good CLI should be able to act on data coming from another command.

- **Do:** `cat data.json | jq '.items | length'` (`jq` reads from stdin).
- **Don't:** Force the user to always provide a filename, making pipes impossible.

#### **Practice: Be "pipe-aware" when formatting output.**

Detect if `stdout` is a terminal (tty). If it is, you can add colors, spinners, and tables. If it's
being piped to another process or file, output clean, unformatted data.

- **Do:** `ls` in a terminal shows colored, multi-column output. `ls | cat` shows a simple,
  single-column list without color.
- **Don't:** Always output ANSI color codes and progress bars, which become garbage characters in a
  redirected file (`my-app > out.log`).

### 3. Exit Codes

#### **Practice: Use exit codes to signal status.**

This is the primary way for scripts to know if your command succeeded or failed.

- **`0`**: Success.
- **`1-255`**: Failure.

- **Do:**
  ```bash
  # grep returns 0 on match, 1 on no match, >1 on error.
  if grep "ERROR" server.log; then
    echo "Errors found!"
  fi
  ```
- **Don't:** Always exit with `0`, even when an error occurs. This breaks all scripting and
  automation.

#### **Practice: Use specific exit codes for different error types.**

This allows scripts to handle different failure modes intelligently.

- **Do:** `curl` uses `6` for "Could not resolve host" and `7` for "Failed to connect to host." A
  script could retry on `7` but fail immediately on `6`.
- **Don't:** Use a generic exit code of `1` for every possible failure, from "file not found" to
  "network timeout".

### 4. Color and Formatting

#### **Practice: Use color to improve readability, not just for decoration.**

Highlight important information like errors (red), warnings (yellow), and successes (green).

- **Do:** `git status` uses red for unstaged changes and green for staged changes.
- **Don't:** Use random colors that have no semantic meaning, making the output confusing.

#### **Practice: Respect the user's environment.**

Obey the `NO_COLOR` environment variable. If it's set, disable all color output.

- **Do:** Check `if os.getenv("NO_COLOR")` before adding ANSI escape codes.
- **Don't:** Ignore `NO_COLOR` and force color on the user.

#### **Practice: Provide a flag to control color.**

Allow users to force or disable color explicitly.

- **Do:** `my-app --color=always | less -R` (Forces color for tools that can render it).
  `my-app --color=never` (Disables color).
- **Don't:** Have no manual override, making the tool's behavior entirely dependent on tty
  detection.

### 5. Interactivity

#### **Practice: Enhance the experience in interactive terminals.**

Use spinners for long-running, indeterminate tasks and progress bars for tasks with a clear
completion point. Send these to `stderr`.

- **Do:** `npm install` shows a spinner while resolving dependencies. `wget` shows a progress bar
  and ETA during a download.
- **Don't:** Print nothing for 2 minutes and then suddenly finish, leaving the user wondering if the
  app has frozen. Also, don't print spinners/bars to `stdout`.

#### **Practice: Handle `Ctrl+C` (SIGINT) gracefully.**

Don't just crash. Clean up temporary files or restore the terminal state if you've modified it.

- **Do:** A tool that disables the terminal cursor for a prompt should have a signal handler that
  re-enables it on exit.
- **Don't:** Leave a user's terminal in a broken state (e.g., cursor invisible, colors messed up)
  after being interrupted.

### 6. Human-Readable Output

#### **Practice: Make output easily scannable.**

Use tables, alignment, and clear headings.

- **Do:** `df -h` uses aligned columns for `Filesystem`, `Size`, `Used`, `Avail`, `Use%`, making it
  easy to read.
- **Don't:** Print a long, jumbled string of text:
  `Filesystem:/dev/sda1 Size:20G Used:15G Avail:5G Use%:75%`.

#### **Practice: Use human-friendly formats.**

Display sizes in KB/MB/GB and times as relative dates.

- **Do:** "5 minutes ago" is more helpful than `2023-10-27T10:55:00Z`. `1.5M` is easier to parse
  than `1572864`.
- **Don't:** Force the user to mentally calculate conversions from bytes or parse ISO 8601
  timestamps for a quick glance.

#### **Practice: Provide a `--verbose` flag for more detail.**

Default to showing the most important information. Hide debugging or less critical info behind a
verbose flag.

- **Do:** `ssh user@host` is silent on success. `ssh -v user@host` shows the entire handshake and
  negotiation process.
- **Don't:** Dump pages of debug logs by default, overwhelming the user.

### 7. Machine-Readable Output

#### **Practice: Provide a structured output flag (e.g., `--json`, `--yaml`).**

This is the single most important practice for making a CLI scriptable.

- **Do:** `kubectl get pods -o json` outputs a JSON object describing the pods, which can be piped
  directly to `jq`.
- **Don't:** Force scripters to use `grep`, `sed`, and `awk` to parse your human-readable table
  output, which is brittle and will break if you change the formatting.

#### **Practice: Keep machine-readable output stable.**

Consider your JSON/YAML output a public API. Avoid making breaking changes (e.g., renaming fields,
changing data structures) between minor versions.

- **Do:** Add a _new_ field `apiVersion: v2` to your JSON if you must introduce breaking changes,
  while keeping the old format available.
- **Don't:** Rename `{"name": "foo"}` to `{"containerName": "foo"}` in a patch release, breaking
  countless user scripts.

### 8. Configuration

#### **Practice: Follow the XDG Base Directory Specification.**

Store configuration, data, and cache files in standard, predictable locations.

- **Do:** Place config in `$XDG_CONFIG_HOME/my-app/` (defaulting to `~/.config/my-app/`). Place data
  in `$XDG_DATA_HOME/my-app/`.
- **Don't:** Clutter the user's home directory with dotfiles like `~/.myapprc`.

#### **Practice: Support configuration via environment variables.**

This is crucial for CI/CD environments and containers where modifying files is difficult.

- **Do:** Allow setting `MYAPP_API_KEY=...` instead of only reading it from a config file.
- **Don't:** Hardcode configuration or only allow file-based configuration.

#### **Practice: Document the configuration precedence.**

Clearly state the order of priority. The standard is: **Command-line Flags > Environment Variables >
Config File > Defaults.**

- **Do:** In your help text: "The API key can be set via the `--api-key` flag, the `MYAPP_API_KEY`
  environment variable, or in `~/.config/myapp/config.toml`, in that order of precedence."
- **Don't:** Leave the user guessing which method will override another.

### 9. Help and Usage

#### **Practice: Provide excellent help with `-h` and `--help`.**

This is a user's first point of contact. It should be comprehensive and well-formatted.

- **Do:** Include a short description, a `USAGE` synopsis, and detailed explanations of all flags
  and subcommands.
- **Don't:** Print a single, unhelpful line: `usage: my-app [-v] <file>`.

#### **Practice: Include practical examples.**

Show, don't just tell. Examples are often more valuable than lengthy descriptions.

- **Do:** In `tar --help`, show common use cases:

  ```
  Examples:
    # Create an archive from files:
    tar -cf archive.tar file1 file2

    # Extract an archive in the current directory:
    tar -xf archive.tar
  ```

- **Don't:** Only explain what each flag does in isolation, leaving the user to figure out how to
  combine them.

### 10. Naming, Installation, and Other Considerations

#### **Practice: Choose a good name.**

It should be short, memorable, easy to type, and ideally unique to avoid conflicts.

- **Do:** `git`, `curl`, `jq`.
- **Don't:** `my-awesome-enterprise-grade-data-processing-utility-cli`.

#### **Practice: Offer simple installation.**

Provide binaries for major OSes, packages for common managers (Homebrew, apt, etc.), and a simple
download script.

- **Do:** "Install with `brew install my-app` or download a binary from our Releases page."
- **Don't:** "First, install these 15 dependencies from source, then clone our repo, and run the
  `build-and-install-from-scratch.sh` script."

#### **Practice: Avoid requiring `sudo` for installation and operation.**

Requiring root privileges is a security risk and a barrier to entry. Install user-local binaries and
use XDG directories.

- **Do:** An install script that places the binary in `/usr/local/bin` or `~/.local/bin`.
- **Don't:** An install script that requires `sudo` to sprinkle files all over the system root.

# Actionable Best Practices for CLI Application UX

This guide synthesizes best practices from [clig.dev](https://clig.dev/) and the article
[User Experience, CLIs, and Breaking the World](https://uxdesign.cc/user-experience-clis-and-breaking-the-world-baed8709244f).
The primary philosophy is that a great CLI is a good citizen of the shell: predictable, composable,
safe, and helpful to both humans and scripts.

## 1. Command, Subcommand, and Argument Design

This is the most critical aspect of your CLI's architecture. A logical structure prevents user error
and makes the tool intuitive.

### Practice: Prefer a Noun-Verb structure for commands.

Structure your commands as `[noun] [verb]` (or `[resource] [action]`). The user first specifies
_what_ they are working with, then _what they want to do_ to it. This reduces the risk of
catastrophic typos with destructive commands and makes the CLI more scalable and self-documenting.

- **Do:** `docker container prune`, `aws s3 ls`, `gcloud compute instances list`

  > The user specifies the context (`container`, `s3`) before the action (`prune`, `ls`). Typing
  > `docker container --help` can list all possible actions for containers.

- **Don't:** `prune-docker-containers`, `delete-server my-prod-db`
  > This Verb-Noun structure is dangerous. A user intending to type `get-server my-prod-db` might
  > accidentally type `del` and hit enter before realizing their mistake.

### Practice: Confirm destructive actions.

For any command that deletes, overwrites, or otherwise causes an irreversible loss of data, prompt
the user for confirmation. Send the prompt to `stderr`.

- **Do:**

  ```bash
  $ my-app db delete production-db
  > Are you sure you want to delete the 'production-db' database? This action cannot be undone. [y/N]
  ```

  Also, provide a flag to bypass this for scripting. `$ my-app db delete production-db --force` or
  `--yes`

- **Don't:** Immediately delete the database upon command execution. A simple typo could lead to
  disaster.

### Practice: Provide a "dry run" mode for complex or destructive actions.

A `--dry-run` flag shows the user exactly what a command _would do_ without actually doing it. This
builds confidence and is invaluable for testing automation scripts.

- **Do:**

  ```bash
  $ my-app deploy --environment production --dry-run
  > -- DRY RUN --
  > Would connect to production-cluster.
  > Would apply 'deployment.yaml'.
  > Would scale replicas to 5.
  > -- END DRY RUN --
  ```

- **Don't:** Force users to run a dangerous command to see if their parameters are correct.

### Practice: Support both long and short flags.

This caters to interactive use (short, fast) and script readability (long, explicit).

- **Do:** `my-app --verbose` and `my-app -v`
- **Don't:** `my-app -verbose` (mixing styles) or only providing one form.

### Practice: Allow combining short, non-argument flags.

This is a standard POSIX convention that saves typing.

- **Do:** `tar -xvf archive.tar` (same as `tar -x -v -f archive.tar`)
- **Don't:** Require users to type `rm -r -f my-dir/`, failing on the standard `rm -rf my-dir/`.

### Practice: Use `--` to stop parsing flags.

This is the standard, unambiguous way to handle positional arguments that look like flags (e.g.,
filenames starting with a dash).

- **Do:** `grep -- '--version' my-file.txt` (searches for the literal string `--version`)
- **Don't:** `grep '--version' my-file.txt` (which would likely interpret `--version` as a flag for
  grep itself).

### Practice: Be helpful with typos and unknown commands.

Instead of just failing, suggest corrections based on what the user might have meant.

- **Do:**

  ```
  $ git stauts
  git: 'stauts' is not a git command. See 'git --help'.

  Did you mean this?
      status
  ```

- **Don't:**
  ```
  $ git stauts
  Error: unknown command 'stauts' for "git"
  ```

## 2. Standard Streams (stdin, stdout, stderr)

### Practice: Separate primary output from all other messages.

- **`stdout` (standard output):** For successful data output only. This is the "result" of the
  command.
- **`stderr` (standard error):** For everything else: errors, warnings, prompts, progress bars,
  spinners, and logs (`--verbose` output).

This makes your tool "pipe-friendly," allowing users to redirect the clean data output while still
seeing diagnostic messages in their terminal.

- **Do:**
  ```bash
  # Only the list of files goes into output.txt. Errors are shown on screen.
  find /etc -name "*.conf" > output.txt
  ```
- **Don't:** Print error messages (e.g., "Permission Denied") to `stdout`. This corrupts the data
  when a user tries to pipe or redirect it.

### Practice: Support piped input via `stdin`.

A good CLI should be able to act on data coming from another command, not just from file arguments.

- **Do:** `cat data.json | jq '.items | length'` (`jq` reads from stdin).
- **Don't:** Force the user to always provide a filename, making pipes impossible.

### Practice: Be "pipe-aware" when formatting output.

Detect if `stdout` is a terminal (a "tty").

- **If it's a terminal:** Enhance the output with colors, tables, spinners, etc.
- **If it's a pipe/file:** Output clean, unformatted data suitable for scripting.

- **Do:** `ls` in a terminal shows colored columns. `ls | cat` shows a simple, single-column list.
- **Don't:** Always output ANSI color codes and progress bars, which become garbage characters in a
  redirected file (`my-app > out.log`).

## 3. Help and Usage

### Practice: Provide excellent help with `-h` and `--help`.

This is often a user's first interaction with your tool. It should be comprehensive and
well-formatted. Use it to showcase your Noun-Verb design.

- **Do:** `my-app server --help` should list all actions (verbs) available for the `server`
  resource.

  ```
  USAGE:
    my-app server <COMMAND>

  COMMANDS:
    list      List all servers
    create    Create a new server
    delete    Delete a server
    reboot    Reboot a server
  ```

- **Don't:** Have a single, massive `--help` output that lists every possible command and flag in
  one overwhelming block.

### Practice: Include practical examples in your help text.

Show, don't just tell. Examples are often more valuable than lengthy descriptions of individual
flags.

- **Do:**

  ```
  Examples:
    # Create an archive from files:
    tar -cf archive.tar file1 file2

    # Extract an archive in the current directory:
    tar -xf archive.tar
  ```

- **Don't:** Only explain what each flag does in isolation, leaving the user to figure out how to
  combine them effectively.

## 4. Exit Codes

### Practice: Use exit codes to signal status.

This is the primary way for scripts to know if your command succeeded or failed.

- **`0`**: Success.
- **`1-255`**: Failure.

- **Do:**
  ```bash
  if my-app build; then
    echo "Build succeeded!"
  else
    echo "Build failed with exit code $?."
  fi
  ```
- **Don't:** Always exit with `0`, even when an error occurs. This breaks all scripting and
  automation.

### Practice: Use specific exit codes for different error types.

This allows scripts to handle different failure modes intelligently.

- **Do:** Use exit code `2` for "File Not Found" and `3` for "Permission Denied".
- **Don't:** Use a generic exit code of `1` for every possible failure.

## 5. Output and Interactivity

### Practice: Use color to improve readability, not for decoration.

Highlight important information: errors (red), warnings (yellow), success (green), hints (cyan).

- **Do:** `git status` uses red for unstaged changes and green for staged changes.
- **Don't:** Use random colors that have no semantic meaning.
- **Do:** Respect the `NO_COLOR` environment variable. If it's set, disable all color.
- **Do:** Provide a flag to control color, e.g., `--color=always|never|auto`.

### Practice: Use progress indicators for long-running tasks.

Use spinners (for indeterminate time) and progress bars (for determinate tasks) to show the app is
working. **Always print these to `stderr`**.

- **Do:** `npm install` shows a spinner; `wget` shows a progress bar.
- **Don't:** Print nothing for 2 minutes and then suddenly finish, leaving the user wondering if the
  app has frozen.

## 6. Machine-Readable Output

### Practice: Provide a structured output flag (e.g., `--json`).

This is essential for making a CLI usable in scripts.

- **Do:** `kubectl get pods -o json | jq '.items[0].metadata.name'`
- **Don't:** Force scripters to use `grep`, `sed`, and `awk` to parse your human-readable table
  output. This is brittle and will break as soon as you change the table formatting.

### Practice: Keep machine-readable output stable.

Treat your JSON/YAML output as a public API. Avoid making breaking changes (renaming fields,
changing data structures) between minor versions.

## 7. Configuration

### Practice: Follow the XDG Base Directory Specification.

Don't clutter the user's home directory.

- **Config:** `$XDG_CONFIG_HOME/my-app/` (defaults to `~/.config/my-app/`)
- **Data:** `$XDG_DATA_HOME/my-app/` (defaults to `~/.local/share/my-app/`)
- **Cache:** `$XDG_CACHE_HOME/my-app/` (defaults to `~/.cache/my-app/`)

### Practice: Define a clear order of configuration precedence.

The standard is: **Command-line Flags > Environment Variables > Config File > Defaults.** Document
this clearly in your help text.

- **Do:** Allow setting `MYAPP_API_KEY=...` in a CI environment to override a key set in a config
  file.
- **Don't:** Leave the user guessing which method will take priority.

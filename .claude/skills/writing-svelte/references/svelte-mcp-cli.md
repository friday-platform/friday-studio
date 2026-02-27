# Svelte MCP CLI Tools

`@sveltejs/mcp` provides CLI tools for looking up Svelte 5 docs and analyzing
components. Run via `npx` from the terminal.

## List Documentation Sections

```bash
npx @sveltejs/mcp list-sections
```

Lists all available Svelte 5 and SvelteKit documentation sections with titles
and paths.

## Get Documentation

```bash
npx @sveltejs/mcp get-documentation "<section1>,<section2>,..."
```

Retrieves full documentation for specified sections. Use after `list-sections`
to fetch relevant docs.

**Example:**

```bash
npx @sveltejs/mcp get-documentation "\$state,\$derived,\$effect"
```

## Svelte Autofixer

```bash
npx @sveltejs/mcp svelte-autofixer "<code_or_path>" [options]
```

Analyzes Svelte code and suggests fixes for common issues.

**Options:**

- `--async` — enable async Svelte mode (default: false)
- `--svelte-version` — target version: 4 or 5 (default: 5)

**Examples:**

```bash
# Analyze a file
npx @sveltejs/mcp svelte-autofixer ./src/lib/Component.svelte

# Analyze inline code (escape $ as \$)
npx @sveltejs/mcp svelte-autofixer '<script>let count = \$state(0);</script>'

# Target Svelte 4
npx @sveltejs/mcp svelte-autofixer ./Component.svelte --svelte-version 4
```

**Important:** When passing code with runes (`$state`, `$derived`, etc.) via the
terminal, escape `$` as `\$` to prevent shell variable substitution.

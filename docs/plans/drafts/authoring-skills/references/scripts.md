# Scripts in skills

Bundle reusable logic as scripts in `scripts/` when the agent would otherwise reinvent it each run.

## Contents

- When to bundle a script
- Execute vs read intent
- Solve, don't punt
- Justify every constant
- Declare dependencies
- Path conventions
- MCP tool references
- Example script layout

## When to bundle

If the agent independently reinvents the same logic across multiple runs — building a chart, parsing a format, validating output — that is the signal to write the script once.

Advantages:

- More reliable than generated code.
- Saves tokens: the script body does not enter the context window, only its output.
- Saves time: no regeneration cost each run.
- Consistent behaviour across runs.

## Execute vs read

Make the intent explicit in SKILL.md.

Execute (the common case):

```markdown
Run `scripts/analyze_form.py` to extract fields.
```

Read as reference (rare):

```markdown
See `scripts/analyze_form.py` for the extraction algorithm.
```

Ambiguity wastes tokens: the agent reads the whole file when it should have invoked it, or invokes a file that was meant as reference.

## Solve, don't punt

Handle error conditions in the script rather than raising and hoping the agent recovers.

Good:

```python
def process_file(path):
    """Return file contents; create an empty file if missing."""
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        print(f"File {path} missing; creating empty.")
        with open(path, "w") as f:
            f.write("")
        return ""
    except PermissionError:
        print(f"Cannot access {path}; using empty default.")
        return ""
```

Bad:

```python
def process_file(path):
    return open(path).read()   # raises; agent has to figure it out
```

The agent sees only the script's output. A traceback is harder to recover from than a single line of structured output.

## Justify every constant

No voodoo numbers. Every configuration value should explain *why* it exists. If you can't name a reason, neither can the agent.

Good:

```python
# HTTP requests typically complete within 30 seconds.
# The longer timeout covers slow remote hosts on retry.
REQUEST_TIMEOUT = 30

# Three retries balances reliability against latency.
# Most intermittent failures clear by the second retry.
MAX_RETRIES = 3
```

Bad:

```python
TIMEOUT = 47   # why 47?
RETRIES = 5    # why 5?
```

This is Ousterhout's rule: if the script does not know the right value, the agent reading it cannot either.

## Declare dependencies

Do not assume packages are installed. State the install step in SKILL.md.

```markdown
Install:

```bash
pip install pypdf
```

Then run:

```bash
python scripts/extract_pdf.py input.pdf
```
```

On the Claude API, the code execution environment has no network access — packages cannot be installed at runtime. List every required package in SKILL.md and confirm it's available before shipping.

## Paths

Forward slashes only. Unix-style paths work on every platform.

- `scripts/helper.py` ✓
- `scripts\helper.py` ✗

The same rule applies to path strings inside scripts — always use `pathlib.Path` or forward slashes.

## MCP tool references

When a skill references a Model Context Protocol tool, use the fully qualified name:

```
ServerName:tool_name
```

Example:

```markdown
Use `BigQuery:bigquery_schema` to retrieve table schemas.
Use `GitHub:create_issue` to file issues.
```

Unprefixed names fail to resolve when multiple MCP servers expose similarly named tools.

## Example layout

```
my-skill/
├── SKILL.md                   # main instructions (loaded when triggered)
├── references/
│   ├── schema.md              # field-by-field reference (loaded on demand)
│   └── examples.md            # worked examples (loaded on demand)
└── scripts/
    ├── analyze.py             # executed, not loaded into context
    ├── validate.py            # executed
    └── emit.py                # executed
```

Reference files and scripts sit next to `SKILL.md`. Scripts are invoked by command; references are read by path. Keep reference depth = 1 from `SKILL.md`.

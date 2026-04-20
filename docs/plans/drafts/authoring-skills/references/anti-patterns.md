# Anti-patterns

Things that consistently make skills fail. Quick reference; every entry has a reason the failure mode exists.

## Contents

- Content anti-patterns
- Structure anti-patterns
- Script anti-patterns
- Scope anti-patterns

## Content

### First-person or second-person description

The description is injected into the router system prompt. Mixing person confuses discovery.

- Good: `Extracts text from PDF files. Use when …`
- Bad: `I can help with PDFs.`
- Bad: `You can use this to process PDFs.`

### Vague names

Names that don't describe the task can't trigger the right skill.

- Bad: `helper`, `utils`, `tools`, `documents`, `data`, `files`.
- Good: gerund + object — `processing-pdfs`, `analyzing-logs`.

### Reserved names

Rejected by the validator.

- Bad: `anthropic-helper`, `claude-tools`, anything containing `anthropic` or `claude`.

### Time-sensitive prose

Goes stale.

- Bad: `Before August 2025, use the v1 API. After August 2025, use v2.`
- Good: keep current instructions as the main path. Put deprecated patterns in a collapsed `<details>` block labelled "Old patterns".

### Offering multiple options as equals

The agent spends tokens choosing.

- Bad: `You can use pypdf, pdfplumber, PyMuPDF, or pdf2image.`
- Good: `Use pdfplumber for text extraction. For scanned PDFs, use pdf2image with pytesseract.`

### Declarative one-off answers

Skills teach approaches, not answers to a specific instance.

- Bad: `Join orders to customers on customer_id, filter region = 'EMEA', sum amount.`
- Good:
  ```
  1. Read the schema from references/schema.yaml.
  2. Join tables using the _id foreign key convention.
  3. Apply filters from the request as WHERE clauses.
  4. Aggregate numeric columns and format as a markdown table.
  ```

### Inconsistent terminology

The agent is more accurate when one concept uses one word throughout.

- Bad: mixing `field` / `box` / `element` / `control`.
- Bad: mixing `extract` / `pull` / `get` / `retrieve`.
- Good: pick one term per concept and hold to it.

### Explaining general concepts

The agent already knows what a PDF is, what HTTP is, what a database migration is.

- Bad: "A PDF (Portable Document Format) file contains text and images…"
- Good: jump straight to what the agent needs — the specific library, the gotcha, the command.

## Structure

### Body over budget

- >500 lines or >5000 tokens → warning.
- >800 lines or >8000 tokens → error.

Move overflow to `references/`.

### Nested references

Claude partial-reads files when they're linked from other linked files (using `head -100` or similar). Content nested more than one level deep may never be fully read.

- Bad:
  ```
  SKILL.md → advanced.md → details.md → …
  ```
- Good:
  ```
  SKILL.md
    ├─ advanced.md
    ├─ reference.md
    └─ examples.md
  ```

### Reference file >100 lines without TOC

Partial-reads miss later sections.

- Fix: put a `## Contents` list at the top so the agent knows what else is in the file even when it only reads the first 100 lines.

### Unnamed references

`See references/ for details.` is useless — the agent does not know which file to load or when.

- Good: `See references/api-errors.md if the API returns a non-200 status.`

## Scripts

### Punting on errors

```python
return open(path).read()  # raises; agent has to recover
```

Handle the error in the script. Print a structured message and return a sensible default.

### Voodoo constants

```python
TIMEOUT = 47   # why?
```

Justify every value with a comment or delete it.

### Windows paths

- Bad: `scripts\helper.py`
- Good: `scripts/helper.py`

### Assumed installations

Do not assume packages are available. Declare dependencies in SKILL.md.

```markdown
Install: `pip install pypdf`
```

### Ambiguous execute vs read intent

Always state whether the agent should run the script or read it as reference. If the file exists in `scripts/`, default to execute; if in `references/`, default to read.

## Scope

### Redundant with the base model

If the agent handles the task fine without the skill, the skill is noise. Confirm via eval — baseline without skill, baseline with skill; if scores are the same, drop the skill.

### Too narrow

Multiple skills must load for a single task. Overhead plus risk of conflicting instructions. Combine related skills into one coherent unit.

### Too broad

Skill covers several distinct domains; router cannot activate it precisely, or activates it for the wrong task. Split into separate skills.

### Workspace configuration inside a skill

Skills describe *how* to do things. Environment-specific values (URLs, IDs, credentials, file paths) belong in `workspace.yml` or `friday.yml`. If it changes per deployment, it is configuration, not a skill.

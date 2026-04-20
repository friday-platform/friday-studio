# Control calibration

Not every part of a skill needs the same level of prescriptiveness. Match specificity to task fragility. Most skills mix all three levels — calibrate each section independently.

## Contents

- High freedom: intent + success criteria
- Medium freedom: preferred pattern, pseudocode
- Low freedom: exact commands, fragile operations
- Rule of thumb
- Calibration examples across a single skill

## High freedom

Use when multiple approaches are valid, decisions depend on context, or heuristics guide the approach.

Describe **intent** and **success criteria**. Leave the execution path open.

For flexible instructions, explaining *why* is more effective than rigid directives — an agent that understands the purpose adapts to cases the skill did not anticipate.

```markdown
## Code review

Check for:

1. SQL injection: all database queries should use parameterised statements.
2. Authentication: every endpoint should verify the caller's identity before
   reading or mutating user-scoped data.
3. Race conditions: concurrent paths should use explicit synchronisation,
   not "this is fine because X usually happens first".
4. Error leakage: user-facing error messages should not expose internal
   details (stack traces, SQL, file paths).
```

The agent decides how to check each item against the specific codebase.

## Medium freedom

Use when a preferred pattern exists but some variation is fine, or when configuration affects behaviour.

Provide pseudocode or a parameterised script.

```markdown
## Generate report

Use this template and adapt as needed:

```python
def generate_report(data, fmt="markdown", include_charts=True):
    # Process data
    # Emit in requested format
    # Optionally include visualizations
    ...
```
```

The agent fills in the body; parameters are already decided.

## Low freedom

Use when operations are fragile, consistency is critical, or a specific sequence must be followed.

Give the exact command. State explicitly that the agent should not modify it.

```markdown
## Database migration

Run exactly this command:

```bash
python scripts/migrate.py --verify --backup
```

Do not modify the command or add flags. The `--verify` flag runs pre-flight
integrity checks; `--backup` snapshots affected tables. Running without
either is not safe.
```

## Rule of thumb

Think of the agent as a robot on a path:

- **Narrow bridge with cliffs on both sides** — one safe way forward. Give exact instructions and hard constraints. Example: database migrations, cryptographic operations, financial calculations.
- **Open field with no hazards** — many paths lead to success. Describe the destination and trust the agent. Example: code reviews where context determines the best approach.

## Calibration across one skill

A typical skill looks like this — high, medium, and low freedom in the same document:

```markdown
# Filling PDF forms

## Analysis (high freedom)

Examine the form to understand its structure. Most forms have a combination
of text fields, checkboxes, and signature blocks. Some have calculated
fields that depend on earlier entries.

## Mapping (medium freedom)

Create a `field_values.json` with one entry per field. The schema is:

```json
{
  "field_name": { "value": "...", "type": "text | check | sig" }
}
```

## Fill (low freedom)

Run exactly this command:

```bash
python scripts/fill_form.py input.pdf field_values.json output.pdf
```

Do not modify the arguments or add flags.
```

Analysis is open because every form is different. Mapping has a shape but the values depend on the task. The fill step is mechanical and fragile, so it is locked down.

# Pattern library

Reusable structures for skill content. Pick the patterns that fit your task — a skill does not need all of them.

## Contents

- Gotchas section
- Templates for output format
- Checklists for multi-step workflows
- Validation loop
- Plan-validate-execute
- Examples pattern
- Conditional workflow pattern
- Templates strictness levels

## Gotchas

The highest-value content in most skills. A gotcha is a concrete, environment-specific fact that defies reasonable assumption. Not general advice ("handle errors appropriately") — concrete corrections to mistakes the agent will make without being told.

```markdown
## Gotchas

- The `users` table uses soft deletes. Queries must include
  `WHERE deleted_at IS NULL` or deactivated accounts leak into results.
- User ID is `user_id` in the database, `uid` in the auth service, and
  `accountId` in the billing API. All three refer to the same value.
- The `/health` endpoint returns 200 as long as the web server is up,
  even if the database connection is down. Use `/ready` for full-service
  health.
- Workspace IDs are kebab-case on disk (`delicate_coconut`) but camelCase
  in API responses (`delicateCoconut`). The CLI accepts either.
```

Keep gotchas **in SKILL.md**, not a reference file — the agent needs to see them before hitting the situation. A separate reference only works if the trigger phrase in SKILL.md matches what the agent is about to do; for non-obvious issues, the agent may not recognise the trigger.

**Iteration rule:** when the agent makes a mistake you have to correct, add the correction to gotchas. This is the tightest feedback loop for improving a skill.

## Templates for output format

When the output format is prescribed, provide a template. Agents pattern-match against concrete structures more reliably than they follow prose descriptions.

Short templates live inline:

```markdown
## Report structure

Use this template:

```markdown
# [Analysis Title]

## Executive summary
[One-paragraph overview of key findings]

## Key findings
- Finding 1 with supporting data
- Finding 2 with supporting data

## Recommendations
1. Specific actionable recommendation
2. Specific actionable recommendation
```
```

Longer templates, or templates only needed in certain cases, go in `assets/` and are referenced on demand.

### Strict vs flexible templates

Strict — for API responses, data formats:

```markdown
## Webhook payload

ALWAYS use this exact structure:

```json
{
  "event": "string",
  "timestamp": "ISO-8601",
  "data": { ... }
}
```
```

Flexible — when adaptation is useful:

```markdown
## Report structure

Sensible default; adapt sections based on the analysis.
```

Choose strictness to match the downstream consumer.

## Checklists for multi-step workflows

An explicit checklist helps the agent track progress and avoid skipping validation gates. The agent copies the checklist into its response and checks items off.

```markdown
## Form processing workflow

Progress:

- [ ] Step 1: Analyze the form (run scripts/analyze_form.py)
- [ ] Step 2: Create field mapping (edit fields.json)
- [ ] Step 3: Validate mapping (run scripts/validate_fields.py)
- [ ] Step 4: Fill the form (run scripts/fill_form.py)
- [ ] Step 5: Verify output (run scripts/verify_output.py)

**Step 1: Analyze the form**
Run: `python scripts/analyze_form.py input.pdf`

**Step 2: …**
```

Checklists work for any complex, multi-step process, with or without scripts.

## Validation loop

Pattern: do → validate → fix → repeat.

```markdown
## Editing workflow

1. Make your edits.
2. Run validation: `python scripts/validate.py output/`
3. If validation fails:
   - Read the error message.
   - Fix the issues.
   - Run validation again.
4. Proceed only when validation passes.
```

The validator can be a script, a reference document to check against, or a self-check prompt. A verbose failure mode is essential: the validator must tell the agent *what* is wrong specifically enough to let it self-correct.

Example of useful validator output:

```
Field 'signature_date' not found.
Available fields: customer_name, order_total, signature_date_signed
```

versus the useless:

```
Validation failed.
```

## Plan-validate-execute

For batch or destructive operations. Generate an intermediate plan, validate it against a source of truth, and only then execute.

```markdown
## PDF form filling

1. Extract form fields:
   `python scripts/analyze_form.py input.pdf > form_fields.json`
   (lists every field name, type, and whether it is required)
2. Create `field_values.json` mapping each field name to its intended value.
3. Validate:
   `python scripts/validate_fields.py form_fields.json field_values.json`
   (checks that every name exists in the form, types match, required fields
   are present)
4. If validation fails, revise `field_values.json` and re-validate.
5. Execute:
   `python scripts/fill_form.py input.pdf field_values.json output.pdf`
```

The key ingredient is step 3 — a validator that checks the plan against the source of truth before any irreversible step runs.

**When to use:** batch operations, destructive changes, complex validation rules, high-stakes operations.

## Examples pattern

For skills where output quality depends on seeing the style, provide concrete input/output pairs. More reliable than prose.

```markdown
## Commit message format

Generate commit messages following these examples:

**Example 1**
Input: Added user authentication with JWT tokens
Output:
```
feat(auth): implement JWT-based authentication

Add login endpoint and token validation middleware
```

**Example 2**
Input: Fixed bug where dates displayed incorrectly in reports
Output:
```
fix(reports): correct date formatting in timezone conversion

Use UTC timestamps consistently across report generation
```

Follow this style: `type(scope): brief description`, then detailed explanation.
```

Three examples is usually enough. More than five hits diminishing returns.

## Conditional workflow pattern

Guide the agent through decision points.

```markdown
## Document modification

1. Determine the modification type:
   - Creating new content → follow "Creation workflow".
   - Editing existing content → follow "Editing workflow".

2. Creation workflow:
   - Use docx-js.
   - Build the document from scratch.
   - Export to .docx.

3. Editing workflow:
   - Unpack the existing document.
   - Modify XML directly.
   - Validate after each change.
   - Repack when complete.
```

If decision branches get long, push each into a reference file and leave only the routing in SKILL.md.

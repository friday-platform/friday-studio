# Evaluation-first authoring

Build evaluations **before** writing extensive documentation. Evaluations are the source of truth for whether the skill does its job.

## Contents

- Loop overview
- Writing evaluation cases
- Reading execution traces
- Claude-A / Claude-B loop
- Gathering team feedback
- What to watch for in observed usage

## Loop overview

1. **Identify the gap.** Run the agent on representative tasks *without* a skill. Document specific failures: what was missing, what was reinvented, where time was wasted.
2. **Write ≥3 evaluation cases** that capture the gap. Minimum fields per case:
   ```json
   {
     "skills": ["your-skill-name"],
     "query": "task prompt the user would send",
     "files": ["test-files/..."],
     "expected_behavior": [
       "concrete observable outcome 1",
       "concrete observable outcome 2"
     ]
   }
   ```
3. **Establish a baseline.** Run the evaluations without the skill loaded. Record scores and note specific failures.
4. **Draft the minimal skill** that closes the gap. Resist the urge to over-specify; the body should be just enough to address the observed failures.
5. **Rerun evaluations** with the skill loaded. Compare against baseline.
6. **Refine.** False positives → tighten the description. Missed steps → add to gotchas. Wasted exploration → provide a clearer default. Repeat until scores plateau.

Even a single pass of execute-then-revise improves quality noticeably; complex domains often need several.

## Writing evaluation cases

Effective cases:

- Are **representative** of real user requests, not synthetic edge cases.
- Have **concrete** expected behaviours, not "does the right thing".
- Vary in difficulty — include at least one case the skill is unlikely to handle perfectly.

Avoid:

- Cases that can be answered by the base model without the skill — they don't measure the skill.
- Cases that require information not in the skill or reference files — they measure the base model.
- Cases whose expected output changes over time — they go stale.

## Reading execution traces

When iterating, read the trace, not just the final output. The trace reveals whether the skill is helping or hurting.

Diagnostic signals:

- **Wasted exploration** — the agent tries several approaches before finding one that works. Usually means instructions are too vague; promote the successful approach to a default.
- **Irrelevant instructions being followed anyway** — the agent applies a rule that does not fit the task. Usually means the section is too broad; scope it with a conditional ("if X, then …").
- **Too many options presented** — the agent spends tokens choosing among alternatives. Pick one default; mention one fallback.
- **Reference files never read** — the trigger phrase in SKILL.md is too subtle, or the file is not actually needed.
- **Same reference read repeatedly** — content probably belongs inline in SKILL.md.
- **Unexpected file read order** — the structure is less intuitive than assumed; reorder or rename.

## Claude-A / Claude-B loop

Two agent instances, distinct roles:

- **Claude A** — expert collaborator. Helps design and refine the skill.
- **Claude B** — fresh instance with the skill loaded. Performs real tasks. Reveals gaps.

You alternate:

1. Work with Claude A to draft the skill.
2. Hand the skill to Claude B on a real task.
3. Observe Claude B's behaviour (traces, outputs, mistakes).
4. Return to Claude A with specific observations — not "it didn't work", but "Claude B forgot to filter test accounts on regional reports, even though the skill mentions filtering".
5. Update the skill. Test again with a new Claude B.

Why this works: Claude A understands agent needs and prompt patterns; you provide domain expertise; Claude B reveals gaps through real usage rather than assumption; iterative refinement improves the skill based on observed behaviour rather than theory.

### Starting a new skill

Complete a real task in normal conversation with Claude A. Notice what context you supply repeatedly — table names, filter rules, formatting preferences. That repeated context is the reusable pattern.

Then: "Create a skill that captures the BigQuery analysis pattern we just used. Include the table schemas, naming conventions, and the filtering rule."

Claude A will produce a draft. Common first-pass problems to correct:

- Over-explanation of concepts the agent already knows. "Remove the explanation about what win rate means."
- Everything in one file. "Move the table schemas into `references/schema.md`. We might add more tables later."
- Too many options. "Pick pdfplumber as the default; mention pypdf only as a fallback."

### Iterating on an existing skill

1. Use the skill in real workflows with Claude B — not contrived test scenarios.
2. Observe where Claude B struggles, succeeds, or makes unexpected choices.
3. Share the current SKILL.md with Claude A and describe one specific observation. Ask for refinements.
4. Apply changes and test again.
5. Continue observe-refine-test until the skill behaves predictably.

## Gathering team feedback

- Share the skill with teammates and watch how they use it.
- Ask: does it activate when expected? Are the instructions clear? What's missing?
- Incorporate feedback to address blind spots in your own usage patterns.

Other users routinely hit cases the author didn't think of — their failures are the best source of new gotchas.

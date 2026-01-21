@scripts/ralph/PRD.json @scripts/ralph/progress.txt

╭─────────────────────────────────────────────────────────────────────────────╮
│  RALPH LOOP - Autonomous PRD Execution                                      │
╰─────────────────────────────────────────────────────────────────────────────╯

TASK SELECTION:
  1. Read PRD.json - find tasks where passes: false
  2. Choose the task YOU judge most important based on:
     • Architectural decisions and core abstractions (highest priority)
     • Integration points between modules
     • Unknown unknowns and spike work
     • Standard features and implementation
     • Polish, cleanup, and quick wins (lowest priority)

EXECUTION:
  If task has tdd field:
    1. Write the test described in tdd.red
    2. Run verification commands - confirm test FAILS for the right reason
    3. Implement tdd.green - minimal code to pass
    4. Run verification commands - confirm test PASSES
    5. Apply tdd.refactor if present

  If task has no tdd field:
    1. Implement the task
    2. Run all verification commands

COMPLETION:
  1. Verify all acceptanceCriteria are met
  2. Set passes: true for this task in PRD.json
  3. Commit with conventional commit message
  4. Append to progress.txt:

     ## <timestamp> - <task-id>
     Commit: <sha> (<commit message>)

     Decision: <if you made a non-obvious choice>
     Tuning: <if you noticed something to improve for future iterations>

     ---

RULES:
  • ONLY WORK ON ONE TASK PER ITERATION
  • Run feedback loops (deno check, deno lint, tests) before committing
  • Do NOT commit if any verification fails - fix first
  • If all tasks pass AND scope.successCriteria verified:
    output <promise>COMPLETE</promise>

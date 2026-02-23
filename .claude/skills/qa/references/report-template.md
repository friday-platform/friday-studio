# QA Report Template

Use this structure when writing reports to `docs/qa/reports/YYYY-MM-DD-<topic>.md`.

```markdown
# QA Report: <Topic>

**Date**: YYYY-MM-DD
**Mode**: run | fix
**Source**: <plan doc path or "smoke matrix">
**Branch**: <branch name>

## Summary

X/Y cases passed. <one-line overall assessment>

## Results

### PASS: <Case name>
<Brief note on what was verified>

### FAIL: <Case name>
**Expected**: <what should have happened>
**Actual**: <what happened>
**Diagnostics**:
- <API response, log excerpt, screenshot path, etc.>

### SKIP: <Case name>
**Reason**: <why it was skipped — prerequisite not met, depends on failed case>

## Changes Made (fix mode only)

### <Case name>
- **Root cause**: <what was wrong>
- **Fix**: <what was changed>
- **Files**: <list of modified files>

## Escalations (fix mode only)

### <Case name>
- **Attempts**: <what was tried>
- **Why escalated**: <ambiguous | stuck | environment | looks wrong>
- **Context**: <diagnostic info for the human to pick up from>

## Environment
- Daemon version / commit: <hash>
- Browser: <if UI cases were run>
- Notable config: <anything relevant>
```

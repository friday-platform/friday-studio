# Team Lead Learnings: Workspace Integrations Edit Page

## Session Date: 2026-02-16
## Branch: david/tem-3696-workspace-integration-settings

### Observations

- Teammate committed pre-existing working directory changes along with their task's files using `git add -A`. Task instructions should emphasize staging only specific files with `git add <file>` to avoid sweeping in unrelated changes.
- When a branch has uncommitted prior work, survey it before spawning teammates and either commit it first or warn teammates not to touch those files.
- Adding explicit git staging instructions to the teammate prompt ("ONLY stage files you changed, use `git add <file>`") fixed the problem — Po correctly staged only their file after receiving this instruction.
- LinkAuthModal.onSuccess only returns the label string, not the credential ID. To bind after API key creation, must query the summary endpoint to find the newest credential. This is a minor API gap worth documenting.

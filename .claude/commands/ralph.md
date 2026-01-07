---
description: ⚠️ USE WITH CAUTION ⚠️ Works through the backlog and implements all open beads
---

Your job is to spawn sub-agents to complete individual beads.

Start by running `bv --robot-triage` to see what's ready to work on.

Pick one bead and spawn a sub-agent to complete the work. Have them pick up as
in progress, do the work, commit it (conventional commit) and then complete
after checking their work. If the agent runs into trouble, finds a bug, or
anything else of note have them report it back to you.

Analyze whatever they come back with and cross-reference to the rest of the
beads using `bd` and `bv`. If it's a new problem, fire off a sub-agent to
research, verify, and file a detailed bug bead if it's relevant.

Work through all the open beads sequentially, even if they can be parallelized -
just do them sequentially. After every couple workers run, rerun
`bv --robot-triage` to ensure you're still on the right track.

Additional details (if any): $ARGUMENTS

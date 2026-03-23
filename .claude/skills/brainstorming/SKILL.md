---
name: brainstorming
description: Refines rough ideas into fully-formed designs through collaborative questioning, alternative exploration, and incremental validation. Activates before writing code or implementation plans. Not for clear mechanical processes.
argument-hint: "[topic or rough idea]"
---

# Brainstorming Ideas Into Designs

## Overview

Help turn ideas into fully formed designs and specs through natural
collaborative dialogue.

Start by understanding the current project context, then ask questions one at a
time to refine the idea. Once you understand what you're building, present the
design in small sections (200-300 words), checking after each section whether it
looks right so far.

## The Process

**Understanding the idea:**

- Check out the current project state first (files, docs, recent commits)
- Explore the codebase to see the current state and align that with what the
  user is asking for. Use sub-agents.
- Ask questions one at a time to refine the idea
- Prefer multiple choice questions when possible, but open-ended is fine too
- Only one question per message - if a topic needs more exploration, break it
  into multiple questions
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**

- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why
- For each approach, evaluate module boundaries (see below)

**Evaluating module boundaries (Ousterhout's "deep modules"):**

When comparing approaches, stress-test each one's module boundaries using
Ousterhout's deep modules framework from *A Philosophy of Software Design*.

A deep module has an interface simpler than its implementation — it hides real
design decisions (data format, protocol, caching strategy) behind a small
surface area. A shallow module wraps a single call and adds no abstraction. When
the same design decision (schema shape, encoding format, retry policy) appears
in multiple modules, that's information leakage — the boundary is drawn wrong.
Watch especially for temporal decomposition: structuring code as
parse → validate → transform → store mirrors execution order, not information
boundaries, and scatters related knowledge across phases. A single
`Config.load(raw)` that hides all three phases is deeper than three functions
that each need to know the schema.

The exception: shallow wrappers earn their keep at system boundaries where
bridging the abstraction gap *is* the point — adapting one protocol to another,
not hiding complexity.

Integrate this thinking into your recommendation naturally. Don't enumerate
these as criteria to the user — just prefer the approach that produces deeper
modules with less leakage, and explain why the boundaries are drawn where they
are.

**Presenting the design:**

- Once you believe you understand what you're building, present the design
- Break it into sections
- Ask after each section whether it looks right so far
- Cover: architecture, components, data flow, module boundaries, error handling,
  testing
- For module boundaries: state what each module hides, what its interface
  promises, and why a consumer can trust it without reading internals
- Be ready to go back and clarify if something doesn't make sense

## After the Design

Ask the user if they want to create a formal design document. If so, you will
write a PRD for this feature. Use the following template:

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format
of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of
the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

### Module Boundaries

For each module or component boundary in the design:

- **Interface:** What the consumer sees (method signatures, props, API shape)
- **Hides:** What design decisions are encapsulated (the "why this boundary
  exists" — not just "what it does")
- **Trust contract:** What a consumer can assume without reading internals

Omit for trivial changes that don't introduce or modify boundaries.

### Data Isolation (if applicable)

If the feature involves user-scoped database tables, note which tables need
RLS policies and any cross-user operations. See the `database-rls` skill.

Do NOT include specific file paths or code snippets. They may end up being
outdated very quickly.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not
  implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>

- Write the validated design to `docs/plans/YYYY-MM-DD-<topic>-design.md`

## Key Principles

- **One question at a time** - Don't overwhelm with multiple questions
- **Multiple choice preferred** - Easier to answer than open-ended when possible
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Deep over shallow** - Prefer fewer modules with simple interfaces hiding
  real complexity over many thin wrappers. If a boundary doesn't hide a design
  decision, it's not earning its keep
- **Explore alternatives** - Always propose 2-3 approaches before settling
- **Incremental validation** - Present design in sections, validate each
- **Be flexible** - Go back and clarify when something doesn't make sense

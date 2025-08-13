# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project Overview

**Atlas** is a comprehensive AI agent orchestration platform that transforms software delivery
through human/AI collaboration. Atlas enables engineers to create workspaces where humans
collaborate seamlessly with specialized, autonomous agents in a secure, auditable, and scalable
environment.

## CLI Development Guidelines

When developing CLI commands:

1. **Command File Structure**: Use nested command structures for subcommands (e.g.,
   `src/cli/commands/workspace/add.tsx` for `atlas workspace add`). This follows the existing
   codebase pattern and provides better organization for complex command hierarchies.

## Test Writing Guidelines

When writing tests:

1. **Keep tests simple and focused**: Write concise tests that verify behavior, not implementation
   details
2. **Avoid type checking in tests**: TypeScript already provides compile-time type safety. Don't
   write tests like `assertEquals(typeof json.status, "string")` - instead test actual values and
   behavior
3. **Focus on impactful tests**: Prefer 2-3 meaningful tests over many trivial ones. Good tests
   check:
   - Core functionality works correctly
   - Edge cases are handled properly
   - Integration between components works as expected
4. **Use clear test names**: Test names should describe what behavior is being tested, not how it's
   implemented

[Rest of the file remains unchanged...]

---
name: reviewing-comments
description: Reviews and improves code comments, JSDoc, and Zod schema descriptions. Activates when asked to clean up comments, review comment quality, add missing documentation, or remove noisy comments. Applies to any language but optimized for TypeScript/Deno.
user-invocable: false
---

# Code Comments

Quality over quantity. Comments should explain why, not what.

## Core Principle

**Comment the hard parts.** If you'd get stuck reading this in 6 months, comment it. Otherwise, let the code speak.

## Remove These (Low-Value Comments)

### Narrator Comments
Announce constructs the reader can already see.
```typescript
// Bad: Loop through users
for (const user of users) { ... }

// Bad: Check if authenticated
if (isAuthenticated) { ... }
```

### Translator Comments
Restate code in English.
```typescript
// Bad: Set count to zero
let count = 0;

// Bad: Return the result
return result;
```

### Step-by-Step Comments
Numbered tutorial-style markers.
```typescript
// Bad:
// Step 1: Get the user
const user = await getUser(id);
// Step 2: Validate permissions
if (!user.canAccess(resource)) { ... }
```

### Placeholder Comments
Empty templates or TODO stubs with no substance.
```typescript
// Bad: TODO: implement this
// Bad: Add error handling here
```

## Keep These (High-Value Comments)

### Why Comments
Business logic, constraints, non-obvious decisions.
```typescript
// Retry 3x because Stripe webhooks occasionally arrive out of order
const result = await retry(processPayment, { attempts: 3 });
```

### Gotchas and Edge Cases
Order dependencies, surprising behavior, failure modes.
```typescript
// Must set headers BEFORE body - fetch spec quirk
response.headers.set('X-Custom', value);
response.body = data;
```

### External References
Links, issue mentions, spec references.
```typescript
// See RFC 7231 §6.5.1 for status code semantics
// Fixes #1234 - race condition in session cleanup
```

### Warnings
Security implications, performance traps, deprecation.
```typescript
// WARNING: O(n²) - don't use for >1000 items
// SECURITY: Input must be sanitized before reaching here
```

### Real TODOs
Actionable items with context.
```typescript
// TODO(eric): Remove after Q2 migration - tracking in #456
```

## JSDoc Guidelines

### Length by Complexity

| Function | JSDoc |
|----------|-------|
| 1-5 lines, obvious | None |
| 6-20 lines | One-liner if name isn't self-documenting |
| 20+ lines | Purpose + non-obvious state changes |
| Complex types | Inline comment explaining constraint/pattern |

### Style

- **Imperatives:** "Returns X" not "This function returns X"
- **No qualifiers:** Cut "might", "should", "basically", "essentially"
- **No enterprise speak:** Cut "robust", "comprehensive", "leverage", "facilitate"
- **Technical precision > politeness**

```typescript
// Bad:
/**
 * This function basically returns the user's display name,
 * which might be their username if they haven't set one.
 */

// Good:
/** Returns display name, falling back to username. */
```

### Zod Schema Descriptions

Keep `.describe()` minimal. One phrase, state the constraint.

```typescript
// Bad:
z.string().describe('This field represents the user email address which must be valid')

// Good:
z.string().email().describe('User email for notifications')
```

## Review Workflow

1. **Read the whole file** - understand what it does
2. **Find the hard parts** - where would someone get stuck?
3. **Comment only those** - explain why, not how
4. **Delete noise** - remove anything that restates code
5. **6-month test** - would future-you understand this?

## Don't Explain

- TypeScript/Deno syntax
- Standard library functions
- Framework APIs (link to docs instead)
- Obvious business logic

## Do Explain

- Non-obvious business rules
- Why this approach over alternatives
- "This order matters because..."
- Edge cases that caused bugs
- External dependencies and their quirks

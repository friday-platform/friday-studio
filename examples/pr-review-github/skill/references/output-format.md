# Review Output Format

Your review output MUST be structured JSON, submitted via the `complete` tool.
Do not produce markdown — the downstream pipeline renders comments from your
structured data.

## Schema

```json
{
  "verdict": "APPROVE | REQUEST_CHANGES | COMMENT",
  "summary": "2-3 sentences: what the PR does, what it does well, any concerns.",
  "findings": [
    {
      "severity": "CRITICAL",
      "category": "correctness",
      "file": "src/payments/webhook.ts",
      "line": 87,
      "start_line": 85,
      "title": "Unhandled Stripe signature verification failure",
      "description": "The constructEvent call can throw StripeSignatureVerificationError, but the catch block only handles generic Error.",
      "suggestion": "try {\n  event = stripe.webhooks.constructEvent(body, sig, secret);\n} catch (err) {\n  if (err instanceof Stripe.errors.StripeSignatureVerificationError) {\n    return c.json({ error: \"Invalid signature\" }, 400);\n  }\n  throw err;\n}"
    }
  ]
}
```

## Field Reference

### Top-level

| Field | Required | Description |
|-------|----------|-------------|
| `verdict` | Yes | `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` |
| `summary` | Yes | 2-3 sentence assessment of the PR |
| `findings` | Yes | Array of finding objects (can be empty) |

### Finding fields

| Field | Required | Description |
|-------|----------|-------------|
| `severity` | Yes | `CRITICAL`, `WARNING`, `SUGGESTION`, or `NITPICK` |
| `category` | Yes | `correctness`, `security`, `performance`, `error-handling`, `testing`, or `style` |
| `file` | Yes | File path relative to repo root |
| `line` | Yes | Line number to comment on (single-line) or end line (multi-line) |
| `start_line` | No | Start line for multi-line findings. Omit for single-line. |
| `title` | Yes | One-line title of the finding |
| `description` | Yes | Explanation of the issue and its impact |
| `suggestion` | No | Replacement code for the line range. Raw code, no markdown fences. GitHub renders an "Apply suggestion" button. |

## Severity Labels

- **CRITICAL** — Bug, security vulnerability, or data loss risk
- **WARNING** — Should fix; correctness risk or bad practice
- **SUGGESTION** — Worth considering; improvement opportunity
- **NITPICK** — Minor style preference

## Verdict Decision Tree

1. Any **CRITICAL** findings? → `REQUEST_CHANGES`
2. Multiple **WARNING** findings? → `REQUEST_CHANGES`
3. Only **SUGGESTION** / **NITPICK** findings? → `COMMENT`
4. No findings, or all minor? → `APPROVE`

Only use `REQUEST_CHANGES` for real bugs, security issues, or correctness
problems. Use `COMMENT` for suggestions and style issues. Use `APPROVE` when
the code is correct and clean.

## Rules

- Submit via the `complete` tool — do not produce markdown text output.
- Every finding MUST have a `file` and `line` that correspond to actual lines
  in the diff.
- `suggestion` must be syntactically complete code that replaces the entire
  `start_line..line` range. Do NOT wrap in markdown fences.
- Do not repeat the same finding for multiple locations; consolidate with
  references in the description: "Also applies to `file:line`."
- Order findings by severity: CRITICAL first, NITPICK last.
- Cap total findings at 15. If more exist, keep the highest severity ones and
  add a note in the summary.
- If there are no findings, return an empty `findings` array.

## Examples

### Clean PR (0 findings)

```json
{
  "verdict": "APPROVE",
  "summary": "This PR adds input validation to the user registration endpoint using Zod schemas. The implementation is clean, covers edge cases well, and includes comprehensive test coverage.",
  "findings": []
}
```

### Medium PR (3 findings)

```json
{
  "verdict": "REQUEST_CHANGES",
  "summary": "This PR migrates payment processing from Stripe v2 to v3 SDK. The core migration is well-structured, but there is a missing error handler on the webhook endpoint that could cause silent payment failures.",
  "findings": [
    {
      "severity": "CRITICAL",
      "category": "correctness",
      "file": "src/payments/webhook.ts",
      "line": 90,
      "start_line": 87,
      "title": "Unhandled Stripe webhook signature verification failure",
      "description": "The constructEvent call can throw StripeSignatureVerificationError, but the catch block only handles generic Error. A malformed signature will crash the process instead of returning 400.",
      "suggestion": "try {\n  event = stripe.webhooks.constructEvent(body, sig, secret);\n} catch (err) {\n  if (err instanceof Stripe.errors.StripeSignatureVerificationError) {\n    return c.json({ error: \"Invalid signature\" }, 400);\n  }\n  throw err;\n}"
    },
    {
      "severity": "WARNING",
      "category": "performance",
      "file": "src/payments/client.ts",
      "line": 23,
      "title": "API key read from process.env on every call",
      "description": "process.env.STRIPE_SECRET_KEY is read on every invocation of createClient(). This works but is wasteful — environment variables don't change at runtime.",
      "suggestion": "const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;\n\nexport function createClient() {\n  return new Stripe(STRIPE_KEY, { apiVersion: \"2024-01-01\" });\n}"
    },
    {
      "severity": "SUGGESTION",
      "category": "style",
      "file": "src/payments/webhook.ts",
      "line": 130,
      "start_line": 112,
      "title": "Extract event type handler into a map",
      "description": "The switch statement over event.type has 8 cases and will grow. A handler map would be easier to maintain and test individually."
    }
  ]
}
```

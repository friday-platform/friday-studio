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
      "file": "src/payments/webhook.py",
      "line": 87,
      "start_line": 85,
      "title": "Unhandled Stripe signature verification failure",
      "description": "The construct_event call can raise stripe.error.SignatureVerificationError, but the except block only catches generic Exception.",
      "suggestion": "try:\n    event = stripe.Webhook.construct_event(payload, sig_header, secret)\nexcept stripe.error.SignatureVerificationError:\n    return JsonResponse({\"error\": \"Invalid signature\"}, status=400)\nexcept Exception:\n    raise"
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
| `suggestion` | No | Replacement code for the line range. Raw code, no markdown fences. |

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
  `start_line..line` range. Do NOT wrap in markdown fences. Bitbucket renders
  this as a suggestion the author can apply directly.
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
  "summary": "This PR adds input validation to the user registration endpoint using Pydantic models. The implementation is clean, covers edge cases well, and includes comprehensive test coverage.",
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
      "file": "src/payments/webhook.py",
      "line": 90,
      "start_line": 87,
      "title": "Unhandled Stripe webhook signature verification failure",
      "description": "The construct_event call can raise stripe.error.SignatureVerificationError, but the except block only catches generic Exception. A malformed signature will return 500 instead of 400.",
      "suggestion": "try:\n    event = stripe.Webhook.construct_event(payload, sig_header, secret)\nexcept stripe.error.SignatureVerificationError:\n    return JsonResponse({\"error\": \"Invalid signature\"}, status=400)\nexcept Exception:\n    raise"
    },
    {
      "severity": "WARNING",
      "category": "performance",
      "file": "src/payments/client.py",
      "line": 23,
      "title": "API key read from os.environ on every call",
      "description": "os.environ[\"STRIPE_SECRET_KEY\"] is read on every invocation of create_client(). This works but is wasteful — environment variables don't change at runtime.",
      "suggestion": "STRIPE_KEY = os.environ[\"STRIPE_SECRET_KEY\"]\n\ndef create_client() -> stripe.StripeClient:\n    return stripe.StripeClient(STRIPE_KEY)"
    },
    {
      "severity": "SUGGESTION",
      "category": "style",
      "file": "src/payments/webhook.py",
      "line": 130,
      "start_line": 112,
      "title": "Extract event type handler into a dispatch dict",
      "description": "The if/elif chain over event.type has 8 branches and will grow. A handler dict would be easier to maintain and test individually."
    }
  ]
}
```

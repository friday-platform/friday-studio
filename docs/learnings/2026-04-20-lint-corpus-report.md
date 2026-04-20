# Lint corpus report

Corpus size: **4** skills.

Decision threshold: rules firing on >20% of samples are candidates for demotion or rule adjustment.

## Rule hit rates

| Rule | Warn | Error | Rate | Verdict |
|---|---:|---:|---:|---|
| `description-trigger` | 3 | 0 | 75.0% | ⚠️ above threshold — consider demoting to info |
| `description-person` | 1 | 0 | 25.0% | ⚠️ above threshold — consider demoting to info |

## Per-sample findings

### stored:@tempest/fast-self-modification@v1
- `description-trigger` (warn): Description should include a 'Use when …' clause so the router knows when to fire.

### stored:@tempest/parity-plan-context@v1
- `description-trigger` (warn): Description should include a 'Use when …' clause so the router knows when to fire.

### stored:@tempest/qa-lint-test@v4
- `description-person` (warn): Description uses first/second person. Router discovery works best with third person.
- `description-trigger` (warn): Description should include a 'Use when …' clause so the router knows when to fire.


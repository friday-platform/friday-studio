---
name: tracking-analytics
description: Guides adding, modifying, and debugging analytics events. Covers event constants, BigQuery views, Grafana dashboard updates, and documentation.
---

# Friday Analytics

Events flow: Service → OTLP → atlas-otel-collector → BigQuery → Grafana

## References

Load as needed — the workflow below is self-contained for common tasks.

- [event-flow.md](references/event-flow.md) — full pipeline diagram, TS/Go
  constant locations, emit examples, debugging commands
- [bigquery-views.md](references/bigquery-views.md) — view names and schemas,
  query examples, Grafana dashboard URL and update instructions

## When Adding a New Event

1. **Add constants** in both TypeScript and Go (keep string values in sync).
   See [event-flow.md](references/event-flow.md) for file locations and
   templates.

2. **Emit the event** from the relevant service using `@atlas/analytics` (TS) or
   `pkg/analytics` (Go). See [event-flow.md](references/event-flow.md) for emit
   examples.

3. **Update BigQuery views** if the event should appear in dashboard metrics.
   See [bigquery-views.md](references/bigquery-views.md) for view update
   patterns.

4. **Update Grafana dashboard** if adding new panels. See
   [bigquery-views.md](references/bigquery-views.md) for dashboard JSON location
   and push commands.

5. **Update README** — if the event is user-facing or part of the activation
   funnel, update `analytics/README.md` (event table, funnel description,
   dashboard description).

## When Debugging Events

Load [event-flow.md](references/event-flow.md) for BigQuery queries and GCP log
commands.

## Checklist

- [ ] Add constant to `packages/analytics/src/types.ts`
- [ ] Add constant to `pkg/analytics/analytics.go`
- [ ] Emit event from relevant service
- [ ] Test event appears in BigQuery (wait ~1 min for propagation)
- [ ] Update BigQuery views if needed
- [ ] Update Grafana dashboard if needed
- [ ] Update `analytics/README.md` if user-facing

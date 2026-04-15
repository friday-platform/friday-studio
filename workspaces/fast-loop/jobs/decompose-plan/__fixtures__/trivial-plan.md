# Add Batch Metadata to Decompose-Plan Output

## Goal

Extend the decompose-plan job to attach batch-level metadata (timestamp,
plan SHA, operator notes) to each task posted to the autopilot-backlog.
Two phases: schema extension, then runtime wiring.

## Phase 1 — Schema Extension

Extend `DecomposerResultSchema` in
`workspaces/fast-loop/jobs/decompose-plan/schemas.ts` to include an
optional `metadata` object on the batch root:

```ts
metadata: z.object({
  created_at: z.string(),
  operator_notes: z.string().optional(),
}).optional(),
```

Update the JSON Schema in `workspaces/fast-loop/workspace.yml` under
`documentTypes.decomposer-result` to mirror the new field.

### Files

- `workspaces/fast-loop/jobs/decompose-plan/schemas.ts`
- `workspaces/fast-loop/workspace.yml`

### Acceptance Criteria

- [ ] `DecomposerResultSchema` includes optional `metadata` field
- [ ] JSON Schema in workspace.yml matches the Zod schema
- [ ] Existing tests in `schemas.test.ts` still pass
- [ ] `deno check` clean on `schemas.ts`

## Phase 2 — Runtime Wiring

Wire the new metadata into `apply_to_backlog` so each task POST includes
`batch_metadata` in its payload. Update the integrity checker in
`workspaces/fast-loop/jobs/decompose-plan/integrity.ts` to validate
`created_at` is ISO-8601 when present.

### Files

- `workspaces/fast-loop/jobs/decompose-plan/job.ts`
- `workspaces/fast-loop/jobs/decompose-plan/integrity.ts`
- `workspaces/fast-loop/workspace.yml`

### Acceptance Criteria

- [ ] `apply_to_backlog` includes `batch_metadata` in task POST body
- [ ] `integrity.ts` validates `created_at` format when metadata present
- [ ] Existing tests in `job.test.ts` and `integrity.test.ts` still pass
- [ ] New unit test for ISO-8601 validation in `integrity.test.ts`
- [ ] `deno check` clean on modified files

## Dependencies

Phase 2 is blocked by Phase 1 (needs the schema in place first).

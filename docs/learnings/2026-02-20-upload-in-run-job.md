# Team Lead Learnings — artifact-upload session

## Observations

- `.svelte.ts` files have looser type inference for `JSON.parse` (returns any-ish); plain `.ts` files enforce `unknown` — extracted code needs Zod parsing for `JSON.parse` results
- `deno check` cannot parse `.svelte` files directly — use `npx svelte-check --threshold error` instead, but it type-checks the whole project (including pre-existing errors in other packages)
- `vi.fn()` without type parameter produces `Mock<Procedure | Constructable>` which fails assignability to typed callback props — always type mocks: `vi.fn<(arg: T) => R>()`
- `vi.restoreAllMocks()` does not clear call history for `vi.hoisted()` mocks — use `mockReset()` on each hoisted mock explicitly in `beforeEach`

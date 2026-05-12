# OAuth refresh transient-error evals

Three focused evals covering the contract for transient OAuth refresh
failures. Each maps to one of the three goals the feature was scoped to:

| Goal | Eval |
|------|------|
| Don't remove `refresh_token` on transient errors | `refresh-classifier.eval.test.ts` |
| Surface the transient error to chat | `credential-disconnect-shape.eval.test.ts` |
| Chat renders the transient state correctly | `transient-chip-render.eval.test.ts` |

Each eval is small and isolated — no daemon, no real Google. Run as part
of the standard `deno task test` suite.

## Why these three

A. **Classifier preserves the refresh token.** The delegated-refresh
   classifier (`apps/link/src/oauth/delegated.ts`) must categorize 5xx /
   429 / network / timeout / 4xx non-`invalid_grant` as `transient` —
   NOT `token_dead`. Without this, Link's storage path would mark the
   credential `refresh_failed` and silently kill the still-valid
   refresh_token. The eval exercises the matrix of failure modes and
   confirms only `4xx invalid_grant` returns `token_dead`.

B. **Transient state reaches `disconnected[]`.** The
   `LinkCredentialUnavailableError` thrown by the credential resolver
   must be caught per-server by `createMCPTools` and converted to a
   `DisconnectedIntegration` with kind
   `credential_temporarily_unavailable`. Without this, the chat layer
   doesn't know an MCP integration is in a transient state.

C. **Chat renders the right copy.** Given a message carrying a
   `credential_temporarily_unavailable` integration, `chat-message-list`
   must render the transient copy ("try again in a moment") rather than
   the dead-credential copy ("reconnect in Settings"). This is the
   user-visible contract.

import type { Result } from "@atlas/utils";
import type {
  CreateElicitationInput,
  Elicitation,
  ElicitationAnswer,
  ElicitationStatus,
} from "./model.ts";

/**
 * Outcome of one expirePending sweep. `expired` and `skipped` are
 * disjoint id sets so the caller can log / surface both — `skipped`
 * collects entries the CAS fenced off (concurrent answer/decline won)
 * which is informational, not an error.
 */
export interface ExpireSweepResult {
  /** Number of KV entries inspected this tick (subject to `limit`). */
  scanned: number;
  /** Ids successfully transitioned `pending → expired`. */
  expired: string[];
  /** Ids the CAS skipped — concurrent terminal write landed first. */
  skipped: string[];
  /** Per-entry writes that failed for reasons other than CAS. */
  errors: number;
}

/**
 * Storage adapter for elicitations. Single intended implementation
 * (`JetStreamElicitationStorageAdapter`, JetStream stream + KV bucket).
 * All methods return Result<T, string> for consistent error handling.
 */
export interface ElicitationStorageAdapter {
  /**
   * Create a new elicitation. Caller supplies all schema fields except
   * `id` (uuid), `status` (always `pending` on create), and `createdAt`
   * (server-assigned ISO timestamp). Returns the persisted entity.
   */
  create(input: CreateElicitationInput): Promise<Result<Elicitation, string>>;

  /** Get by id. Returns `null` if not found / never created. */
  get(input: { id: string }): Promise<Result<Elicitation | null, string>>;

  /**
   * List elicitations, optionally filtered by workspace, session, or
   * status. No filter ⇒ list everything (Activity-page global view).
   */
  list(input: {
    workspaceId?: string;
    sessionId?: string;
    status?: ElicitationStatus;
  }): Promise<Result<Elicitation[], string>>;

  /**
   * Mark an elicitation answered. Updates the KV status bucket and
   * re-publishes the message envelope so subscribers see the new shape.
   */
  answer(input: { id: string; answer: ElicitationAnswer }): Promise<Result<Elicitation, string>>;

  /** Mark declined. Optional note carried into the elicitation envelope. */
  decline(input: { id: string; note?: string }): Promise<Result<Elicitation, string>>;

  /**
   * Sweep past-deadline `pending` entries and durably flip them to
   * `expired`. Called by the daemon-side sweeper on a timer; pairs
   * with read-time derivation in `get`/`list` so subscribers never
   * see a stale `pending` between sweeper ticks. CAS-guarded — a
   * concurrent answer/decline lands wins, the sweeper skips that id.
   */
  expirePending(input?: { now?: Date; limit?: number }): Promise<Result<ExpireSweepResult, string>>;

  /**
   * Atomically claim the right to run a side-effectful commit for a
   * `pending` elicitation. First caller wins; concurrent callers fail
   * with a "commit already in progress" error. Single-flights the
   * disk-mutating section of `workspace-setup` answer handling so
   * `.env` writes and `workspace.yml` credential pins can't run twice
   * for the same elicitation between the read-and-check and the final
   * `pending → answered` CAS flip in `answer`.
   *
   * **Recovery story (option (b) from the design review):** the reserve
   * is NOT released on commit failure. A subsequent `/answer` for the
   * same elicitation will receive the same 409 — the elicitation is
   * effectively stuck and requires manual recovery. Pairs with a TODO
   * to surface the stuck state in the Activity UI.
   */
  reserveForCommit(input: { id: string }): Promise<Result<void, string>>;
}

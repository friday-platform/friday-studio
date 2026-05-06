import type { Result } from "@atlas/utils";
import type {
  CreateElicitationInput,
  Elicitation,
  ElicitationAnswer,
  ElicitationStatus,
} from "./model.ts";

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
}

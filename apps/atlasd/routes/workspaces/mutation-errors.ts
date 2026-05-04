/**
 * Shared `MutationError` → HTTP response mapper.
 */

import type { MutationError } from "@atlas/config/mutations";
import type { Context } from "hono";

export function mapMutationError(
  c: Context,
  error: MutationError,
  conflictMessage = "Operation conflicts with existing entity",
): Response {
  switch (error.type) {
    case "not_found":
      return c.json(
        {
          success: false,
          error: "not_found",
          entityType: error.entityType,
          entityId: error.entityId,
        },
        404,
      );
    case "validation":
      return c.json(
        { success: false, error: "validation", message: error.message, issues: error.issues },
        400,
      );
    case "conflict":
      return c.json(
        {
          success: false,
          error: "conflict",
          willUnlinkFrom: error.willUnlinkFrom,
          message: conflictMessage,
        },
        409,
      );
    case "invalid_operation":
      return c.json({ success: false, error: "invalid_operation", message: error.message }, 422);
    case "not_supported":
      return c.json({ success: false, error: "not_supported", message: error.message }, 422);
    case "write":
      return c.json({ success: false, error: "write", message: error.message }, 500);
  }
}

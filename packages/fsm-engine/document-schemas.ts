/**
 * Document schemas for FSM engine
 */

import { z } from "zod";

/**
 * Schema for FSM document storage format
 * Documents are stored with their type and data fields
 */
export const FSMDocumentDataSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});

/**
 * Type for FSM document data in storage
 */
export type FSMDocumentData = z.infer<typeof FSMDocumentDataSchema>;

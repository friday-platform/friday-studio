/**
 * Core type definitions for the document store
 */

import { z } from "zod";

export interface DocumentScope {
  workspaceId: string;
  workspaceName?: string;
  sessionId?: string;
}

export interface StoredDocument<TData = unknown> {
  id: string;
  data: TData;
  createdAt: string;
  updatedAt: string;
}

/**
 * Zod schema for validating the StoredDocument envelope
 * Does not validate the data payload (leaves it as unknown)
 */
export const StoredDocumentSchema = z.object({
  id: z.string(),
  data: z.unknown(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

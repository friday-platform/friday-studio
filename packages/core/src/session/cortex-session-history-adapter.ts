/**
 * Cortex (remote HTTP) implementation of SessionHistoryAdapter.
 *
 * Persists complete session data on finalization via a single POST.
 * Reads sessions by querying Cortex metadata filtering.
 * `appendEvent()` is a no-op — cortex only persists on finalization.
 *
 * @module
 */

import process from "node:process";
import { createLogger } from "@atlas/logger";
import type { SessionStreamEvent, SessionSummary, SessionView } from "./session-events.ts";
import type { SessionHistoryAdapter } from "./session-history-adapter.ts";
import { buildSessionView } from "./session-reducer.ts";

const logger = createLogger({ component: "cortex-session-history-adapter" });
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Cortex metadata for session history objects.
 * Stored in the JSONB metadata field of cortex.object table.
 */
interface CortexSessionMetadata {
  session_id: string;
  workspace_id: string;
  job_name: string;
  status: string;
}

/**
 * Cortex API response for object listings.
 */
interface CortexObject {
  id: string;
  metadata: CortexSessionMetadata;
}

/**
 * Shape of the JSON blob stored in Cortex for each session.
 */
interface SessionPayload {
  events: SessionStreamEvent[];
  summary: SessionSummary;
}

/**
 * Remote storage adapter using Cortex blob storage service.
 * Follows the same HTTP + metadata pattern as CortexStorageAdapter for artifacts.
 */
export class CortexSessionHistoryAdapter implements SessionHistoryAdapter {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    let trimmed = baseUrl ?? "";
    while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
    this.baseUrl = trimmed;
  }

  /**
   * No-op. Cortex only persists on finalization.
   * Acceptable per design doc — production daemon restarts are monitored.
   */
  async appendEvent(_sessionId: string, _event: SessionStreamEvent): Promise<void> {
    // Intentional no-op
  }

  /**
   * POST session data blob (events + summary) and set metadata for querying.
   */
  async save(
    sessionId: string,
    events: SessionStreamEvent[],
    summary: SessionSummary,
  ): Promise<void> {
    const payload: SessionPayload = { events, summary };

    // Upload JSON blob
    const uploadResponse = await this.request<{ id: string }>("POST", "/objects", payload, {
      parseJson: true,
    });

    if (!uploadResponse?.id) {
      throw new Error("Failed to upload session blob to Cortex: no ID returned");
    }

    // Set metadata for querying
    const metadata: CortexSessionMetadata = {
      session_id: sessionId,
      workspace_id: summary.workspaceId,
      job_name: summary.jobName,
      status: summary.status,
    };

    await this.request("POST", `/objects/${uploadResponse.id}/metadata`, metadata);
  }

  /**
   * Query for session by metadata, download blob, reduce events to SessionView.
   */
  async get(sessionId: string): Promise<SessionView | null> {
    const params = new URLSearchParams({ "metadata.session_id": sessionId });
    const objects = await this.request<CortexObject[]>("GET", `/objects?${params}`, undefined, {
      parseJson: true,
    });

    if (!objects || objects.length === 0) {
      return null;
    }

    const first = objects[0];
    if (!first) return null;
    const cortexId = first.id;
    const blobContent = await this.request<string>("GET", `/objects/${cortexId}`);

    if (!blobContent) {
      logger.warn("Empty blob for session", { sessionId, cortexId });
      return null;
    }

    const payload = JSON.parse(blobContent) as SessionPayload;
    return buildSessionView(payload.events);
  }

  /**
   * Query for sessions, optionally filtered by workspace. Downloads blobs to extract summaries.
   */
  async listByWorkspace(workspaceId?: string): Promise<SessionSummary[]> {
    const params = workspaceId
      ? new URLSearchParams({ "metadata.workspace_id": workspaceId })
      : new URLSearchParams();
    const objects = await this.request<CortexObject[]>("GET", `/objects?${params}`, undefined, {
      parseJson: true,
    });

    if (!objects || objects.length === 0) {
      return [];
    }

    const summaries: SessionSummary[] = [];

    const results = await Promise.all(
      objects.map(async (obj) => {
        try {
          const blobContent = await this.request<string>("GET", `/objects/${obj.id}`);
          if (!blobContent) return null;

          const payload = JSON.parse(blobContent) as SessionPayload;
          return payload.summary;
        } catch (err) {
          logger.warn("Failed to fetch session blob", { cortexId: obj.id, error: String(err) });
          return null;
        }
      }),
    );

    for (const summary of results) {
      if (summary) summaries.push(summary);
    }

    // Sort by startedAt descending (most recent first)
    summaries.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    return summaries;
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers (follows CortexStorageAdapter pattern)
  // ---------------------------------------------------------------------------

  private getAuthToken(): string {
    const token = process.env.ATLAS_KEY;
    if (!token) {
      throw new Error("ATLAS_KEY not available for Cortex authentication");
    }
    return token;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    options?: { parseJson?: boolean; timeoutMs?: number },
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.getAuthToken()}`,
        "Content-Type": "application/json",
      };

      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (response.status === 401) {
        await response.text();
        throw new Error("Authentication failed: invalid ATLAS_KEY");
      }

      if (response.status === 404) {
        await response.text();
        return null as T;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      if (options?.parseJson) {
        return (await response.json()) as T;
      }

      return (await response.text()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timeout after ${(timeoutMs / 1000).toFixed(1)}s`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

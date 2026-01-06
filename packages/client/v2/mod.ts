import type {
  ArtifactsRoutes,
  ChatRoutes,
  ChatStorageRoutes,
  DaemonRoutes,
  HealthRoutes,
  MeRoutes,
  SessionHistoryRoutes,
  SessionsRoutes,
  WorkspaceRoutes,
} from "@atlas/atlasd";
import type { LinkRoutes } from "@atlas/link";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { fail, type Result, success } from "@atlas/utils";
import {
  type ClientResponse,
  type DetailedError,
  hc,
  type InferRequestType,
  type InferResponseType,
  parseResponse,
} from "hono/client";

export { DetailedError } from "hono/client";

const baseUrl = getAtlasDaemonUrl();

export const client = {
  artifactsStorage: hc<ArtifactsRoutes>(`${baseUrl}/api/artifacts`),
  chat: hc<ChatRoutes>(`${baseUrl}/api/chat`),
  chatStorage: hc<ChatStorageRoutes>(`${baseUrl}/api/chat-storage`),
  daemon: hc<DaemonRoutes>(`${baseUrl}/api/daemon`),
  health: hc<HealthRoutes>(`${baseUrl}/health`),
  link: hc<LinkRoutes>(`${baseUrl}/api/link`),
  me: hc<MeRoutes>(`${baseUrl}/api/me`),
  sessionHistory: hc<SessionHistoryRoutes>(`${baseUrl}/api/sessions-history`),
  sessions: hc<SessionsRoutes>(`${baseUrl}/api/sessions`),
  workspace: hc<WorkspaceRoutes>(`${baseUrl}/api/workspaces`),
};

/**
 * Wraps Hono's parseResponse in a Result type for error handling without exceptions.
 *
 * @param responsePromise - Promise<ClientResponse> from a Hono RPC client call
 * @returns Result with the parsed response value or error
 *
 * @example
 * const result = await parseResult(
 *   client.chatStorage[":streamId"].$get({ param: { streamId: "123" } })
 * );
 *
 * if (result.ok) {
 *   // result.value is automatically typed based on the API response
 *   console.log(result.value);
 * } else {
 *   // result.error is DetailedError or unknown
 *   console.error(result.error);
 * }
 */
// Helper type to extract the parsed response type from parseResponse
type ParsedResponseType<T extends ClientResponse<unknown>> = Awaited<
  ReturnType<typeof parseResponse<T>>
>;

export async function parseResult<T extends ClientResponse<unknown>>(
  responsePromise: T | Promise<T>,
): Promise<Result<ParsedResponseType<T>, DetailedError | unknown>> {
  try {
    const res = await parseResponse(responsePromise);
    // TypeScript isn't able to check complex generics like this.
    return success(res as ParsedResponseType<T>);
  } catch (error) {
    return fail(error);
  }
}

export type { InferRequestType, InferResponseType };

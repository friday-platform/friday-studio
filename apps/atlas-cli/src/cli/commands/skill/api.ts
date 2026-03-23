import process from "node:process";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";

const baseUrl = getAtlasDaemonUrl();

interface ApiResult<T> {
  ok: true;
  data: T;
}

interface ApiError {
  ok: false;
  error: string;
  status: number;
}

/**
 * Typed fetch wrapper for the skills API.
 * Uses plain fetch instead of Hono RPC to avoid type inference issues
 * with complex route types.
 */
export async function skillsApi<T>(
  path: string,
  options?: RequestInit,
): Promise<ApiResult<T> | ApiError> {
  const url = `${baseUrl}/api/skills${path}`;
  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, error: body, status: response.status };
    }
    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), status: 0 };
  }
}

export function exitWithError(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

export function parseSkillRef(ref: string): { namespace: string; name: string } | null {
  const match = ref.match(/^@([a-z0-9-]+)\/([a-z0-9-]+)$/);
  if (!match || !match[1] || !match[2]) return null;
  return { namespace: match[1], name: match[2] };
}

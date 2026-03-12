import { client, parseResult } from "@atlas/client/v2";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = async () => {
  // Load credentials and env vars in parallel
  const [credentialsRes, envVarsRes] = await Promise.all([
    parseResult(client.link.v1.summary.$get({ query: {} })),
    fetch(`${getAtlasDaemonUrl()}/api/config/env`).then((r) => {
      if (!r.ok) return { success: false, envVars: {} };
      return r.json();
    }) as Promise<{
      success: boolean;
      envVars?: Record<string, string>;
      error?: string;
    }>,
  ]);

  if (!credentialsRes.ok) {
    error(500, `Failed to load credentials: ${JSON.stringify(credentialsRes.error)}`);
  }

  const envVars = envVarsRes.success ? (envVarsRes.envVars ?? {}) : {};

  return { ...credentialsRes.data, envVars };
};

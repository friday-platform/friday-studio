import { logger } from "@atlas/logger";
import { z } from "zod";

const K8S_SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";

// Zod schema for external response validation (per CLAUDE.md)
const TokenResponseSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().datetime(),
});

/**
 * Fetches ATLAS_KEY from cypher service using Kubernetes service account token.
 * TLS verification uses DENO_CERT env var (already set in Kubernetes deployment).
 *
 * @throws Error if fetch fails, response is not OK, or response fails validation
 */
export async function fetchCypherToken(url: string): Promise<string> {
  // Trim to remove any trailing newline/whitespace
  const k8sToken = (await Deno.readTextFile(K8S_SA_TOKEN_PATH)).trim();

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${k8sToken}` },
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cypher token request failed: ${response.status} ${body}`);
  }

  const data = TokenResponseSchema.parse(await response.json());

  logger.info("Obtained ATLAS_KEY from cypher", { expires_at: data.expires_at });

  return data.token;
}

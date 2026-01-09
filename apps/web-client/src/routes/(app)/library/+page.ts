import { client, parseResult } from "@atlas/client/v2";
import { ArtifactSchema } from "@atlas/core/artifacts";
import { z } from "zod";
import type { PageLoad } from "./$types";

export const load: PageLoad = async () => {
  const result = await parseResult(client.artifactsStorage.index.$get({ query: { limit: "50" } }));

  if (!result.ok) {
    return { artifacts: [] };
  }

  const parsed = z.array(ArtifactSchema).safeParse(result.data.artifacts);

  return { artifacts: parsed.success ? parsed.data : [] };
};

import { client, parseResult } from "@atlas/client/v2";
import { ArtifactSchema } from "@atlas/core/artifacts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  const result = await parseResult(
    client.artifactsStorage[":id"].$get({ param: { id: params.artifactId }, query: {} }),
  );

  if (!result.ok) {
    return { artifactId: params.artifactId, artifact: null };
  }

  const parsed = ArtifactSchema.safeParse(result.data.artifact);

  return { artifactId: params.artifactId, artifact: parsed.success ? parsed.data : null };
};

import { client, parseResult } from "@atlas/client/v2";
import { ArtifactDataSchema } from "@atlas/core/artifacts";
import { useEffect, useState } from "react";
import type { z } from "zod";
import { Schedule } from "../../components/primitives/schedule.tsx";

export function DisplayArtifact({ artifactId }: { artifactId: string }) {
  const [artifact, setArtifact] = useState<z.infer<typeof ArtifactDataSchema>>();

  useEffect(() => {
    if (artifact || !artifactId) return;

    async function grabArtifact() {
      try {
        const result = (await parseResult(
          client.artifactsStorage[":id"].$get({ param: { id: artifactId }, query: {} }),
        )) as unknown as { ok: boolean; data: { artifact: { data: unknown } } };

        if (!result.ok) throw new Error("Failed to get artifact");

        setArtifact(ArtifactDataSchema.parse(result.data.artifact.data));
      } catch (error) {
        console.error(error);
      }
    }

    grabArtifact();
  }, [artifact, artifactId]);

  if (artifact && artifact.type === "calendar-schedule") {
    return (
      <Schedule
        events={artifact.data.events}
        source={artifact.data.source}
        sourceUrl={artifact.data.sourceUrl}
      />
    );
  }

  return null;
}

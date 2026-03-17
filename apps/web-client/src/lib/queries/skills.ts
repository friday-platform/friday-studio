import { client, parseResult, type InferResponseType } from "@atlas/client/v2";

type SkillsListResponse = InferResponseType<typeof client.skills.index.$get, 200>;

type SkillResponse = InferResponseType<(typeof client.skills)[":skillId"]["$get"], 200>;

export async function createSkill(): Promise<{ skillId: string }> {
  const res = await parseResult(client.skills.index.$post());
  if (!res.ok) throw new Error("Failed to create skill");
  return res.data;
}

export async function listSkills(sort?: "name" | "createdAt"): Promise<SkillsListResponse> {
  const res = await parseResult(client.skills.index.$get({ query: { includeAll: "true", sort } }));
  if (!res.ok) throw new Error(`Failed to load skills: ${JSON.stringify(res.error)}`);
  return res.data;
}

export async function getSkillById(skillId: string): Promise<SkillResponse> {
  const res = await parseResult(client.skills[":skillId"].$get({ param: { skillId } }));
  if (!res.ok) throw new Error("Failed to load skill");
  return res.data;
}

export async function disableSkill(skillId: string, disabled: boolean) {
  const res = await parseResult(
    client.skills[":skillId"].disable.$patch({ param: { skillId }, json: { disabled } }),
  );
  if (!res.ok) throw new Error("Failed to update skill");
  return res.data;
}

export async function deleteSkill(skillId: string) {
  const res = await parseResult(client.skills[":skillId"].$delete({ param: { skillId } }));
  if (!res.ok) throw new Error("Failed to delete skill");
  return res.data;
}

export async function publishSkill(
  namespace: string,
  name: string,
  input: {
    title?: string;
    description?: string;
    instructions: string;
    skillId?: string;
    descriptionManual?: boolean;
  },
) {
  const res = await parseResult(
    client.skills[":namespace"][":name"].$post({
      param: { namespace: `@${namespace}`, name },
      json: input,
    }),
  );
  if (!res.ok) throw new Error("Failed to publish skill");
  return res.data.published;
}

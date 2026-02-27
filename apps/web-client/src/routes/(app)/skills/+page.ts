import { listSkills } from "$lib/queries/skills";
import type { PageLoad } from "./$types";

export const load: PageLoad = async () => {
  const { skills } = await listSkills("createdAt");
  return { skills };
};

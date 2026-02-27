import { error } from "@sveltejs/kit";
import { getSkillById } from "$lib/queries/skills";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  const skill = await getSkillById(params.skillId).catch(() => {
    error(404, "unable to load skill");
  });
  return { initialSkill: skill };
};

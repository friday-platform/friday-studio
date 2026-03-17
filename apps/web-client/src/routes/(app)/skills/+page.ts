import * as Sentry from "@sentry/sveltekit";
import { listSkills } from "$lib/queries/skills";
import type { PageLoad } from "./$types";

export const load: PageLoad = async () => {
  try {
    const { skills } = await listSkills("createdAt");
    return { skills };
  } catch (err) {
    Sentry.captureException(err);
    return { skills: [] };
  }
};

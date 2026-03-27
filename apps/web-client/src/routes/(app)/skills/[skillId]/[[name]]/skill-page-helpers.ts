/**
 * Pure helper functions extracted from skill detail page for testability.
 */

export interface SkillDraft {
  instructions: string;
  slug: string;
  description: string;
  descriptionManual: boolean;
}

export interface SkillData {
  instructions: string;
  name: string | null;
  description: string;
  descriptionManual: boolean;
}

/** Returns true when draft diverges from persisted skill data. */
export function isDirty(draft: SkillDraft, skill: SkillData | undefined): boolean {
  if (!skill) return false;
  return (
    draft.instructions !== skill.instructions ||
    draft.slug !== (skill.name ?? "") ||
    draft.description !== skill.description ||
    draft.descriptionManual !== skill.descriptionManual
  );
}

/**
 * Determines whether a beforeNavigate callback should intercept the navigation
 * (cancel it, save, then re-navigate programmatically).
 *
 * Returns false for "goto" navigations to prevent an infinite loop: the
 * programmatic goto fired in onSuccess re-triggers beforeNavigate, so we must
 * let it pass through.
 */
export function shouldInterceptNavigation(navigationType: string, dirty: boolean): boolean {
  if (navigationType === "goto") return false;
  return dirty;
}

/**
 * Resolves the descriptionManual flag after a description input event.
 * - If the user types anything, mark as manual.
 * - If the user clears the description, revert to auto-generated.
 */
export function resolveDescriptionManual(currentManual: boolean, description: string): boolean {
  if (!currentManual && description.trim()) return true;
  if (!description.trim()) return false;
  return currentManual;
}

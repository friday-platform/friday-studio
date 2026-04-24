import type { FSMDefinition } from "../../types.ts";

export const userOnboardingFSM: FSMDefinition = {
  id: "user-onboarding",
  initial: "new_user",
  states: {
    new_user: {
      on: {
        COMPLETE_PROFILE: {
          target: "active",
          actions: [{ type: "emit", event: "user.onboarded" }],
        },
      },
    },
    active: { type: "final" },
  },
};

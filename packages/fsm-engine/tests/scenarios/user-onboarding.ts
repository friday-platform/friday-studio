import type { FSMDefinition } from "../../types.ts";

export const userOnboardingFSM: FSMDefinition = {
  id: "user-onboarding",
  initial: "new_user",
  states: {
    new_user: {
      on: {
        COMPLETE_PROFILE: {
          target: "active",
          actions: [
            { type: "code", function: "createProfile" },
            { type: "emit", event: "user.onboarded" },
          ],
        },
      },
    },
    active: { type: "final" },
  },
  functions: {
    createProfile: {
      type: "action",
      code: `
        export default (context, event) => {
          const userId = event.data?.userId || 'unknown';
          if (context.createDoc) {
            context.createDoc({
              id: 'profile',
              type: 'profile',
              data: { userId, completedAt: new Date().toISOString() }
            });
          }
        }
      `,
    },
  },
  documentTypes: {
    profile: {
      type: "object",
      properties: { userId: { type: "string" }, completedAt: { type: "string" } },
      required: ["userId", "completedAt"],
    },
  },
};

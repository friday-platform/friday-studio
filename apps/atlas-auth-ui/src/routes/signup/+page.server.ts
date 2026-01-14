import { fail, redirect, type Actions } from "@sveltejs/kit";
import { BOUNCE_URL } from "$lib/env";
import { zfd } from "zod-form-data";

const signupSchema = zfd.formData({ email: zfd.text() });

export const actions: Actions = {
  default: async ({ request, fetch }) => {
    const formData = await request.formData();
    const input = signupSchema.safeParse(formData);

    if (!input.success) {
      return fail(400, { data: Object.fromEntries(formData), error: input.error.flatten() });
    }

    try {
      const response = await fetch(`${BOUNCE_URL}/signup/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: input.data.email }),
      });

      if (!response.ok && response.status !== 409 && response.status !== 425) {
        console.error(`Bounce API returned ${response.status}`);
      }
    } catch (error) {
      console.error("Signup error:", error);
    }

    redirect(303, `/signup-confirmation?email=${encodeURIComponent(input.data.email)}`);
  },
};

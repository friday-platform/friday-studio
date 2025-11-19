import { type Actions, fail, redirect } from "@sveltejs/kit";
import { zfd } from "zod-form-data";
import { BOUNCE_URL } from "$lib/env";

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

      if (!response.ok) {
        throw new Error(`Bounce API returned ${response.status}`);
      }

      redirect(303, `/signup-confirmation?email=${encodeURIComponent(input.data.email)}`);
    } catch (error) {
      if (error instanceof Response && error.status >= 300 && error.status < 400) {
        throw error;
      }
      console.error("Signup error:", error);
      return fail(500, { message: "Failed to complete signup" });
    }
  },
};

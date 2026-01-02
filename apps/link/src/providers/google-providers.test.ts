import { assertEquals } from "@std/assert";

// Import all provider factories from consolidated module
import {
  createGoogleCalendarProvider,
  createGoogleDocsProvider,
  createGoogleDriveProvider,
  createGoogleGmailProvider,
  createGoogleSheetsProvider,
} from "./google-providers.ts";

// Provider factories with expected metadata
const PROVIDERS = [
  { factory: createGoogleCalendarProvider, id: "google-calendar", scope: "calendar" },
  { factory: createGoogleGmailProvider, id: "google-gmail", scope: "gmail.modify" },
  { factory: createGoogleDriveProvider, id: "google-drive", scope: "drive" },
  { factory: createGoogleDocsProvider, id: "google-docs", scope: "documents" },
  { factory: createGoogleSheetsProvider, id: "google-sheets", scope: "spreadsheets" },
] as const;

Deno.test("Google providers return undefined when env not configured", () => {
  // Save and clear env vars
  const original = {
    id: Deno.env.get("GOOGLE_CLIENT_ID_FILE"),
    secret: Deno.env.get("GOOGLE_CLIENT_SECRET_FILE"),
  };
  Deno.env.delete("GOOGLE_CLIENT_ID_FILE");
  Deno.env.delete("GOOGLE_CLIENT_SECRET_FILE");

  try {
    for (const { factory, id } of PROVIDERS) {
      const provider = factory();
      assertEquals(provider, undefined, `${id} should return undefined without env`);
    }
  } finally {
    // Restore env vars
    if (original.id) Deno.env.set("GOOGLE_CLIENT_ID_FILE", original.id);
    if (original.secret) Deno.env.set("GOOGLE_CLIENT_SECRET_FILE", original.secret);
  }
});

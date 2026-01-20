import process from "node:process";
import { describe, expect, it } from "vitest";

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

describe("Google providers", () => {
  it("return undefined when env not configured", () => {
    // Save and clear env vars
    const original = {
      id: process.env.GOOGLE_CLIENT_ID_FILE,
      secret: process.env.GOOGLE_CLIENT_SECRET_FILE,
    };
    delete process.env.GOOGLE_CLIENT_ID_FILE;
    delete process.env.GOOGLE_CLIENT_SECRET_FILE;

    try {
      for (const { factory, id } of PROVIDERS) {
        const provider = factory();
        expect(provider, `${id} should return undefined without env`).toBeUndefined();
      }
    } finally {
      // Restore env vars
      if (original.id) process.env.GOOGLE_CLIENT_ID_FILE = original.id;
      if (original.secret) process.env.GOOGLE_CLIENT_SECRET_FILE = original.secret;
    }
  });
});

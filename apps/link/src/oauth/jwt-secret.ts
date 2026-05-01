import { readFileSync } from "node:fs";
import process from "node:process";

const secretFile = process.env.LINK_STATE_SIGNING_KEY_FILE;
export const STATE_JWT_SECRET = secretFile
  ? readFileSync(secretFile, "utf-8").trim()
  : crypto.randomUUID();

import process from "node:process";
import { displayVersion, displayVersionWithRemote } from "../utils/version-display.ts";

interface VersionArgs {
  json?: boolean;
  remote?: boolean;
}

export const command = "version";
export const desc = "Show Atlas version information";
export const aliases = ["v"];

export const builder = {
  json: {
    type: "boolean" as const,
    describe: "Output version information as JSON",
    default: false,
  },
  remote: {
    type: "boolean" as const,
    describe: "Check for newer version from remote server",
    default: false,
  },
};

export const handler = async (argv: VersionArgs): Promise<void> => {
  if (argv.remote) {
    await displayVersionWithRemote(argv.json);
  } else {
    displayVersion(argv.json);
  }
  process.exit(0);
};

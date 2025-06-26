import { displayVersion } from "../../utils/version.ts";

interface VersionArgs {
  json?: boolean;
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
};

export const handler = (argv: VersionArgs): void => {
  displayVersion(argv.json);
  Deno.exit(0);
};

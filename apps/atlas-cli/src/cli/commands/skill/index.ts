import { define } from "gunshi";
import { alias } from "../../../utils/alias.ts";
import { getCommand } from "./get.ts";
import { listCommand } from "./list.ts";
import { publishCommand } from "./publish.ts";
import { versionsCommand } from "./versions.ts";

export const skillCommand = define({
  name: "skill",
  description: "Manage skills",
  rendering: { header: null },
  subCommands: {
    list: listCommand,
    ls: alias(listCommand),
    get: getCommand,
    publish: publishCommand,
    pub: alias(publishCommand),
    versions: versionsCommand,
  },
  run: () => {
    console.log("Usage: atlas skill <command>");
    console.log("");
    console.log("Commands:");
    console.log("  list, ls       List published skills");
    console.log("  get            Get skill details");
    console.log("  publish, pub   Publish a skill from a directory");
    console.log("  versions       List all versions of a skill");
  },
});

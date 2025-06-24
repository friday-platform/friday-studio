import React from "react";
import { render } from "ink";
import { Text } from "ink";
import { LogViewer } from "../../cli/components/LogViewer.tsx";
import yargs from "yargs";

export const command = "logs <session-id>";
export const desc = "View session logs";
export const aliases = ["log"];

export function builder(y: ReturnType<typeof yargs>) {
  return y
    .positional("session-id", {
      describe: "Session ID to view logs for",
      type: "string",
    })
    .option("follow", {
      alias: "f",
      type: "boolean",
      description: "Follow log output",
      default: true,
    })
    .option("tail", {
      alias: "t",
      type: "number",
      description: "Number of lines to show from the end",
      default: 100,
    })
    .option("agent", {
      alias: "a",
      type: "string",
      description: "Filter logs by agent name",
    })
    .option("level", {
      alias: "l",
      type: "string",
      description: "Filter logs by level",
      choices: ["debug", "info", "warn", "error"],
    })
    .option("no-follow", {
      type: "boolean",
      description: "Don't follow log output",
      default: false,
    });
}

export async function handler(argv: any) {
  const sessionId = argv.sessionId;

  if (!sessionId) {
    console.error("Error: Session ID is required");
    console.error("Usage: atlas logs <session-id>");
    process.exit(1);
  }

  // Handle --no-follow flag
  const follow = argv.noFollow ? false : argv.follow;

  render(
    <LogViewer
      sessionId={sessionId}
      follow={follow}
      tail={argv.tail}
      filter={{
        agent: argv.agent,
        level: argv.level,
      }}
    />,
  );
}

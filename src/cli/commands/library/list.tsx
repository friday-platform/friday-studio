import { render } from "ink";
import { LibraryListComponent } from "../../modules/library/library-list-component.tsx";
import { fetchLibraryItems } from "../../modules/library/fetcher.ts";
import { YargsInstance } from "../../utils/yargs.ts";
import { spinner } from "../../utils/prompts.tsx";
import process from "node:process";

interface ListArgs {
  type?: string;
  tags?: string;
  since?: string;
  limit: number;
  workspace?: string;
  json: boolean;
  port: number;
}

export const command = "list";
export const desc = "List library items";

export function builder(y: YargsInstance) {
  return y
    .option("type", {
      alias: "t",
      type: "string",
      description: "Filter by item type",
    })
    .option("tags", {
      type: "string",
      description: "Filter by tags (comma-separated)",
    })
    .option("since", {
      alias: "s",
      type: "string",
      description: "Show items created since (e.g., '7d', '2024-01-01')",
    })
    .option("limit", {
      alias: "l",
      type: "number",
      description: "Maximum number of items to display",
      default: 50,
    })
    .option("workspace", {
      alias: "w",
      type: "string",
      description: "Workspace directory",
    })
    .option("json", {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    })
    .option("port", {
      alias: "p",
      type: "number",
      description: "Server port",
      default: 8080,
    });
}

export async function handler(argv: ListArgs) {
  const s = spinner();

  try {
    s.start("Fetching library items...");

    const result = await fetchLibraryItems({
      type: argv.type,
      tags: argv.tags,
      since: argv.since,
      limit: argv.limit,
      workspace: argv.workspace,
      port: argv.port,
    });

    if (!result.success) {
      s.stop("Failed to fetch library items");
      console.error(`Error: ${(result as any).error || "Unknown error"}`);
      process.exit(1);
      return;
    }

    const items = result.items;
    s.stop("Library items fetched");

    if (argv.json) {
      console.log(JSON.stringify({ items, count: items.length }, null, 2));
      return;
    }

    if (items.length === 0) {
      console.log("No library items found");
      return;
    }

    render(<LibraryListComponent items={items} />);
  } catch (error) {
    s.stop("Failed to fetch library items");
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

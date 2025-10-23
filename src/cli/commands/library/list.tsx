import process from "node:process";
import type { LibrarySearchQuery } from "@atlas/client";
import { parseResult, client as v2Client } from "@atlas/client/v2";
import { render } from "ink";
import { LibraryListComponent } from "../../modules/library/library-list-component.tsx";
import { createDaemonNotRunningError, getDaemonClient } from "../../utils/daemon-client.ts";
import { spinner } from "../../utils/prompts.tsx";
import type { YargsInstance } from "../../utils/yargs.ts";

interface ListArgs {
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
    .option("tags", { type: "string", description: "Filter by tags (comma-separated)" })
    .option("since", {
      type: "string",
      description: "Show items created since (e.g., '7d', '2024-01-01')",
    })
    .option("limit", {
      alias: "l",
      type: "number",
      description: "Maximum number of items to display",
      default: 50,
    })
    .option("workspace", { alias: "w", type: "string", description: "Workspace directory" })
    .option("json", { type: "boolean", description: "Output as JSON", default: false })
    .option("port", { alias: "p", type: "number", description: "Server port", default: 8080 });
}

export async function handler(argv: ListArgs) {
  const s = spinner();

  try {
    // Check if daemon is running
    const health = await parseResult(v2Client.health.index.$get());
    if (!health.ok) {
      s.stop("Failed to fetch library items");
      throw createDaemonNotRunningError();
    }

    s.start("Fetching library items...");

    const client = getDaemonClient();
    const query: LibrarySearchQuery = { limit: argv.limit || 50, offset: 0 };

    if (argv.tags) query.tags = argv.tags.split(",").map((tag) => tag.trim());
    if (argv.since) query.since = argv.since;

    const result = await client.listLibraryItems(query);
    const items = result.items;

    s.stop("Library items fetched");

    if (argv.json) {
      console.log(JSON.stringify({ items, count: items.length, total: result.total }, null, 2));
      return;
    }

    if (items.length === 0) {
      console.log("No library items found");
      return;
    }

    // Convert to format expected by component
    const componentItems = items.map((item) => ({
      id: item.id,
      source: item.metadata.source,
      name: item.name,
      description: item.description,
      created_at: item.created_at,
      updated_at: item.updated_at,
      tags: item.tags,
      size_bytes: item.size_bytes,
      session_id: item.metadata.session_id,
      agent_ids: item.metadata.agent_ids,
      custom_fields: item.metadata.custom_fields,
    }));

    const { unmount } = render(<LibraryListComponent items={componentItems} />);
    setTimeout(() => unmount(), 100);
  } catch (error) {
    s.stop("Failed to fetch library items");
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

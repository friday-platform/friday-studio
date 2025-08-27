import process from "node:process";
import { render } from "ink";
import { LibraryListComponent } from "../../modules/library/library-list-component.tsx";
import {
  checkDaemonRunning,
  createDaemonNotRunningError,
  getDaemonClient,
} from "../../utils/daemon-client.ts";
import { spinner } from "../../utils/prompts.tsx";
import type { YargsInstance } from "../../utils/yargs.ts";

interface ListArgs {
  source?: string;
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
    .option("source", { alias: "s", type: "string", description: "Filter by item source" })
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
    if (!(await checkDaemonRunning())) {
      s.stop("Failed to fetch library items");
      throw createDaemonNotRunningError();
    }

    s.start("Fetching library items...");

    const client = getDaemonClient();
    const query: any = {};

    if (argv.source) query.source = argv.source;
    if (argv.tags) query.tags = argv.tags.split(",").map((tag) => tag.trim());
    if (argv.since) query.since = argv.since;
    if (argv.limit) query.limit = argv.limit;

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
      source: item.source,
      name: item.name,
      description: item.description,
      created_at: item.created_at,
      updated_at: item.updated_at,
      tags: item.tags,
      size_bytes: item.size_bytes,
      mime_type: item.mime_type,
      session_id: item.session_id,
      agent_ids: item.agent_ids,
      template_id: item.template_id,
      generated_by: item.generated_by,
      custom_fields: item.custom_fields,
    }));

    const { unmount } = render(<LibraryListComponent items={componentItems} />);
    setTimeout(() => unmount(), 100);
  } catch (error) {
    s.stop("Failed to fetch library items");
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

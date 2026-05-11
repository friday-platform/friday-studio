/**
 * Auto-snapshot an inline chat <table> to a markdown artifact so the
 * dedicated table-view route can render it. Used by the inline-table
 * Actions dropdown's "Open in dedicated view" path — the chat
 * rendered the table from markdown that lives only inside an
 * assistant message's `parts[]`, so to give it a stable shareable
 * URL we materialize it as an artifact.
 *
 * Durable on purpose. Chat sessions don't have a discrete end event
 * the ephemeral-artifact sweeper can hook into; binding to a chat
 * id would mean "never expire" in practice. Snapshots are tiny
 * (markdown text), the user clicked "open" so they signalled intent,
 * and a shareable URL is the main feature — keep them.
 *
 * Returns the new artifact id on success; throws on any failure so
 * the caller can surface a flash message instead of silently
 * navigating to a dead route.
 */
import { tableToMarkdown } from "./table-to-markdown.ts";

export interface SnapshotOptions {
  /** Workspace the artifact should be tagged with. */
  workspaceId: string;
  /** Chat id the snapshot was triggered from — recorded on the
   *  artifact for back-reference but otherwise has no semantic. */
  chatId?: string;
  /** Optional explicit title; defaults to "Table from chat". */
  title?: string;
}

export async function snapshotTableToArtifact(
  table: HTMLTableElement,
  opts: SnapshotOptions,
): Promise<string> {
  const md = tableToMarkdown(table);
  if (!md) throw new Error("Cannot snapshot an empty table.");

  // Count cells for the summary line. Cheap — already walked once
  // by tableToMarkdown above; the duplicate walk here lets the
  // summary stay independent of the serializer's internals.
  const rowCount = Math.max(0, table.querySelectorAll("tr").length - 1);
  const colCount = table.querySelectorAll("tr:first-child > *").length;

  // Title preference order:
  //   1. explicit opts.title — caller-provided override
  //   2. originating chat's own title — most meaningful for the
  //      operator browsing /artifacts later ("Table from Wide Table"
  //      reads better than "Table from chat" repeated forever)
  //   3. timestamp fallback — uniqueness when no chat title is
  //      available (anonymous chats, snapshots before titles land)
  let title = opts.title?.trim();
  if (!title) {
    const chatTitle = opts.chatId ? await fetchChatTitle(opts.workspaceId, opts.chatId) : null;
    if (chatTitle) {
      title = `Table from ${chatTitle}`;
    } else {
      const ts = new Date()
        .toISOString()
        .slice(0, 16)
        .replace("T", " ");
      title = `Table — ${ts}`;
    }
  }
  const summary =
    `Snapshot of an inline chat table — ${colCount} ` +
    `column${colCount === 1 ? "" : "s"} × ${rowCount} row${rowCount === 1 ? "" : "s"}.`;

  const res = await fetch("/api/daemon/api/artifacts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: {
        type: "file",
        content: md,
        mimeType: "text/markdown",
        originalName: `${slugifyTitle(title)}.md`,
      },
      title,
      summary,
      workspaceId: opts.workspaceId,
      ...(opts.chatId ? { chatId: opts.chatId } : {}),
      lifecycle: { kind: "durable" },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`snapshot failed: HTTP ${res.status} ${text}`);
  }
  const body = (await res.json()) as { artifact?: { id?: string } };
  const id = body.artifact?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("snapshot response missing artifact id");
  }
  return id;
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "table";
}

/**
 * Best-effort chat-title lookup. Network failure or 404 returns null
 * so the caller falls through to its timestamp fallback — we never
 * want a missing title to block the snapshot.
 */
async function fetchChatTitle(workspaceId: string, chatId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(chatId)}`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { chat?: { title?: string } };
    const title = body.chat?.title?.trim();
    return title && title.length > 0 ? title : null;
  } catch {
    return null;
  }
}

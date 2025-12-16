import type { ArtifactType } from "@atlas/core/artifacts";
import { createColumnHelper } from "@tanstack/svelte-table";
import { formatChatDate } from "../../utils/date.ts";

function formatType(t: string): string {
  return t.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const columnHelper = createColumnHelper<{
  id: string;
  type: ArtifactType;
  title: string;
  createdAt: string;
}>();

export const artifactColumns = [
  columnHelper.accessor("title", {
    id: "title",
    header: "Title",
    meta: { minWidth: "0", bold: true },
  }),
  columnHelper.accessor("type", {
    id: "type",
    header: "Type",
    cell: (info) => formatType(info.getValue()),
    meta: { align: "center", faded: true, shrink: true, size: "small" },
  }),
  columnHelper.accessor("createdAt", {
    id: "createdAt",
    header: "Created",
    cell: (info) => formatChatDate(info.getValue()),
    meta: { align: "center", faded: true, shrink: true, size: "small" },
  }),
];

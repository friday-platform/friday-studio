import type { ResourceDeclaration } from "@atlas/schemas/workspace";
import type { ResourceEntry } from "./types.ts";

/** Extract a single variant from the ResourceEntry discriminated union. */
type ResourceEntryOf<T extends ResourceEntry["type"]> = Extract<ResourceEntry, { type: T }>;

/** Formats a row count as a compact string (e.g. 1.8M, 50K, 42). */
function formatRowCount(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }
  return String(count);
}

/**
 * Options for tool-aware resource guidance rendering.
 * @property availableTools - When provided, instructions are adapted to the caller's tool surface.
 *   e.g. if `resource_link_ref` is absent, unregistered external refs emit `delegate` guidance instead.
 */
export interface ResourceGuidanceOptions {
  availableTools?: readonly string[];
}

export function buildResourceGuidance(
  resources: ResourceEntry[],
  options?: ResourceGuidanceOptions,
): string {
  const documents = resources.filter(
    (r): r is ResourceEntryOf<"document"> => r.type === "document",
  );
  const datasets = resources.filter(
    (r): r is ResourceEntryOf<"artifact_ref"> =>
      r.type === "artifact_ref" && r.artifactType === "database",
  );
  const files = resources.filter(
    (r): r is ResourceEntryOf<"artifact_ref"> =>
      r.type === "artifact_ref" &&
      r.artifactType !== "database" &&
      r.artifactType !== "unavailable",
  );
  const externals = resources.filter(
    (r): r is ResourceEntryOf<"external_ref"> => r.type === "external_ref",
  );

  if (
    documents.length === 0 &&
    datasets.length === 0 &&
    files.length === 0 &&
    externals.length === 0
  ) {
    return "";
  }

  const lines: string[] = ["## Workspace Resources"];

  if (documents.length > 0) {
    lines.push("", "Documents (use resource_read for queries, resource_write for mutations):");
    for (const d of documents) {
      lines.push(`- ${d.slug}: ${d.description}`);
    }
  }

  if (datasets.length > 0) {
    lines.push("", "Datasets (read-only, query via data-analyst / DuckDB):");
    for (const d of datasets) {
      const rowSuffix = d.rowCount != null ? `, ${formatRowCount(d.rowCount)} rows` : "";
      lines.push(`- ${d.slug} (artifact ${d.artifactId}${rowSuffix}): ${d.description}`);
    }
  }

  if (files.length > 0) {
    lines.push("", "Files (read-only, access via artifacts_get):");
    for (const f of files) {
      lines.push(`- ${f.slug} (artifact ${f.artifactId}): ${f.description}`);
    }
  }

  if (externals.length > 0) {
    lines.push("", "External Resources:");
    for (const r of externals) {
      if (r.ref) {
        lines.push(`- ${r.slug} (${r.provider}, ref: ${r.ref}): ${r.description}`);
      } else {
        const hasLinkRef =
          !options?.availableTools || options.availableTools.includes("resource_link_ref");
        const instruction = hasLinkRef
          ? `→ Create this resource using ${r.provider} MCP tools, then call resource_link_ref with the URL/ID to register it.`
          : `→ Use delegate to create and register this resource.`;
        lines.push(
          `- ${r.slug} (${r.provider}, unregistered): ${r.description}`,
          `  ${instruction}`,
        );
      }
    }
  }

  return lines.join("\n");
}

/** Builds resource guidance text from ResourceDeclaration records. Used at plan time. */
export function buildDeclarationGuidance(resources: ResourceDeclaration[]): string {
  const documents = resources.filter((r) => r.type === "document");
  const prose = resources.filter((r) => r.type === "prose");
  const artifactRefs = resources.filter((r) => r.type === "artifact_ref");
  const externals = resources.filter((r) => r.type === "external_ref");

  if (
    documents.length === 0 &&
    prose.length === 0 &&
    artifactRefs.length === 0 &&
    externals.length === 0
  ) {
    return "";
  }

  const lines: string[] = ["## Workspace Resources"];

  if (documents.length > 0) {
    lines.push("", "Documents (use resource_read for queries, resource_write for mutations):");
    for (const d of documents) {
      lines.push(`- ${d.slug}: ${d.description}`);
    }
  }

  if (prose.length > 0) {
    lines.push("", "Prose Documents (use resource_read / resource_write for full content):");
    for (const p of prose) {
      lines.push(`- ${p.slug}: ${p.description}`);
    }
  }

  if (artifactRefs.length > 0) {
    lines.push("", "Datasets (read-only, query via data-analyst / DuckDB):");
    for (const a of artifactRefs) {
      lines.push(`- ${a.slug} (artifact ${a.artifactId}): ${a.description}`);
    }
  }

  if (externals.length > 0) {
    lines.push("", "External Resources:");
    for (const r of externals) {
      if (r.ref) {
        lines.push(`- ${r.slug} (${r.provider}, ref: ${r.ref}): ${r.description}`);
      } else {
        lines.push(
          `- ${r.slug} (${r.provider}, unregistered): ${r.description}`,
          `  → Create this resource using ${r.provider} MCP tools, then call resource_link_ref with the URL/ID to register it.`,
        );
      }
    }
  }

  return lines.join("\n");
}

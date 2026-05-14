import { isOfficialCanonicalName } from "@atlas/core/mcp-registry/annotations";
import type { MCPServerMetadata, MCPSource } from "@atlas/core/mcp-registry/schemas";

export function sourceLabel(src: MCPSource): string {
  switch (src) {
    case "static":
      return "Bundled";
    case "registry":
      return "Registry";
    case "web":
      return "Web";
    case "agents":
      return "Agents";
    case "workspace":
      return "Workspace";
  }
}

export function isOfficialServer(server: Pick<MCPServerMetadata, "upstream">): boolean {
  return (
    !!server.upstream?.canonicalName && isOfficialCanonicalName(server.upstream.canonicalName)
  );
}

/**
 * Shorten a server name for display. Reverse-DNS names
 * (`io.github.owner/repo`, `com.stripe/mcp`) lead with vendor/host segments
 * that aren't worth the width — drop the first two dot-segments. A plain name
 * with fewer than three dot-segments is returned unchanged.
 */
export function shortenServerName(name: string): string {
  const parts = name.split(".");
  return parts.length >= 3 ? parts.slice(2).join(".") : name;
}

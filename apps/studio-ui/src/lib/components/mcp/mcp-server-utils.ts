import { isOfficialCanonicalName } from "@atlas/core/mcp-registry/official-servers";
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

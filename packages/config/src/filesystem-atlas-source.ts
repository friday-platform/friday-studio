/**
 * Filesystem-backed `AtlasConfigSource`. Wraps the existing `ConfigLoader`
 * with a minimal inline `ConfigurationAdapter` so platform config loading
 * shares the same parse/validate path as workspace config loading.
 */

import { readFile, stat } from "node:fs/promises";
import { parse as parseYaml } from "@std/yaml";
import type { AtlasConfigSource } from "./atlas-source.ts";
import { ConfigLoader } from "./config-loader.ts";
import type { ConfigurationAdapter } from "./configuration-adapter.ts";
import type { AtlasConfig } from "./workspace.ts";

class InlineFilesystemAdapter implements ConfigurationAdapter {
  constructor(private readonly workspacePath: string) {}

  async readYaml(path: string): Promise<unknown> {
    const content = await readFile(path, "utf-8");
    return parseYaml(content);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }
}

/**
 * Reads `friday.yml` from a directory via `ConfigLoader.loadAtlas()`.
 * Preserves existing semantics: missing file → null, empty file → null,
 * malformed file → throws `ConfigValidationError`.
 */
export class FilesystemAtlasConfigSource implements AtlasConfigSource {
  private readonly loader: ConfigLoader;

  constructor(cwd: string) {
    this.loader = new ConfigLoader(new InlineFilesystemAdapter(cwd), cwd);
  }

  load(): Promise<AtlasConfig | null> {
    return this.loader.loadAtlas();
  }
}

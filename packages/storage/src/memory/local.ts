import { getAtlasHome } from "@atlas/utils";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { ITempestMemoryStorageAdapter } from "../types/core.ts";

export class LocalFileStorageAdapter implements ITempestMemoryStorageAdapter {
  private storagePath: string;

  constructor(storagePath?: string) {
    if (storagePath) {
      this.storagePath = storagePath;
    } else {
      // Use the centralized getAtlasHome function
      this.storagePath = join(getAtlasHome(), "memory");
    }
  }

  async commit(data: any): Promise<void> {
    await ensureDir(this.storagePath);
    const filePath = join(this.storagePath, "memory.json");
    await Deno.writeTextFile(filePath, JSON.stringify(data, null, 2));
  }

  async load(): Promise<any> {
    const filePath = join(this.storagePath, "memory.json");
    try {
      const content = await Deno.readTextFile(filePath);
      return JSON.parse(content);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }
}

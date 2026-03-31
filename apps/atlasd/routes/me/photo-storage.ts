import { Buffer } from "node:buffer";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { createLogger } from "@atlas/logger";
import { getAtlasHome } from "@atlas/utils/paths.server";

const logger = createLogger({ name: "photo-storage" });

const PHOTO_DIR = "profile-photos";

const ALLOWED_MIME_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const MAX_PHOTO_SIZE = 5 * 1024 * 1024; // 5MB

function getPhotoDir(): string {
  return join(getAtlasHome(), PHOTO_DIR);
}

export function validatePhoto(
  file: File,
): { valid: true; ext: string } | { valid: false; error: string } {
  if (file.size > MAX_PHOTO_SIZE) {
    return { valid: false, error: "Photo must be under 5MB" };
  }

  const ext = ALLOWED_MIME_TYPES[file.type];
  if (!ext) {
    return { valid: false, error: "Photo must be PNG, JPEG, GIF, or WebP" };
  }

  return { valid: true, ext };
}

export async function savePhoto(userId: string, data: ArrayBuffer, ext: string): Promise<void> {
  const dir = getPhotoDir();
  await mkdir(dir, { recursive: true });

  // Remove any existing photo for this user (different extension)
  await removeExistingPhotos(userId);

  const filePath = join(dir, `${userId}${ext}`);
  await writeFile(filePath, Buffer.from(data));
  logger.info("Saved profile photo", { userId, ext });
}

export async function getPhoto(
  userId: string,
): Promise<{ data: Uint8Array; contentType: string } | null> {
  const dir = getPhotoDir();

  // Look for any file matching the userId
  for (const [mime, ext] of Object.entries(ALLOWED_MIME_TYPES)) {
    try {
      const filePath = join(dir, `${userId}${ext}`);
      const data = await readFile(filePath);
      return { data, contentType: mime };
    } catch {
      // File doesn't exist with this extension, try next
    }
  }

  return null;
}

export async function deletePhoto(userId: string): Promise<void> {
  await removeExistingPhotos(userId);
  logger.info("Deleted profile photo", { userId });
}

async function removeExistingPhotos(userId: string): Promise<void> {
  const dir = getPhotoDir();
  try {
    const files = await readdir(dir);
    for (const file of files) {
      const ext = extname(file);
      const base = file.slice(0, -ext.length);
      if (base === userId) {
        await unlink(join(dir, file));
      }
    }
  } catch {
    // Directory doesn't exist yet
  }
}

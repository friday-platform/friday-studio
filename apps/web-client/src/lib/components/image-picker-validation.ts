export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const ACCEPT_STRING = ACCEPTED_TYPES.join(",");

export function validateImageFile(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return "File must be an image (PNG, JPEG, GIF, or WebP)";
  }
  if (file.size > MAX_FILE_SIZE) {
    return "File must be smaller than 5MB";
  }
  return null;
}

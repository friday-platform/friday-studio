import { z } from "zod";

/** File artifact data (output) */
export const FileDataSchema = z.object({
  path: z.string().describe("Absolute path to the stored file"),
  mimeType: z
    .string()
    .describe("MIME type (e.g., text/csv, application/json). Always populated by storage layer."),
  originalName: z
    .string()
    .optional()
    .describe("Original filename from upload. Optional for backward compatibility."),
});
export type FileData = z.infer<typeof FileDataSchema>;

/** File artifact data (input) - omits mimeType (auto-detected), allows optional originalName */
export const FileDataInputSchema = FileDataSchema.omit({ mimeType: true });
export type FileDataInput = z.infer<typeof FileDataInputSchema>;



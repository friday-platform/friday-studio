// Uses jszip to match `apps/atlasd/routes/artifacts.ts` and `bundle.test.ts`;
// revisit if T18 size profiling demands a true streaming zip (e.g. archiver).

/**
 * Pack the export bundle into a zip and return its body as a
 * `ReadableStream<Uint8Array>` so the route can hand it directly to
 * `c.body(...)`. The buffer itself lives entirely in memory — fine for
 * tracer-bullet text-only chats; T18 will revisit if real-world exports
 * outgrow that assumption.
 *
 * @module
 */

import JSZip from "jszip";

interface ArtifactFile {
  /** Relative path inside the zip, e.g. `assets/artifacts/<id>/<basename>`. */
  path: string;
  bytes: Uint8Array;
}

/**
 * Build the export zip and return its body as a `ReadableStream<Uint8Array>`.
 * Always contains `index.html` (rendered transcript) and `chat.json` (raw
 * chat data); `artifactFiles` are added at their provided paths and may be
 * empty (tracer bullet).
 */
export async function buildExportZip(
  html: string,
  chatJson: unknown,
  artifactFiles: ArtifactFile[],
): Promise<ReadableStream<Uint8Array>> {
  const zip = new JSZip();
  zip.file("index.html", html);
  zip.file("chat.json", JSON.stringify(chatJson, null, 2));
  for (const file of artifactFiles) {
    zip.file(file.path, file.bytes);
  }

  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

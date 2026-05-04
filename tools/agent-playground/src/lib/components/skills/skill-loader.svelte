<!--
  Skill upload drop zone — accepts SKILL.md files, skill folders, or .tar.gz archives.

  Every drop becomes a tar.gz POSTed to /import-archive. The server owns SKILL.md
  parsing, namespace derivation, and the prompt-when-missing protocol. When the
  archive's frontmatter has no `@<ns>/<name>` prefix, the server returns 400 with
  `{ needsNamespace, defaultName }` and we re-POST with `?namespace=<ns>` after
  prompting the user.

  @component
-->
<script lang="ts">
  import { useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { skillQueries } from "$lib/queries";

  interface Props {
    inline?: boolean;
    onclose?: () => void;
    /** When set, uploads publish as a new version of this skill (server uses ?namespace= override). */
    forceNamespace?: string;
    /** When set, uploads publish as a new version of this skill (used for filename hint only). */
    forceName?: string;
  }

  let { inline = false, onclose, forceNamespace, forceName }: Props = $props();

  const queryClient = useQueryClient();

  let dragOver = $state(false);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let needsNamespace = $state(false);
  let namespaceInput = $state("tempest");
  /** Archive waiting on a namespace prompt. The server parses SKILL.md, so we
   *  only have the raw blob and the suggested name — re-POST with ?namespace=. */
  let pendingArchive = $state<{ blob: Blob; filename: string; defaultName: string } | null>(null);

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    error = null;

    // Check for directory drop via DataTransferItemList
    const items = e.dataTransfer?.items;
    if (items && items.length > 0) {
      const firstItem = items[0];
      // webkitGetAsEntry is the standard way to detect directories
      const entry = firstItem.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        await loadDirectoryEntry(entry as FileSystemDirectoryEntry);
        return;
      }
    }

    // Single file drop
    const file = e.dataTransfer?.files[0];
    if (!file) return;

    if (file.name.endsWith(".tar.gz") || file.name.endsWith(".tgz")) {
      await loadArchive(file, file.name);
    } else if (file.name === "SKILL.md" || file.name.endsWith(".md")) {
      loading = true;
      try {
        const tarball = await createTarGz([new File([file], "SKILL.md", { type: file.type })]);
        await loadArchive(tarball, file.name);
      } catch (err) {
        error = err instanceof Error ? err.message : "Failed to package SKILL.md";
        loading = false;
      }
    } else {
      error = "Drop a SKILL.md file, a folder containing one, or a .tar.gz archive";
    }
  }

  async function handleFolderInput(e: Event) {
    const input = e.target as HTMLInputElement;
    const fileList = input.files;
    if (!fileList || fileList.length === 0) return;
    error = null;
    loading = true;

    try {
      // webkitdirectory gives us a flat FileList with webkitRelativePath set
      const files: File[] = [];
      let dirName = "skill";
      let hasSkillMd = false;

      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        // webkitRelativePath is "dirname/path/to/file" — strip the root dir prefix
        const relPath = f.webkitRelativePath;
        const slashIdx = relPath.indexOf("/");
        if (slashIdx >= 0 && i === 0) dirName = relPath.slice(0, slashIdx);
        const innerPath = slashIdx >= 0 ? relPath.slice(slashIdx + 1) : f.name;

        if (innerPath === "SKILL.md") hasSkillMd = true;

        files.push(new File([f], innerPath, { type: f.type }));
      }

      if (!hasSkillMd) {
        error = "Folder must contain a SKILL.md file";
        return;
      }

      const tarball = await createTarGz(files);
      await loadArchive(tarball, `${dirName}.tar.gz`);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to read folder";
    } finally {
      loading = false;
      input.value = "";
    }
  }

  /** Walk a dropped directory, build a tar.gz, and ship to /import-archive. */
  async function loadDirectoryEntry(dirEntry: FileSystemDirectoryEntry) {
    loading = true;
    try {
      const files = await readDirectoryEntries(dirEntry);
      if (!files.some((f) => f.name === "SKILL.md")) {
        error = "Directory must contain a SKILL.md file";
        return;
      }
      const tarball = await createTarGz(files);
      await loadArchive(tarball, `${dirEntry.name}.tar.gz`);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to read directory";
    } finally {
      loading = false;
    }
  }

  /** POST a tar.gz to /import-archive. Server parses SKILL.md, derives namespace,
   *  and either publishes or returns 400 with `{ needsNamespace, defaultName }`. */
  async function loadArchive(blob: Blob, filename: string, namespaceOverride?: string) {
    loading = true;
    error = null;
    try {
      // Force-namespace from Replace flow takes precedence over any caller-supplied override.
      const ns = forceNamespace ?? namespaceOverride;
      const formData = new FormData();
      formData.append("archive", new File([blob], filename, { type: "application/gzip" }));
      const params = new URLSearchParams();
      if (ns) params.set("namespace", ns);
      if (forceName) params.set("name", forceName);
      const query = params.toString();
      const url = query
        ? `/api/daemon/api/skills/import-archive?${query}`
        : `/api/daemon/api/skills/import-archive`;
      const res = await fetch(url, { method: "POST", body: formData });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        needsNamespace?: boolean;
        defaultName?: string;
        published?: { namespace: string; name: string };
      };

      if (res.status === 400 && body.needsNamespace && body.defaultName) {
        pendingArchive = { blob, filename, defaultName: body.defaultName };
        needsNamespace = true;
        return;
      }
      if (!res.ok) {
        throw new Error(body.error ?? `Import failed: ${res.status}`);
      }
      if (!body.published) {
        throw new Error("Import succeeded but response was malformed");
      }
      await onPublishSuccess(body.published.namespace, body.published.name);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to import archive";
    } finally {
      loading = false;
    }
  }

  /** Submit the namespace form — re-POST the stashed archive with ?namespace=. */
  async function submitNamespace() {
    if (!namespaceInput.trim() || !pendingArchive) return;
    const ns = namespaceInput.trim();
    const archive = pendingArchive;
    pendingArchive = null;
    needsNamespace = false;
    await loadArchive(archive.blob, archive.filename, ns);
  }

  async function onPublishSuccess(namespace: string, name: string) {
    await queryClient.invalidateQueries({ queryKey: skillQueries.all() });
    onclose?.();

    // When uploading a new version of an existing skill, stay on the same page
    if (forceNamespace && forceName) return;

    goto(`/skills/${namespace}/${name}`);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Creates a gzipped tarball from a list of files in the browser.
   * Uses a minimal POSIX tar implementation + CompressionStream for gzip.
   */
  async function createTarGz(files: File[]): Promise<Blob> {
    const BLOCK = 512;
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];

    for (const file of files) {
      const data = new Uint8Array(await file.arrayBuffer());
      const name = file.name;

      // Build 512-byte POSIX tar header
      const header = new Uint8Array(BLOCK);

      // name (0, 100)
      writeString(header, 0, name, 100);
      // mode (100, 8)
      writeOctal(header, 100, 0o644, 8);
      // uid (108, 8)
      writeOctal(header, 108, 0, 8);
      // gid (116, 8)
      writeOctal(header, 116, 0, 8);
      // size (124, 12)
      writeOctal(header, 124, data.byteLength, 12);
      // mtime (136, 12)
      writeOctal(header, 136, Math.floor(Date.now() / 1000), 12);
      // typeflag (156, 1) — '0' = regular file
      header[156] = 0x30;
      // magic (257, 6) — 'ustar\0'
      writeString(header, 257, "ustar\0", 6);
      // version (263, 2) — '00'
      writeString(header, 263, "00", 2);

      // checksum (148, 8) — compute after filling all other fields
      // Temporarily fill checksum field with spaces for computation
      for (let i = 148; i < 156; i++) header[i] = 0x20;
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += header[i];
      const checksumStr = sum.toString(8).padStart(6, "0");
      writeString(header, 148, checksumStr, 7);
      header[155] = 0x20;

      chunks.push(header);
      chunks.push(data);

      // Pad to 512-byte boundary
      const remainder = data.byteLength % BLOCK;
      if (remainder > 0) {
        chunks.push(new Uint8Array(BLOCK - remainder));
      }
    }

    // Two zero blocks to end the archive
    chunks.push(new Uint8Array(BLOCK * 2));

    // Concatenate into a single tar buffer
    const totalSize = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const tarBuffer = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      tarBuffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Gzip via CompressionStream
    const stream = new Blob([tarBuffer]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Response(stream).blob();

    function writeString(buf: Uint8Array, pos: number, str: string, len: number) {
      const bytes = encoder.encode(str);
      buf.set(bytes.subarray(0, len), pos);
    }

    function writeOctal(buf: Uint8Array, pos: number, value: number, len: number) {
      const str = value.toString(8).padStart(len - 1, "0");
      writeString(buf, pos, str, len - 1);
      buf[pos + len - 1] = 0;
    }
  }

  async function readDirectoryEntries(dirEntry: FileSystemDirectoryEntry): Promise<File[]> {
    const files: File[] = [];

    async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
      const all: FileSystemEntry[] = [];
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
          reader.readEntries(resolve, reject);
        });
        all.push(...batch);
      } while (batch.length > 0);
      return all;
    }

    async function readDir(entry: FileSystemDirectoryEntry, prefix: string) {
      const reader = entry.createReader();
      const entries = await readAllEntries(reader);

      for (const child of entries) {
        if (child.isFile) {
          const file = await new Promise<File>((resolve, reject) => {
            (child as FileSystemFileEntry).file(resolve, reject);
          });
          // Preserve relative path
          const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
          files.push(new File([file], relativePath, { type: file.type }));
        } else if (child.isDirectory) {
          const subPrefix = prefix ? `${prefix}/${child.name}` : child.name;
          await readDir(child as FileSystemDirectoryEntry, subPrefix);
        }
      }
    }

    await readDir(dirEntry, "");
    return files;
  }
</script>

{#if needsNamespace}
  {@const promptName = pendingArchive?.defaultName ?? ""}
  <div class="drop-zone" class:inline>
    <div class="drop-content">
      <p class="drop-label">Skill namespace</p>
      <p class="drop-hint">
        Enter the namespace for <strong>{promptName}</strong>
      </p>
      <div class="namespace-form">
        <span class="namespace-prefix">@</span>
        <input
          class="namespace-input"
          type="text"
          bind:value={namespaceInput}
          placeholder="tempest"
          onkeydown={(e) => {
            if (e.key === "Enter") submitNamespace();
          }}
        />
        <span class="namespace-sep">/</span>
        <span class="namespace-name">{promptName}</span>
      </div>
      <button class="browse-btn" onclick={submitNamespace} disabled={!namespaceInput.trim()}>
        Publish
      </button>
      {#if error}
        <p class="drop-error">{error}</p>
      {/if}
    </div>
    {#if onclose}
      <button
        type="button"
        class="close-btn"
        onclick={() => {
          needsNamespace = false;
          pendingArchive = null;
          onclose?.();
        }}
      >
        Cancel
      </button>
    {/if}
  </div>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <label
    class="drop-zone"
    class:drag-over={dragOver}
    class:inline
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
  >
    <div class="drop-content">
      {#if loading}
        <p class="drop-label">Publishing skill...</p>
      {:else}
        <p class="drop-label">Drop a skill folder or .tar.gz here, or click to browse</p>
      {/if}

      {#if error}
        <p class="drop-error">{error}</p>
      {/if}
    </div>

    <input type="file" webkitdirectory hidden onchange={handleFolderInput} />

    {#if !inline && onclose}
      <button type="button" class="close-btn" onclick={(e) => { e.preventDefault(); onclose?.(); }}>Close</button>
    {/if}
  </label>
{/if}

<style>
  .drop-zone {
    align-items: center;
    border: 1px dashed var(--color-border-2);
    border-radius: var(--radius-3);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    justify-content: center;
    min-block-size: 200px;
    padding: var(--size-10);
    transition:
      border-color 200ms ease,
      background-color 200ms ease;

    &:hover {
      border-color: color-mix(in srgb, var(--color-text), transparent 25%);
    }

    &.drag-over {
      background-color: color-mix(in srgb, var(--color-highlight-1), transparent 50%);
      border-color: var(--color-text);
    }

    &.inline {
      border-style: dashed;
      min-block-size: 0;
      padding: var(--size-8) var(--size-10);
    }
  }

  .drop-content {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .drop-label {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
  }

  .browse-btn {
    background-color: var(--color-surface-2);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-5);
    transition: background-color 100ms ease;

    &:hover {
      background-color: var(--color-highlight-1);
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
  }

  .drop-error {
    background-color: color-mix(in srgb, var(--color-error), transparent 90%);
    border-radius: var(--radius-2);
    color: var(--color-error);
    font-size: var(--font-size-2);
    max-inline-size: 400px;
    padding: var(--size-2) var(--size-4);
    text-align: center;
  }

  .close-btn {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    cursor: pointer;
    font-size: var(--font-size-2);

    &:hover {
      color: var(--color-text);
    }
  }

  .namespace-form {
    align-items: center;
    display: flex;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-3);
    gap: 0;
  }

  .namespace-prefix {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
  }

  .namespace-input {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-3);
    inline-size: 12ch;
    padding: var(--size-1) var(--size-2);
  }

  .namespace-sep {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    padding-inline: var(--size-0-5);
  }

  .namespace-name {
    color: var(--color-text);
    font-weight: var(--font-weight-6);
  }
</style>

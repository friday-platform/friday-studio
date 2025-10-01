/**
 * Filesystem implementation of the template storage adapter
 */

import { ensureDir, exists, walk } from "@std/fs";
import { join, relative, resolve } from "@std/path";
import type { Template, TemplateInfo, TemplateStorageAdapter } from "./template-adapter.ts";

/**
 * Template adapter that loads templates from the filesystem
 */
export class FilesystemTemplateAdapter implements TemplateStorageAdapter {
  private templatesPath: string;

  constructor(templatesPath: string) {
    this.templatesPath = resolve(templatesPath);
  }

  // This is required in the interface, but we don't need to await in this implementation
  // deno-lint-ignore require-await
  async listTemplates(): Promise<TemplateInfo[]> {
    // Since starters package was removed, return empty array
    // Templates can be added in the future if needed
    return [];
  }

  async getTemplate(templateId: string): Promise<Template> {
    const templatePath = join(this.templatesPath, templateId);

    if (!(await exists(templatePath))) {
      throw new Error(`Template '${templateId}' not found at ${templatePath}`);
    }

    // Get template info from registry
    const templates = await this.listTemplates();
    const info = templates.find((t) => t.id === templateId);

    if (!info) {
      throw new Error(`Template '${templateId}' not found in registry`);
    }

    // Collect all files in the template directory
    const files = new Map<string, string>();

    for await (const entry of walk(templatePath, { includeFiles: true, includeDirs: false })) {
      const relativePath = relative(templatePath, entry.path);
      const content = await Deno.readTextFile(entry.path);
      files.set(relativePath, content);
    }

    // Also include shared .env.example if it exists
    const envExamplePath = join(this.templatesPath, ".env.example");
    if (await exists(envExamplePath)) {
      const envContent = await Deno.readTextFile(envExamplePath);
      files.set(".env.example", envContent);
    }

    return { info, files };
  }

  async copyTemplate(
    templateId: string,
    targetPath: string,
    replacements: Record<string, string>,
  ): Promise<void> {
    const template = await this.getTemplate(templateId);

    // Ensure target directory exists
    await ensureDir(targetPath);

    // Copy each file with replacements
    for (const [relativePath, content] of template.files) {
      // Skip .env.example - we'll handle it specially
      if (relativePath === ".env.example") {
        continue;
      }

      const destPath = join(targetPath, relativePath);

      // Ensure parent directory exists
      await ensureDir(join(destPath, ".."));

      // Apply replacements
      let processedContent = content;
      for (const [placeholder, value] of Object.entries(replacements)) {
        const regex = new RegExp(`{{${placeholder}}}`, "g");
        processedContent = processedContent.replace(regex, value);
      }

      // Write the file
      await Deno.writeTextFile(destPath, processedContent);
    }

    // Copy .env.example content to .env (without creating .env.example)
    const envExampleContent = template.files.get(".env.example");
    if (envExampleContent) {
      const envPath = join(targetPath, ".env");
      // Apply replacements to .env content too
      let processedEnvContent = envExampleContent;
      for (const [placeholder, value] of Object.entries(replacements)) {
        const regex = new RegExp(`{{${placeholder}}}`, "g");
        processedEnvContent = processedEnvContent.replace(regex, value);
      }
      await Deno.writeTextFile(envPath, processedEnvContent);
    }
  }

  async templateExists(templateId: string): Promise<boolean> {
    const templatePath = join(this.templatesPath, templateId);
    return await exists(templatePath);
  }
}

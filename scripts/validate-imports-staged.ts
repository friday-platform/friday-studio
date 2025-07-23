#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

/**
 * Staged Import Validation Script
 *
 * This script validates imports only for staged files (for pre-commit hooks)
 * It's faster than validating the entire codebase and focuses on changes.
 */

import { dirname, extname, join, resolve } from "@std/path";

interface ImportIssue {
  file: string;
  line: number;
  import: string;
  resolvedPath: string;
  reason: string;
}

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const IMPORT_PATTERNS = [
  // ES6 imports
  /^import\s+.*?from\s+['"]([^'"]+)['"];?$/gm,
  // Dynamic imports
  /(?:import|await\s+import)\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
  // Export from
  /^export\s+.*?from\s+['"]([^'"]+)['"];?$/gm,
];

async function getStagedFiles(): Promise<string[]> {
  const process = new Deno.Command("git", {
    args: ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    stdout: "piped",
    stderr: "piped",
  });

  const { success, stdout } = await process.output();

  if (!success) {
    return [];
  }

  const files = new TextDecoder().decode(stdout)
    .split("\n")
    .filter((file) => file.trim().length > 0)
    .filter((file) => EXTENSIONS.includes(extname(file)))
    .filter((file) => !file.includes("tools/atlas-installer/"));

  return files;
}

function extractImports(content: string): Array<{ import: string; line: number }> {
  const imports: Array<{ import: string; line: number }> = [];

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0; // Reset regex state
    let match;

    while ((match = pattern.exec(content)) !== null) {
      const importPath = match[1];

      // Skip external packages and URLs
      if (isExternalImport(importPath)) {
        continue;
      }

      // Find line number
      const lineNumber = content.substring(0, match.index).split("\n").length;
      imports.push({ import: importPath, line: lineNumber });
    }
  }

  return imports;
}

function isExternalImport(importPath: string): boolean {
  // Skip external packages
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) {
    return true;
  }

  // Skip URLs
  if (importPath.startsWith("http://") || importPath.startsWith("https://")) {
    return true;
  }

  // Skip Deno standard library
  if (importPath.startsWith("https://deno.land/")) {
    return true;
  }

  // Skip JSR packages
  if (importPath.startsWith("jsr:") || importPath.startsWith("@std/")) {
    return true;
  }

  // Skip NPM packages
  if (importPath.startsWith("npm:")) {
    return true;
  }

  return false;
}

function resolveImportPath(basePath: string, importPath: string): string {
  const baseDir = dirname(basePath);

  // Handle relative imports
  if (importPath.startsWith("./") || importPath.startsWith("../")) {
    return resolve(baseDir, importPath);
  }

  // Handle absolute imports from project root
  if (importPath.startsWith("/")) {
    return resolve(Deno.cwd(), importPath.slice(1));
  }

  // Handle root-relative imports (assume from src/)
  return resolve(Deno.cwd(), "src", importPath);
}

async function validateImport(
  filePath: string,
  importPath: string,
  line: number,
): Promise<ImportIssue | null> {
  try {
    const resolvedPath = resolveImportPath(filePath, importPath);

    // Try with original path
    try {
      const stat = await Deno.stat(resolvedPath);
      if (stat.isFile) {
        return null; // Import is valid
      }
    } catch {
      // Continue to try with extensions
    }

    // Try with different extensions
    for (const ext of EXTENSIONS) {
      const pathWithExt = resolvedPath + ext;
      try {
        const stat = await Deno.stat(pathWithExt);
        if (stat.isFile) {
          return null; // Import is valid
        }
      } catch {
        continue;
      }
    }

    // Try as directory with index file
    for (const ext of EXTENSIONS) {
      const indexPath = join(resolvedPath, `index${ext}`);
      try {
        const stat = await Deno.stat(indexPath);
        if (stat.isFile) {
          return null; // Import is valid
        }
      } catch {
        continue;
      }
    }

    // Import is invalid
    return {
      file: filePath,
      line,
      import: importPath,
      resolvedPath,
      reason: `File not found: ${resolvedPath}`,
    };
  } catch (error) {
    return {
      file: filePath,
      line,
      import: importPath,
      resolvedPath: resolveImportPath(filePath, importPath),
      reason: `Error resolving import: ${error.message}`,
    };
  }
}

async function validateStagedImports(): Promise<ImportIssue[]> {
  const issues: ImportIssue[] = [];
  const files = await getStagedFiles();

  if (files.length === 0) {
    console.log("🔍 No staged TypeScript/JavaScript files to validate");
    return issues;
  }

  console.log(`🔍 Validating imports in ${files.length} staged files...`);

  for (const file of files) {
    try {
      const content = await Deno.readTextFile(file);
      const imports = extractImports(content);

      for (const { import: importPath, line } of imports) {
        const issue = await validateImport(file, importPath, line);
        if (issue) {
          issues.push(issue);
        }
      }
    } catch (error) {
      console.error(`❌ Error reading file ${file}: ${error.message}`);
    }
  }

  return issues;
}

function printIssues(issues: ImportIssue[]): void {
  if (issues.length === 0) {
    console.log("✅ All staged imports are valid!");
    return;
  }

  console.log(`❌ Found ${issues.length} import issues in staged files:\n`);

  for (const issue of issues) {
    console.log(`📄 ${issue.file}:${issue.line}`);
    console.log(`  Import: ${issue.import}`);
    console.log(`  Issue: ${issue.reason}`);
    console.log();
  }
}

// Main execution
if (import.meta.main) {
  console.log("🚀 Validating imports in staged files...");

  try {
    const issues = await validateStagedImports();
    printIssues(issues);

    if (issues.length > 0) {
      console.log("💡 Fix these import issues before committing.");
      console.log("💡 Run 'deno task validate-imports' to check all files.");
      Deno.exit(1);
    } else {
      console.log("🎉 Staged import validation completed successfully!");
    }
  } catch (error) {
    console.error(`❌ Validation failed: ${error.message}`);
    Deno.exit(1);
  }
}

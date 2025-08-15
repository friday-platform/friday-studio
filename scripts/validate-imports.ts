#!/usr/bin/env -S deno run --allow-read --allow-write

/**
 * Import Validation Script
 *
 * This script validates that all TypeScript/JavaScript imports in the codebase
 * reference files that actually exist. It helps prevent build failures due to
 * missing import paths.
 */

import { walk } from "@std/fs";
import { dirname, join, resolve } from "@std/path";

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

async function findTypeScriptFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  for await (
    const entry of walk(rootDir, {
      exts: EXTENSIONS,
      skip: [
        /node_modules/,
        /\.git/,
        /dist/,
        /build/,
        /coverage/,
        /\.deno/,
        /deno\.lock/,
        /tools\/atlas-installer/,
      ],
    })
  ) {
    if (entry.isFile) {
      files.push(entry.path);
    }
  }

  return files;
}

function extractImports(content: string): Array<{ import: string; line: number }> {
  const imports: Array<{ import: string; line: number }> = [];

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0; // Reset regex state
    let match;

    while ((match = pattern.exec(content)) !== null) {
      const importPath = match[1];

      // Skip if importPath is undefined
      if (!importPath) {
        continue;
      }

      // Skip external packages and URLs
      if (isExternalImport(importPath)) {
        continue;
      }

      // Find line number and check if it's commented
      const lineNumber = content.substring(0, match.index).split("\n").length;
      const lineContent = content.split("\n")[lineNumber - 1];

      // Skip commented lines
      if (
        lineContent && (lineContent.trim().startsWith("//") || lineContent.trim().startsWith("/*"))
      ) {
        continue;
      }

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
      reason: `File not found: ${resolvedPath} (tried extensions: ${EXTENSIONS.join(", ")})`,
    };
  } catch (error) {
    return {
      file: filePath,
      line,
      import: importPath,
      resolvedPath: resolveImportPath(filePath, importPath),
      reason: `Error resolving import: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function validateAllImports(rootDir: string): Promise<ImportIssue[]> {
  const issues: ImportIssue[] = [];
  const files = await findTypeScriptFiles(rootDir);

  console.log(`Validating imports in ${files.length} files...`);

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
      console.error(
        `Error reading file ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return issues;
}

function printIssues(issues: ImportIssue[]): void {
  if (issues.length === 0) {
    console.log("All imports are valid!");
    return;
  }

  console.log(`Found ${issues.length} import issues:\n`);

  // Group issues by file
  const issuesByFile = new Map<string, ImportIssue[]>();
  for (const issue of issues) {
    const fileIssues = issuesByFile.get(issue.file) || [];
    fileIssues.push(issue);
    issuesByFile.set(issue.file, fileIssues);
  }

  for (const [file, fileIssues] of issuesByFile) {
    console.log(`${file}:`);
    for (const issue of fileIssues) {
      console.log(`  Line ${issue.line}: ${issue.import}`);
      console.log(`    ${issue.reason}`);
    }
    console.log();
  }
}

// Main execution
if (import.meta.main) {
  const rootDir = Deno.args[0] || Deno.cwd();

  console.log(`Starting import validation in: ${rootDir}`);

  try {
    const issues = await validateAllImports(rootDir);
    printIssues(issues);

    if (issues.length > 0) {
      console.log(`Fix these import issues to prevent build failures.`);
      Deno.exit(1);
    } else {
      console.log("Import validation completed successfully!");
    }
  } catch (error) {
    console.error(
      `Validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exit(1);
  }
}

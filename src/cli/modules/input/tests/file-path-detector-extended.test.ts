import { assertEquals } from "@std/assert";
import {
  createFileAttachmentPlaceholder,
  detectFilePaths,
  extractFilePaths,
  isFilePath,
} from "../file-path-detector.ts";

Deno.test("isFilePath - detects valid file paths", () => {
  const testCases = [
    { path: "/Users/dwoolf/file.txt", os: "darwin" as const, expected: true },
    { path: "~/Documents/report.pdf", os: "linux" as const, expected: true },
    { path: "C:\\Users\\file.txt", os: "windows" as const, expected: true },
    { path: "not a path", os: "darwin" as const, expected: false },
    { path: "https://example.com", os: "darwin" as const, expected: false },
  ];

  testCases.forEach(({ path, os, expected }) => {
    const result = isFilePath(path, os);
    assertEquals(
      result,
      expected,
      `Path "${path}" on ${os} should ${expected ? "be" : "not be"} detected`,
    );
  });
});

Deno.test("extractFilePaths - extracts multiple paths from text", () => {
  const text = `/Users/dwoolf/document.pdf
/Users/dwoolf/image.png
C:\\Windows\\System32\\config.sys
~/Downloads/archive.zip`;

  // extractFilePaths now only detects paths on their own lines
  // and checks both Unix and Windows patterns regardless of OS
  const paths = extractFilePaths(text);
  assertEquals(paths.length, 4); // All paths are on their own lines
});

Deno.test("createFileAttachmentPlaceholder - creates proper placeholders", () => {
  const testCases = [
    { path: "/Users/dwoolf/report.pdf", id: 1, os: "darwin" as const, expected: "[#1 report.pdf]" },
    { path: "/Users/dwoolf/Documents", id: 2, os: "darwin" as const, expected: "[#2 Documents/]" },
    { path: "C:\\Users\\file.txt", id: 3, os: "windows" as const, expected: "[#3 file.txt]" },
    { path: "C:\\Users\\Desktop", id: 4, os: "windows" as const, expected: "[#4 Desktop\\]" },
    { path: "/Users/dwoolf/Projects/atlas/", id: 5, os: "linux" as const, expected: "[#5 atlas/]" },
  ];

  testCases.forEach(({ path, id, os, expected }) => {
    const result = createFileAttachmentPlaceholder(path, id, os);
    assertEquals(result, expected, `Path "${path}" should produce "${expected}"`);
  });
});

Deno.test("detectFilePaths - returns structured path data", () => {
  const text = `/Users/dwoolf/image.png
/Users/dwoolf/Documents
C:\\Users\\report.pdf`;

  // detectFilePaths now detects all paths regardless of OS
  const detected = detectFilePaths(text);

  assertEquals(detected.length, 3); // All paths are detected

  const [file, directory, windowsFile] = detected;

  // Check file detection
  assertEquals(file?.fileName, "image.png");
  assertEquals(file?.isDirectory, false);
  assertEquals(file?.hasExtension, true);
  assertEquals(file?.extension, "png");

  // Check directory detection
  assertEquals(directory?.fileName, "Documents");
  assertEquals(directory?.isDirectory, true);
  assertEquals(directory?.hasExtension, false);
  assertEquals(directory?.extension, undefined);

  // Check Windows file
  assertEquals(windowsFile?.fileName, "report.pdf");
  assertEquals(windowsFile?.isDirectory, false);
  assertEquals(windowsFile?.hasExtension, true);
  assertEquals(windowsFile?.extension, "pdf");
});

Deno.test("detectFilePaths - handles mixed content", () => {
  // Mixed content with paths embedded in text - should NOT be detected
  const textWithEmbedded = `Here's my file: /Users/dwoolf/test.txt
  And a folder at ~/Projects/atlas
  Some regular text here
  Another path: /var/log/system.log`;

  const detectedEmbedded = detectFilePaths(textWithEmbedded);
  assertEquals(detectedEmbedded.length, 0); // Paths embedded in text are not detected

  // Paths on their own lines - should be detected
  const textWithStandalone = `/Users/dwoolf/test.txt
~/Projects/atlas
/var/log/system.log`;

  const detectedStandalone = detectFilePaths(textWithStandalone);
  assertEquals(detectedStandalone.length, 3);

  const fileNames = detectedStandalone.map((d) => d.fileName);
  assertEquals(fileNames, ["test.txt", "atlas", "system.log"]);
});

Deno.test("detectFilePaths - handles Windows paths with spaces", () => {
  const text = `C:\\Users\\David Woolf\\Desktop\\presentation.pptx
C:\\Program Files\\App\\config.json`;

  // detectFilePaths now works the same regardless of OS
  const detected = detectFilePaths(text);

  assertEquals(detected.length, 2);
  assertEquals(detected.at(0)?.fileName, "presentation.pptx");
  assertEquals(detected.at(1)?.fileName, "config.json");
});

Deno.test("createFileAttachmentPlaceholder - handles dotfiles correctly", () => {
  const testCases = [
    {
      path: "/Users/dwoolf/.gitignore",
      id: 1,
      os: "darwin" as const,
      expected: "[#1 .gitignore/]", // No extension, treated as directory
    },
    { path: "/Users/dwoolf/.config", id: 2, os: "darwin" as const, expected: "[#2 .config/]" },
    {
      path: "/Users/dwoolf/.env.local",
      id: 3,
      os: "darwin" as const,
      expected: "[#3 .env.local]", // Has extension
    },
  ];

  testCases.forEach(({ path, id, os, expected }) => {
    const result = createFileAttachmentPlaceholder(path, id, os);
    assertEquals(result, expected, `Dotfile "${path}" should produce "${expected}"`);
  });
});

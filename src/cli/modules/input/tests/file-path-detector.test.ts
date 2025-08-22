import { assertEquals } from "@std/assert";
import {
  extractFileName,
  extractFilePaths,
  hasFileExtension,
  matchesAnyPattern,
  UNIX_PATH_PATTERNS,
  WINDOWS_PATH_PATTERNS,
} from "../file-path-detector.ts";

Deno.test("Unix Path Detection - Absolute paths", () => {
  const testCases = [
    { path: "/Users/dwoolf/Documents/file.txt", shouldMatch: true },
    { path: "/home/user/test.pdf", shouldMatch: true },
    { path: "/var/log/system.log", shouldMatch: true },
    { path: "/", shouldMatch: true },
    { path: "/usr/bin/node", shouldMatch: true },
    { path: "not/absolute/path", shouldMatch: false },
    { path: "C:\\Windows\\test.txt", shouldMatch: false },
    { path: "just some text", shouldMatch: false },
  ];

  testCases.forEach(({ path, shouldMatch }) => {
    const matches = matchesAnyPattern(path, UNIX_PATH_PATTERNS);
    assertEquals(
      matches,
      shouldMatch,
      `Path "${path}" should ${shouldMatch ? "" : "not "}match Unix patterns`,
    );
  });
});

Deno.test("Unix Path Detection - Home directory paths", () => {
  const testCases = [
    { path: "~/Documents/file.txt", shouldMatch: true },
    { path: "~/Downloads/image.png", shouldMatch: true },
    { path: "~/.config/settings.json", shouldMatch: true },
    { path: "~/", shouldMatch: false }, // Just tilde slash needs more
    { path: "~ /not/valid", shouldMatch: false },
    { path: "/home/~/weird", shouldMatch: true }, // This is a valid absolute path
  ];

  testCases.forEach(({ path, shouldMatch }) => {
    const matches = matchesAnyPattern(path, UNIX_PATH_PATTERNS);
    assertEquals(
      matches,
      shouldMatch,
      `Path "${path}" should ${shouldMatch ? "" : "not "}match Unix patterns`,
    );
  });
});

Deno.test("Unix Path Detection - Paths with spaces", () => {
  const testCases = [
    { path: "/Users/dwoolf/My\\ Documents/file.txt", shouldMatch: true },
    { path: "/home/user/Some\\ Folder/test.pdf", shouldMatch: true },
    { path: "/var/log/my\\ app.log", shouldMatch: true },
  ];

  testCases.forEach(({ path, shouldMatch }) => {
    const matches = matchesAnyPattern(path, UNIX_PATH_PATTERNS);
    assertEquals(
      matches,
      shouldMatch,
      `Path "${path}" should ${shouldMatch ? "" : "not "}match Unix patterns`,
    );
  });
});

Deno.test("Windows Path Detection - Drive letter paths", () => {
  const testCases = [
    { path: "C:\\Users\\David\\Documents\\file.txt", shouldMatch: true },
    { path: "D:\\Projects\\atlas\\README.md", shouldMatch: true },
    { path: "E:/Downloads/image.png", shouldMatch: true }, // Forward slashes
    { path: "c:\\windows\\system32", shouldMatch: true }, // Lowercase drive
    { path: "Z:\\", shouldMatch: true },
    { path: "C:", shouldMatch: false }, // No slash after colon
    { path: "CC:\\invalid", shouldMatch: false },
    { path: "1:\\invalid", shouldMatch: false },
  ];

  testCases.forEach(({ path, shouldMatch }) => {
    const matches = matchesAnyPattern(path, WINDOWS_PATH_PATTERNS);
    assertEquals(
      matches,
      shouldMatch,
      `Path "${path}" should ${shouldMatch ? "" : "not "}match Windows patterns`,
    );
  });
});

Deno.test("Windows Path Detection - UNC paths", () => {
  const testCases = [
    { path: "\\\\server\\share\\file.txt", shouldMatch: true },
    { path: "\\\\192.168.1.1\\documents", shouldMatch: true },
    { path: "\\\\DESKTOP-PC\\c$\\Windows", shouldMatch: true },
    { path: "\\single\\slash", shouldMatch: false },
    { path: "//unix/style", shouldMatch: false },
  ];

  testCases.forEach(({ path, shouldMatch }) => {
    const matches = matchesAnyPattern(path, WINDOWS_PATH_PATTERNS);
    assertEquals(
      matches,
      shouldMatch,
      `Path "${path}" should ${shouldMatch ? "" : "not "}match Windows patterns`,
    );
  });
});

Deno.test("Windows Path Detection - Paths with spaces", () => {
  const testCases = [
    { path: "C:\\Users\\David Woolf\\Desktop\\file.txt", shouldMatch: true },
    { path: "C:\\Program Files\\App\\test.exe", shouldMatch: true },
    { path: "D:\\My Documents\\Projects", shouldMatch: true },
  ];

  testCases.forEach(({ path, shouldMatch }) => {
    const matches = matchesAnyPattern(path, WINDOWS_PATH_PATTERNS);
    assertEquals(
      matches,
      shouldMatch,
      `Path "${path}" should ${shouldMatch ? "" : "not "}match Windows patterns`,
    );
  });
});

Deno.test("File Name Extraction - Unix paths", () => {
  const testCases = [
    { path: "/Users/dwoolf/Documents/report.pdf", expected: "report.pdf" },
    { path: "/home/user/image.png", expected: "image.png" },
    { path: "/var/log/system.log", expected: "system.log" },
    { path: "/usr/local/bin/node", expected: "node" },
    { path: "/Users/dwoolf/Projects/atlas", expected: "atlas" },
    { path: "/Users/dwoolf/Projects/atlas/", expected: "atlas" },
    { path: "~/Documents/file.txt", expected: "file.txt" },
    { path: "/Users/dwoolf/My\\ Documents/file.txt", expected: "file.txt" },
  ];

  testCases.forEach(({ path, expected }) => {
    const fileName = extractFileName(path);
    assertEquals(fileName, expected, `Expected "${expected}" from path "${path}"`);
  });
});

Deno.test("File Name Extraction - Windows paths", () => {
  const testCases = [
    { path: "C:\\Users\\David\\Documents\\report.pdf", expected: "report.pdf" },
    { path: "D:\\Projects\\atlas\\README.md", expected: "README.md" },
    { path: "E:/Downloads/image.png", expected: "image.png" },
    { path: "C:\\Windows\\System32", expected: "System32" },
    { path: "C:\\Windows\\System32\\", expected: "System32" },
    { path: "C:\\Users\\David Woolf\\Desktop\\presentation.pptx", expected: "presentation.pptx" },
    { path: "\\\\server\\share\\file.txt", expected: "file.txt" },
  ];

  testCases.forEach(({ path, expected }) => {
    const fileName = extractFileName(path);
    assertEquals(fileName, expected, `Expected "${expected}" from path "${path}"`);
  });
});

Deno.test("File Extension Detection", () => {
  const testCases = [
    { path: "/Users/dwoolf/file.txt", hasExtension: true },
    { path: "/Users/dwoolf/image.png", hasExtension: true },
    { path: "/Users/dwoolf/archive.tar.gz", hasExtension: true },
    { path: "/Users/dwoolf/Documents", hasExtension: false },
    { path: "/usr/local/bin/node", hasExtension: false },
    { path: "C:\\Users\\file.pdf", hasExtension: true },
    { path: "C:\\Windows\\System32", hasExtension: false },
    { path: "/Users/dwoolf/.gitignore", hasExtension: false }, // Dotfiles without extension
    { path: "/Users/dwoolf/.config", hasExtension: false },
    { path: "/Users/dwoolf/file.backup.txt", hasExtension: true },
  ];

  testCases.forEach(({ path, hasExtension: expected }) => {
    const hasExt = hasFileExtension(path);
    assertEquals(
      hasExt,
      expected,
      `Path "${path}" should ${expected ? "have" : "not have"} an extension`,
    );
  });
});

Deno.test("Mixed Content Detection - Paths must be on their own lines", () => {
  const testCases = [
    {
      input: "Check out this file: /Users/dwoolf/test.txt",
      expectedPaths: [], // Path embedded in text, not on its own line
    },
    {
      input: "/Users/dwoolf/test.txt",
      expectedPaths: ["/Users/dwoolf/test.txt"], // Path on its own line
    },
    {
      input: "Files are in C:\\Documents\\report.pdf and D:\\backup\\data.csv",
      expectedPaths: [], // Paths embedded in text
    },
    {
      input: "C:\\Documents\\report.pdf\nD:\\backup\\data.csv",
      expectedPaths: ["C:\\Documents\\report.pdf", "D:\\backup\\data.csv"], // Each path on its own line
    },
    {
      input: "The config is at:\n~/config.json\nAnd logs at:\n/var/log/app.log",
      expectedPaths: ["~/config.json", "/var/log/app.log"], // Paths on their own lines
    },
    {
      input: "No paths here, just regular text",
      expectedPaths: [],
    },
    {
      input: "Here is my file:\n/Users/dwoolf/test.txt\nThat's it",
      expectedPaths: ["/Users/dwoolf/test.txt"], // Middle line is a path
    },
  ];

  testCases.forEach(({ input, expectedPaths }) => {
    const detectedPaths = extractFilePaths(input);

    assertEquals(
      detectedPaths.length,
      expectedPaths.length,
      `Expected ${expectedPaths.length} paths in "${input}"`,
    );

    if (expectedPaths.length > 0) {
      assertEquals(detectedPaths, expectedPaths, `Paths should match exactly`);
    }
  });
});

Deno.test("Edge Cases - Special characters and formats", () => {
  const testCases = [
    { path: "/Users/dwoolf/file(1).txt", shouldMatch: true, fileName: "file(1).txt" },
    { path: "/Users/dwoolf/file[backup].txt", shouldMatch: true, fileName: "file[backup].txt" },
    { path: "/Users/dwoolf/file#2.txt", shouldMatch: true, fileName: "file#2.txt" },
    { path: "/Users/dwoolf/file@latest.txt", shouldMatch: true, fileName: "file@latest.txt" },
    { path: "C:\\Users\\file!important.doc", shouldMatch: true, fileName: "file!important.doc" },
    { path: "/Users/dwoolf/file-name_2024.txt", shouldMatch: true, fileName: "file-name_2024.txt" },
    {
      path: "/Users/dwoolf/file.2024.01.01.backup",
      shouldMatch: true,
      fileName: "file.2024.01.01.backup",
    },
  ];

  testCases.forEach(({ path, shouldMatch, fileName }) => {
    const matches = matchesAnyPattern(path, [...UNIX_PATH_PATTERNS, ...WINDOWS_PATH_PATTERNS]);
    assertEquals(matches, shouldMatch, `Path "${path}" should match`);

    if (fileName) {
      const extracted = extractFileName(path);
      assertEquals(extracted, fileName, `Expected file name "${fileName}" from path "${path}"`);
    }
  });
});

Deno.test("Multiple Paths in Single Paste", () => {
  const input = `/Users/dwoolf/image.png
/Users/dwoolf/document.txt
/Users/dwoolf/data.csv`;

  const lines = input.split("\n");
  const detectedPaths = lines.filter((line) => matchesAnyPattern(line.trim(), UNIX_PATH_PATTERNS));

  assertEquals(detectedPaths.length, 3, "Should detect all three paths");

  const fileNames = detectedPaths.map((path) => extractFileName(path));
  assertEquals(fileNames, ["image.png", "document.txt", "data.csv"]);
});

Deno.test("Directory vs File Detection", () => {
  const testCases = [
    { path: "/Users/dwoolf/Documents", isDirectory: true },
    { path: "/Users/dwoolf/Documents/", isDirectory: true },
    { path: "/Users/dwoolf/file.txt", isDirectory: false },
    { path: "C:\\Windows\\System32", isDirectory: true },
    { path: "C:\\Windows\\System32\\", isDirectory: true },
    { path: "C:\\Users\\file.pdf", isDirectory: false },
    { path: "/usr/local/bin", isDirectory: true },
    { path: "/usr/local/bin/node", isDirectory: true }, // No extension = likely directory
    { path: "~/Downloads/archive.tar.gz", isDirectory: false },
  ];

  testCases.forEach(({ path, isDirectory }) => {
    const hasExt = hasFileExtension(path);
    const detectedAsDirectory = !hasExt;
    assertEquals(
      detectedAsDirectory,
      isDirectory,
      `Path "${path}" should be detected as ${isDirectory ? "directory" : "file"}`,
    );
  });
});

Deno.test("Attachment Type Detection - Large Text vs File Paths", () => {
  const testCases = [
    {
      description: "10+ lines with embedded paths should be text attachment",
      input: `Here is my analysis:
/Users/dwoolf/data.csv contains the raw data
The results are in /Users/dwoolf/results.txt
Line 4
Line 5
Line 6
Line 7
Line 8
Line 9
Line 10
Line 11`,
      expectedPaths: [], // No standalone paths
      shouldBeTextAttachment: true,
    },
    {
      description: "10+ lines of pure file paths should be file attachments",
      input: `/Users/dwoolf/file1.txt
/Users/dwoolf/file2.txt
/Users/dwoolf/file3.txt
/Users/dwoolf/file4.txt
/Users/dwoolf/file5.txt
/Users/dwoolf/file6.txt
/Users/dwoolf/file7.txt
/Users/dwoolf/file8.txt
/Users/dwoolf/file9.txt
/Users/dwoolf/file10.txt
/Users/dwoolf/file11.txt`,
      expectedPaths: [
        "/Users/dwoolf/file1.txt",
        "/Users/dwoolf/file2.txt",
        "/Users/dwoolf/file3.txt",
        "/Users/dwoolf/file4.txt",
        "/Users/dwoolf/file5.txt",
        "/Users/dwoolf/file6.txt",
        "/Users/dwoolf/file7.txt",
        "/Users/dwoolf/file8.txt",
        "/Users/dwoolf/file9.txt",
        "/Users/dwoolf/file10.txt",
        "/Users/dwoolf/file11.txt",
      ],
      shouldBeTextAttachment: false, // Should be file attachments
    },
    {
      description: "Less than 10 lines with paths stays as plain text",
      input: `Check out these files:
/Users/dwoolf/test.txt is the test file
/Users/dwoolf/data.csv has the data`,
      expectedPaths: [], // No standalone paths
      shouldBeTextAttachment: false, // Not enough lines for text attachment
    },
  ];

  testCases.forEach(({ description, input, expectedPaths }) => {
    const detectedPaths = extractFilePaths(input);

    assertEquals(
      detectedPaths.length,
      expectedPaths.length,
      `${description}: Expected ${expectedPaths.length} standalone paths`,
    );

    if (expectedPaths.length > 0) {
      assertEquals(detectedPaths, expectedPaths, `${description}: Paths should match`);
    }
  });
});

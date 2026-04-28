# Terminal Attachments Specification

## Overview

This specification defines how the Atlas CLI terminal interface handles attachments - including
large text blocks, file paths, and folder paths that are copy-pasted into the terminal. The system
intelligently categorizes pasted content and creates appropriate attachments while maintaining a
clean terminal interface.

**Note**: This specification is specific to the terminal/CLI interface. Other Atlas clients (web,
desktop apps) will have separate specifications for attachments that may include features like
drag-and-drop, file previews, and actual file uploads.

## Goals

1. **Smart Detection**: Intelligently categorize pasted content as text, file paths, or folder paths
2. **Clean Display**: Show concise placeholders while preserving full content
3. **Cross-Platform Support**: Handle path formats for macOS, Linux, and Windows
4. **Full Content Preservation**: Always send the complete original content when messages are
   submitted

## Attachment Types

### 1. Large Text Attachments

- **Trigger**: When pasted text contains 10+ lines AND is not exclusively file/folder paths
- **Display**: `[#1 15 lines of text]`
- **Content**: The full original text
- **Use Case**: Code snippets, logs, documentation, mixed content

### 2. File Path Attachments

- **Trigger**: When a line consists ENTIRELY of a valid file path (start to end)
- **Display**: `[#1 report.pdf]`
- **Content**: The full file path (e.g., `/Users/alice/Documents/report.pdf`)
- **Use Case**: Referencing specific files

### 3. Folder Path Attachments

- **Trigger**: When a line consists ENTIRELY of a valid folder path (start to end)
- **Display**: `[#1 Documents/]` (Unix/Mac) or `[#1 Documents\]` (Windows)
- **Content**: The full folder path
- **Use Case**: Referencing directories

## Detection Rules

### Critical Rule: Full Line Matching

File and folder paths are ONLY detected as attachments when they occupy an ENTIRE line by
themselves. Paths embedded within other text are NOT converted to attachments.

### Examples of Attachment Detection

#### Creates File Attachments:

```
/Users/alice/report.pdf
C:\Users\David\document.txt
~/Pictures/photo.jpg
```

#### Creates Text Attachment (10+ lines with mixed content):

```
Here is my file: /Users/alice/test.txt
And a folder: /Users/alice/Documents/
Some more text here
Line 4
Line 5
Line 6
Line 7
Line 8
Line 9
Line 10
```

#### Does NOT Create Any Attachments (< 10 lines):

```
Check out this file: /Users/alice/test.txt
It's in the Documents folder
```

### File Path Detection Patterns

#### macOS/Linux Paths

- **Absolute paths**: Start with `/` (e.g., `/Users/username/Documents/file.txt`)
- **Home paths**: Start with `~` (e.g., `~/Documents/file.txt`)
- **Relative paths**: Start with `./` or `../` (e.g., `./src/index.ts`)
- **Escaped spaces**: Paths with escaped spaces using `\` (e.g.,
  `/Users/name/My\ Documents/file.txt`)

#### Windows Paths

- **Drive letter paths**: Start with drive letter (e.g., `C:\Users\Username\Documents\file.txt`)
- **UNC paths**: Network paths (e.g., `\\server\share\file.txt`)
- **Forward slash variants**: Windows also accepts `/` (e.g., `C:/Users/Username/Documents`)

## Implementation Details

### Attachment Data Structure

```typescript
export type AttachmentData = {
  content: string; // Full original content (text, file path, or folder path)
  lineCount?: number; // Only for text attachments
  type: "text" | "file";
  fileName?: string; // Extracted name for file/folder attachments
};
```

### Detection Algorithm

1. **On Paste Event**:
   - Split content by newlines
   - Count total lines

2. **Categorization**:
   ```typescript
   if (lines.length >= 10) {
     // Check if ALL lines are valid file/folder paths
     const detectedPaths = detectFilePaths(content);
     const isOnlyFilePaths = lines.length === detectedPaths.length &&
       detectedPaths.every((path) => lines.includes(path.originalText.trim()));

     if (isOnlyFilePaths) {
       // Create individual file attachments for each path
       createFileAttachments(detectedPaths);
     } else {
       // Create single text attachment for mixed content
       createTextAttachment(content, lines.length);
     }
   } else if (lines.length === 1) {
     // Check if single line is a file/folder path
     const detectedPaths = detectFilePaths(content);
     if (detectedPaths.length === 1) {
       createFileAttachment(detectedPaths[0]);
     } else {
       // Insert as regular text (no attachment)
       insertText(content);
     }
   } else {
     // Less than 10 lines, not a single path
     // Insert as regular text (no attachment)
     insertText(content);
   }
   ```

### Placeholder Generation

```typescript
function generatePlaceholder(attachment: AttachmentData, id: number): string {
  if (attachment.type === "file") {
    const hasExt = attachment.fileName && /\.[a-zA-Z0-9]+$/.test(attachment.fileName);
    const isDirectory = !hasExt;
    const separator = Deno.build.os === "windows" ? "\\" : "/";
    return isDirectory
      ? `[#${id} ${attachment.fileName}${separator}]`
      : `[#${id} ${attachment.fileName}]`;
  } else {
    // Text attachment format
    return `[#${id} ${attachment.lineCount} lines of text]`;
  }
}
```

### Message Submission

When the user submits a message:

1. All placeholders are replaced with their full original content
2. File path attachments: Full path is sent (e.g., `/Users/alice/Documents/report.pdf`)
3. Folder path attachments: Full path is sent (e.g., `/Users/alice/Documents/`)
4. Text attachments: Full multi-line text is sent

## Usage Examples

### Example 1: Large Text Block

```
User pastes 15 lines of code
Display in input: [#1 15 lines of text]
Sent to server: <full 15 lines of code>
```

### Example 2: Single File Path

```
User pastes: /Users/alice/Documents/report.pdf
Display in input: [#1 report.pdf]
Sent to server: /Users/alice/Documents/report.pdf
```

### Example 3: Multiple File Paths

```
User pastes:
/Users/alice/image.png
/Users/alice/document.txt
/Users/alice/data.csv

Display in input:
[#1 image.png]
[#2 document.txt]
[#3 data.csv]

Sent to server:
/Users/alice/image.png
/Users/alice/document.txt
/Users/alice/data.csv
```

### Example 4: Mixed Content (Creates Text Attachment)

```
User pastes 12 lines including:
Here is my analysis:
/Users/alice/data.csv contains the raw data
The results are in /Users/alice/results.txt
... (9 more lines)

Display in input: [#1 12 lines of text]
Sent to server: <full 12 lines including embedded paths>
```

### Example 5: Short Mixed Content (No Attachment)

```
User pastes:
Check the file at /Users/alice/test.txt

Display in input: Check the file at /Users/alice/test.txt
Sent to server: Check the file at /Users/alice/test.txt
```

## Terminal-Specific Constraints

1. **Text-Only Display**: No thumbnails, previews, or rich media
2. **Monospace Formatting**: All placeholders use bracketed format `[#id description]`
3. **No Emojis**: Maintain terminal compatibility across all systems
4. **Keyboard Navigation**: Attachments are part of the text flow

## Security Considerations

1. **No File Access**: System only stores path strings, never accesses file contents
2. **No Validation**: Paths are not validated against the file system
3. **No Execution**: Paths are treated as plain text, never executed
4. **User Control**: Users explicitly paste content and can see placeholders before sending

## Testing Requirements

1. **Text Attachment Tests**
   - Verify 10+ lines trigger text attachment
   - Verify < 10 lines don't create attachment
   - Verify full content preservation

2. **File Path Tests**
   - Single file path detection
   - Multiple file paths on separate lines
   - Various path formats (absolute, relative, home)
   - Cross-platform path formats

3. **Mixed Content Tests**
   - File paths embedded in text create text attachment (10+ lines)
   - File paths embedded in text stay as plain text (< 10 lines)
   - Verify only full-line paths become file attachments

4. **Edge Cases**
   - Empty lines in paste
   - Paths with special characters
   - Very long paths
   - Dotfiles (e.g., .gitignore)

## Success Metrics

- **Correct Categorization**: 100% accuracy in distinguishing text vs file attachments
- **Content Preservation**: 100% of original content sent to server
- **User Experience**: Clear, concise placeholders that don't clutter the terminal
- **Performance**: Instant detection and placeholder generation (<50ms)

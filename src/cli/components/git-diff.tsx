import { Box, Text } from "ink";
import { Collapsible } from "./collapsible.tsx";

export interface GitDiffProps {
  /** The diff content as a formatted text blob */
  readonly diffContent: string;
  /** Starting line number for the diff */
  readonly startingLine: number;
  /** Ending line number for the diff */
  readonly endingLine: number;
}

interface DiffLine {
  type: "addition" | "removal" | "unchanged";
  content: string;
  lineNumber: number;
}

export function GitDiff({ diffContent, startingLine }: GitDiffProps) {
  const lines = diffContent.split(/[\n\r]/);
  const diffLines: DiffLine[] = [];
  let currentLineNumber = startingLine;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line && line.startsWith("-")) {
      diffLines.push({
        type: "removal",
        content: line.slice(1), // Remove the - prefix
        lineNumber: currentLineNumber,
      });
      currentLineNumber++;
    } else if (line && line.startsWith("+")) {
      // Check if there are removals immediately before this addition
      let removalCount = 0;
      let checkIndex = diffLines.length - 1;

      // Count consecutive removals before this addition
      while (checkIndex >= 0 && diffLines[checkIndex]?.type === "removal") {
        removalCount++;
        checkIndex--;
      }

      if (removalCount > 0) {
        // Reset to the first removal's line number
        currentLineNumber = diffLines[diffLines.length - removalCount]?.lineNumber || 0;
      }

      diffLines.push({
        type: "addition",
        content: line.slice(1), // Remove the + prefix
        lineNumber: currentLineNumber,
      });
      currentLineNumber++;
    } else {
      diffLines.push({
        type: "unchanged",
        content: String(line),
        lineNumber: currentLineNumber,
      });
      currentLineNumber++;
    }
  }

  return (
    <Collapsible totalLines={diffLines.length}>
      <Box flexDirection="column" flexShrink={0}>
        {diffLines.map((diffLine, index) => (
          <Box key={index} flexDirection="row" flexShrink={0}>
            {/* Line number column */}
            <Box width={4} justifyContent="flex-end" marginRight={1}>
              <Text dimColor>
                {diffLine.lineNumber.toString().padStart(3, " ")}
              </Text>
            </Box>

            {/* Diff content with appropriate styling */}
            {diffLine.type === "addition" && (
              <Text backgroundColor="#1A593B" color="whiteBright">
                +{diffLine.content}
              </Text>
            )}

            {diffLine.type === "removal" && (
              <Text backgroundColor="#8F473C" color="whiteBright">
                -{diffLine.content}
              </Text>
            )}

            {diffLine.type === "unchanged" && <Text>{diffLine.content}</Text>}
          </Box>
        ))}
      </Box>
    </Collapsible>
  );
}

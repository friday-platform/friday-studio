import { Box } from "ink";
import SyntaxHighlight from "ink-syntax-highlight";
import { Collapsible } from "./collapsible.tsx";

interface YamlDisplayProps {
  content: string;
}

export const YamlDisplay = ({ content }: YamlDisplayProps) => {
  // Calculate the number of lines in the YAML content
  const lineCount = content.split("\n").length;

  return (
    <Box flexDirection="column">
      <Collapsible totalLines={lineCount}>
        <SyntaxHighlight
          code={content}
          language="yaml"
        />
      </Collapsible>
    </Box>
  );
};

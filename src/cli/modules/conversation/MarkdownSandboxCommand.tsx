import { Box } from "ink";
import { MarkdownDisplay } from "../../components/markdown-display.tsx";
import { OutputEntry } from "./types.ts";

interface MarkdownSandboxCommandProps {
  onComplete: () => void;
}

const MARKDOWN_EXAMPLES = `# Markdown Syntax Examples

## Headers
# H1 Header
## H2 Header
### H3 Header
#### H4 Header
##### H5 Header
###### H6 Header

## Text Formatting
**Bold text**
*Italic text*
***Bold and italic***
~~Strikethrough~~
\`Inline code\`

## Lists
### Unordered List
- First item
- Second item
  - Nested item
  - Another nested item
- Third item

### Ordered List
1. **First item**
2. Second item
   1. Nested item
   2. Another nested item
3. Third item

## Links
[Link text](https://example.com)
[Link with title](https://example.com "Title text")

## Blockquotes
> This is a blockquote
> 
> > Nested blockquote
> 
> Back to first level

## Code Blocks
\`\`\`typescript
// TypeScript code block
interface User {
  name: string;
  age: number;
}

const greet = (user: User): string => {
  return \`Hello, \${user.name}!\`;
};
\`\`\`

\`\`\`bash
# Bash code block
echo "Hello, World!"
ls -la
\`\`\`

## Tables
| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |


## Task Lists
- [x] Completed task
- [ ] Incomplete task
- [ ] Another task

## Line Breaks
Line 1  
Line 2 (two spaces before line break)

Line 3 (blank line for paragraph break)
`;

export function MarkdownSandboxCommand({
  onComplete,
}: MarkdownSandboxCommandProps) {
  const entry: OutputEntry = {
    id: `markdown-sandbox-${Date.now()}`,
    component: (
      <Box flexDirection="column" marginY={1}>
        <MarkdownDisplay content={MARKDOWN_EXAMPLES} showCollapsible={true} />
      </Box>
    ),
  };

  // Complete immediately after creating the entry
  setTimeout(onComplete, 0);

  return entry;
}

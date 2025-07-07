import { Text } from "ink";
import { marked } from "npm:marked";
import TerminalRenderer from "npm:marked-terminal";
import { Collapsible } from "./collapsible.tsx";
import chalk from "chalk";

interface MarkdownDisplayProps {
  content: string;
  showCollapsible?: boolean;
}

// Configure marked with terminal renderer
marked.setOptions({
  renderer: new TerminalRenderer({
    code: chalk.dim,
    blockquote: chalk.gray.italic.dim,
    html: chalk.gray.dim,
    heading: chalk.reset.bold,
    firstHeading: chalk.reset.bold,
    hr: chalk.reset.dim,
    list: chalk.reset,
    listitem: chalk.reset,
    table: chalk.reset,
    tablerow: chalk.reset,
    tableheader: chalk.reset.bold,
    tablecell: chalk.reset,
    paragraph: chalk.reset,
    strong: chalk.bold,
    em: chalk.italic,
    codespan: chalk.yellow,
    del: chalk.dim.gray.strikethrough,
    link: chalk.yellow,
    href: chalk.yellow.underline,
    tab: 2,
    tableOptions: {
      style: {
        head: ["white", "bold"],
      },
    },
  }),
});

export const MarkdownDisplay = ({
  content,
  showCollapsible = false,
}: MarkdownDisplayProps) => {
  const markdown = marked(content) as string;
  const lines = markdown.split("\n");

  return showCollapsible
    ? (
      <Collapsible totalLines={lines.length}>
        <Text>{markdown}</Text>
      </Collapsible>
    )
    : <Text>{markdown}</Text>;
};

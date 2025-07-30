import { Text } from "ink";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";
import { Collapsible } from "./collapsible.tsx";
import chalk from "chalk";

interface MarkdownDisplayProps {
  content: string;
  showCollapsible?: boolean;
  dimColor?: boolean;
}

const BULLET_POINT_REGEX = "\\*";
const NUMBERED_POINT_REGEX = "\\d+\\.";
const POINT_REGEX = "(?:" + [BULLET_POINT_REGEX, NUMBERED_POINT_REGEX].join("|") + ")";

const BULLET_POINT = "* ";

function toSpaces(str: string) {
  return " ".repeat(str.length);
}

function bulletPointLine(indent: number, line: string) {
  return isPointedLine(line, indent) ? line : toSpaces(BULLET_POINT) + line;
}

function isPointedLine(line: string, indent: number) {
  return line.match("^(?:" + indent + ")*" + POINT_REGEX);
}

function bulletPointLines(lines: string, indent: number) {
  const transform = bulletPointLine.bind(null, indent);
  return lines.split("\n").map(transform).join("\n");
}

function numberedPoint(n: number) {
  return n + ". ";
}
function numberedLine(indent: number, line: string, num: number) {
  return isPointedLine(line, indent)
    ? {
      num: num + 1,
      line: line.replace(BULLET_POINT, numberedPoint(num + 1)),
    }
    : {
      num: num,
      line: toSpaces(numberedPoint(num)) + line,
    };
}

function numberedLines(lines: string, indent: number) {
  const transform = numberedLine.bind(null, indent);
  let num = 0;
  return lines
    .split("\n")
    .map((line) => {
      const numbered = transform(line, num);
      num = numbered.num;

      return numbered.line;
    })
    .join("\n");
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
    list: function (body: string, ordered: boolean, indent: number) {
      body = body.trim();
      body = ordered ? numberedLines(body, indent) : bulletPointLines(body, indent);
      return body;
    },
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
  dimColor = false,
}: MarkdownDisplayProps) => {
  marked.setOptions({
    renderer: new TerminalRenderer({
      code: chalk.dim,
      blockquote: chalk.gray.italic.dim,
      html: chalk.gray.dim,
      heading: dimColor ? chalk.reset.bold.dim : chalk.reset.bold,
      firstHeading: dimColor ? chalk.reset.bold.dim : chalk.reset.bold,
      hr: dimColor ? chalk.reset.dim.dim : chalk.reset.dim,
      list: function (body: string, ordered: boolean, indent: number) {
        body = body.trim();
        body = ordered ? numberedLines(body, indent) : bulletPointLines(body, indent);
        return body;
      },
      listitem: dimColor ? chalk.reset.dim : chalk.reset,
      table: dimColor ? chalk.reset.dim : chalk.reset,
      tablerow: dimColor ? chalk.reset.dim : chalk.reset,
      tableheader: dimColor ? chalk.reset.bold.dim : chalk.reset.bold,
      tablecell: dimColor ? chalk.reset.dim : chalk.reset,
      paragraph: dimColor ? chalk.reset.dim : chalk.reset,
      strong: dimColor ? chalk.bold.dim : chalk.bold,
      em: dimColor ? chalk.italic.dim : chalk.italic,
      codespan: dimColor ? chalk.reset.dim : chalk.yellow,
      del: dimColor ? chalk.strikethrough.dim : chalk.dim.gray.strikethrough,
      link: dimColor ? chalk.reset.dim : chalk.yellow,
      href: dimColor ? chalk.reset.underline.dim : chalk.yellow.underline,
      tab: 2,
      tableOptions: {
        style: {
          head: ["white", "bold"],
        },
      },
    }),
  });

  let markdown = marked(content) as string;
  markdown = markdown.replace(/[\r\n]+$/g, "");
  const lines = markdown.split("\n");

  return showCollapsible
    ? (
      <Collapsible totalLines={lines.length}>
        <Text dimColor={dimColor}>{markdown}</Text>
      </Collapsible>
    )
    : <Text dimColor={dimColor}>{markdown}</Text>;
};

import chalk from "chalk";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";
import { useResponsiveDimensions } from "../../utils/useResponsiveDimensions.ts";

const BULLET_POINT_REGEX = "\\*";
const NUMBERED_POINT_REGEX = "\\d+\\.";
const POINT_REGEX = `(?:${[BULLET_POINT_REGEX, NUMBERED_POINT_REGEX].join("|")})`;

const BULLET_POINT = "* ";

function toSpaces(str: string) {
  return " ".repeat(str.length);
}

function bulletPointLine(indent: number, line: string) {
  return isPointedLine(line, indent) ? line : toSpaces(BULLET_POINT) + line;
}

function isPointedLine(line: string, indent: number) {
  return line.match(`^(?:${indent})*${POINT_REGEX}`);
}

function bulletPointLines(lines: string, indent: number) {
  const transform = bulletPointLine.bind(null, indent);
  return lines.split("\n").map(transform).join("\n");
}

function numberedPoint(n: number) {
  return `${n}. `;
}
function numberedLine(indent: number, line: string, num: number) {
  return isPointedLine(line, indent)
    ? { num: num + 1, line: line.replace(BULLET_POINT, numberedPoint(num + 1)) }
    : { num: num, line: toSpaces(numberedPoint(num)) + line };
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

export function useMarkdown(message = "", isDim = false) {
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  marked.setOptions({
    renderer: new TerminalRenderer({
      code: chalk.dim,
      blockquote: chalk.gray.italic.dim,
      html: chalk.gray.dim,
      heading: isDim ? chalk.reset.bold.dim : chalk.reset.bold,
      firstHeading: isDim ? chalk.reset.bold.dim : chalk.reset.bold,
      hr: isDim ? chalk.reset.dim.dim : chalk.reset.dim,
      list: (body: string, ordered: boolean, indent: number) => {
        body = body.trim();
        body = ordered ? numberedLines(body, indent) : bulletPointLines(body, indent);
        return body;
      },
      listitem: isDim ? chalk.reset.dim : chalk.reset,
      table: isDim ? chalk.reset.dim : chalk.reset,
      tablerow: isDim ? chalk.reset.dim : chalk.reset,
      tableheader: isDim ? chalk.reset.bold.dim : chalk.reset.bold,
      tablecell: isDim ? chalk.reset.dim : chalk.reset,
      paragraph: isDim ? chalk.reset.dim : chalk.reset,
      strong: isDim ? chalk.bold.dim : chalk.bold,
      em: isDim ? chalk.italic.dim : chalk.italic,
      codespan: isDim ? chalk.reset.dim : chalk.yellow,
      del: isDim ? chalk.strikethrough.dim : chalk.dim.gray.strikethrough,
      link: isDim ? chalk.reset.dim : chalk.yellow,
      href: isDim ? chalk.reset.underline.dim : chalk.yellow.underline,
      tab: 2,
      tableOptions: { style: { head: ["white", "bold"] } },
    }),
  });

  const markdown = marked(message.trim(), { async: false });
  const markdownParsed = markdown.replace(/[\r\n]+$/g, "").trim();
  const lines = markdownParsed
    .split("\n")
    .filter((line, index, array) => !(line === "" && (index === 0 || index === array.length - 1)));
  const height = lines
    .map((line) => Math.max(1, Math.ceil(line.length / dimensions.paddedWidth)))
    .reduce((a, b) => a + b, 0);

  return { height, totalLines: lines.length, markdown: lines.join("\n") };
}

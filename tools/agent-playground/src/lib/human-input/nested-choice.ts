export type NestedChoiceAction = {
  value: string;
  label: string;
};

export type NestedChoiceItem = {
  index: number;
  title: string;
  detail: string;
  actions: NestedChoiceAction[];
};

export type NestedChoicePrompt = {
  intro: string;
  items: NestedChoiceItem[];
  instructions: string;
};

const ITEM_RE =
  /(?:^|\n)\s*\[(\d+)\]\s*([\s\S]*?)(?=(?:\n\s*\[\d+\])|(?:\n\s*```)|(?:\n\s*Enter choices as:)|$)/gi;
const ACTION_RE = /\(([A-Za-z0-9])\)\s*([^()]*?)(?=\s+\([A-Za-z0-9]\)|$)/g;

function stripFenceTail(text: string): string {
  return text.replace(/```[\w-]*\s*$/u, "").trim();
}

function stripFenceHead(text: string): string {
  return text.replace(/^\s*```[\w-]*\s*/u, "").trim();
}

function readLineValue(block: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}:\\s*(.+)$`, "im");
  return block.match(re)?.[1]?.trim() ?? null;
}

function parseActions(block: string): NestedChoiceAction[] {
  const actionLine = block.match(/^\s*Actions:\s*(.+)$/im)?.[1];
  if (!actionLine) return [];

  const actions: NestedChoiceAction[] = [];
  for (const match of actionLine.matchAll(ACTION_RE)) {
    const value = match[1]?.toUpperCase();
    const suffix = match[2]?.trim() ?? "";
    if (!value) continue;
    actions.push({ value, label: `${value}${suffix}`.trim() });
  }
  return actions;
}

function summarizeItem(
  index: number,
  block: string,
): Omit<NestedChoiceItem, "actions"> {
  const subject = readLineValue(block, "Subject");
  const from = readLineValue(block, "From");
  const date = readLineValue(block, "Date");
  const preview = readLineValue(block, "Preview");
  const fallback = block
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("Actions:"));

  return {
    index,
    title: subject ?? fallback ?? `Item ${index}`,
    detail: [
      from ? `From: ${from}` : null,
      date ? `Date: ${date}` : null,
      preview,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function parseNestedChoicePrompt(
  question: string,
): NestedChoicePrompt | null {
  const normalized = question.replace(/\r\n?/g, "\n");
  if (
    !/Enter choices as:/i.test(normalized) || !/^\s*Actions:/im.test(normalized)
  ) {
    return null;
  }

  const matches = Array.from(normalized.matchAll(ITEM_RE));
  if (matches.length < 2) return null;

  const items: NestedChoiceItem[] = [];
  for (const match of matches) {
    const index = Number(match[1]);
    const block = match[2] ?? "";
    const actions = parseActions(block);
    if (!Number.isFinite(index) || actions.length < 2) return null;
    items.push({ ...summarizeItem(index, block), actions });
  }

  const first = matches[0]!;
  const last = matches.at(-1);
  const intro = stripFenceTail(normalized.slice(0, first.index ?? 0));
  const lastEnd = (last?.index ?? 0) + (last?.[0].length ?? 0);
  const instructions = stripFenceHead(normalized.slice(lastEnd));

  return { intro, items, instructions };
}

export function buildNestedChoiceAnswer(
  choices: Record<string, string>,
): string {
  return Object.entries(choices)
    .filter(([, value]) => value.trim().length > 0)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([index, value]) => `${index}=${value.trim()}`)
    .join(" ");
}

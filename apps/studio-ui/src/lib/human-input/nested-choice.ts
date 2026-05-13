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

export type HumanInputOption = {
  label: string;
  value: string;
};

const ITEM_RE =
  /(?:^|\n)\s*\[(\d+)\]\s*([\s\S]*?)(?=(?:\n\s*\[\d+\])|(?:\n\s*```)|(?:\n\s*Enter choices as:)|$)/gi;
const ACTION_RE = /\(([A-Za-z0-9])\)\s*([^()]*?)(?=\s+\([A-Za-z0-9]\)|$)/g;
const OPTION_GROUP_RE = /^\s*\[([^\]]+)\]\s*(.+?)(?:\s+[—-]\s+(.+))?\s*$/u;

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

function questionItemsByIndex(
  question: string,
): Map<string, Omit<NestedChoiceItem, "actions">> {
  const normalized = question.replace(/\r\n?/g, "\n");
  const items = new Map<string, Omit<NestedChoiceItem, "actions">>();
  for (const match of normalized.matchAll(ITEM_RE)) {
    const key = match[1];
    if (!key) continue;
    const index = Number(key);
    if (!Number.isFinite(index)) continue;
    items.set(key, summarizeItem(index, match[2] ?? ""));
  }
  return items;
}

function numericSort(a: string, b: string): number {
  const left = Number(a);
  const right = Number(b);
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  return a.localeCompare(b);
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

/**
 * Detects the common nested-choice shape agents produce today with the flat
 * `request_human_input.options` contract: `[1] Archive — subject` labels and
 * `1:archive` values. The UI can render this as one choice set per item while
 * still submitting the original option values back to the agent.
 */
export function parseGroupedOptionPrompt(
  question: string,
  options: readonly HumanInputOption[] | undefined,
): NestedChoicePrompt | null {
  if (!options || options.length < 4) return null;

  const byQuestionIndex = questionItemsByIndex(question);
  const groups = new Map<
    string,
    { title?: string; actions: NestedChoiceAction[] }
  >();

  for (const option of options) {
    const colon = option.value.indexOf(":");
    if (colon <= 0 || colon === option.value.length - 1) return null;
    const key = option.value.slice(0, colon);
    if (!/^\d+$/.test(key)) return null;
    const labelMatch = OPTION_GROUP_RE.exec(option.label);
    if (!labelMatch || labelMatch[1] !== key) return null;

    const actionLabel = labelMatch[2]?.trim();
    if (!actionLabel) return null;
    const title = labelMatch[3]?.trim();
    const group = groups.get(key) ?? { actions: [] };
    if (title && !group.title) group.title = title;
    group.actions.push({ label: actionLabel, value: option.value });
    groups.set(key, group);
  }

  if (
    groups.size < 2 ||
    Array.from(groups.values()).some((g) => g.actions.length < 2)
  ) {
    return null;
  }

  const firstItem = Array.from(question.matchAll(ITEM_RE))[0];
  const intro = stripFenceTail(question.slice(0, firstItem?.index ?? 0));
  const items = Array.from(groups.entries())
    .sort(([a], [b]) => numericSort(a, b))
    .map(([key, group]) => {
      const index = Number(key);
      const fromQuestion = byQuestionIndex.get(key);
      return {
        index,
        title: group.title ?? fromQuestion?.title ?? `Item ${key}`,
        detail: fromQuestion?.detail ?? "",
        actions: group.actions,
      };
    });

  return {
    intro: intro || question.trim(),
    items,
    instructions:
      "Select one action per item. Items without a selected action are left unchanged.",
  };
}

export function buildNestedChoiceAnswer(
  choices: Record<string, string>,
): string {
  return Object.entries(choices)
    .filter(([, value]) => value.trim().length > 0)
    .sort(([a], [b]) => numericSort(a, b))
    .map(([index, value]) => `${index}=${value.trim()}`)
    .join(" ");
}

export function buildGroupedOptionAnswer(
  choices: Record<string, string>,
): string {
  const selected = Object.entries(choices)
    .filter(([, value]) => value.trim().length > 0)
    .sort(([a], [b]) => numericSort(a, b))
    .map(([, value]) => value.trim());
  return JSON.stringify(selected);
}

export function formatChoiceComments(comments: Record<string, string>): string {
  return Object.entries(comments)
    .filter(([, value]) => value.trim().length > 0)
    .sort(([a], [b]) => numericSort(a, b))
    .map(([index, value]) => `[${index}] ${value.trim()}`)
    .join("\n");
}

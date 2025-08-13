import type { Options } from "prettier";
import prettierBabel from "prettier/plugins/babel";
import prettierEstree from "prettier/plugins/estree";
import { format } from "prettier/standalone";

/**
 * Splits a string into an array of objects indicating whether each
 * object's substring is a case-insensitive match on a given query.
 * The result can then be used to visually show matching substrings.
 *
 * @example
 * const match = parseHighlight("Dang", "da");
 * // [{value: "Da", isHighlighted: true}, {value: "ng", isHighlighted: false}]
 * @example
 * const nomatch = parseHighlight("Dang", "");
 * // [{value: "Dang", isHighlighted: false}]
 */
export function parseHighlight(
  value: string,
  query: string,
): Array<{ isHighlighted: boolean; value: string }> {
  // No query is given—there's nothing to highlight.
  if (query === "") {
    return [{ value, isHighlighted: false }];
    // The query fully matches the value—highlight the whole value.
  } else if (query.toLocaleLowerCase() === value.toLocaleLowerCase()) {
    return [{ value, isHighlighted: true }];
  }
  // Split the string based on capture groups matching the given query.
  const regex = new RegExp(`(${query})`, "gi");
  return value.split(regex).map((part) => {
    // ...and see if each part is a match.
    if (part.toLocaleLowerCase() === query.toLocaleLowerCase()) {
      return { value: part, isHighlighted: true };
    }
    return { value: part, isHighlighted: false };
  });
}

/**
 * Returns initials for a user's full name.
 */
export function getInitials(fullName: string) {
  if (fullName === "") return "";

  const split = fullName
    .trim()
    .split(" ")
    .filter((str) => str !== "");

  if (split.length === 1) {
    return fullName.substring(0, 2);
  } else {
    return `${split?.[0]?.substring(0, 1)}${split?.[1]?.substring(0, 1)}`;
  }
}

/**
 * Formats a list of items into a human-readable localized string list.
 * @example
 * listFormatter.format(["apple", "banana", "cherry"]);
 * // "apple, banana, & cherry"
 */
export const listFormatter = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * During local development, cookies are sent with the domain `localhost`.
 * In hosted environments, cookies are set on top-level domain, (tempestdx.dev
 * or tempestdx.com) rather than the fqdn (app.tempestdx.dev or app.tempestdx.com).
 *
 * As a result, clearing cookies in a hosted environment was ineffective because they
 * attempted to use the fqdn instead of updating existing cookie for the top-level domain.
 * @param hostname
 */
export function getRootDomain(hostname: string): string {
  if (hostname === "localhost") {
    return "localhost";
  }

  const parts = hostname.split(".");
  if (parts.length <= 2) {
    return hostname; // Handle cases like "example.com"
  }

  // Drop the first segment and return the remaining parts joined with a dot
  return parts.slice(1).join(".");
}

export async function formatJson(text: string, prettierOpts: Options = {}): Promise<string> {
  return await format(text, {
    parser: "json",
    plugins: [prettierBabel, prettierEstree],
    ...prettierOpts,
  });
}

/**
 * Downloads a JSON file to the user's computer.
 * @param filename The name of the file to download.
 * @param content The content of the file to download.
 */
export function downloadJson(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Downloads a CSV file to the user's computer.
 * @param filename The name of the file to download.
 * @param content The content of the file to download.
 */
export function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function copyToClipboard(text: string | Array<string | null>) {
  try {
    const contents = Array.isArray(text) ? text.filter(Boolean).join("\n") : text;
    await navigator.clipboard.writeText(contents);
  } catch (e) {
    console.error(e);
  }
}

export function debounce<F extends (...args: Parameters<F>) => ReturnType<F>>(
  func: F,
  waitFor: number,
): (...args: Parameters<F>) => void {
  let timeout: ReturnType<typeof setTimeout>;

  return (...args: Parameters<F>): void => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), waitFor);
  };
}

export function transposeNumbers(first: number, second: number) {
  return first <= second ? [first, second] : [second, first];
}

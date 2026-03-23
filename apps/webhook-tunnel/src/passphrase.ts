/**
 * Passphrase generator using the random-words package.
 *
 * Generates memorable passphrases from common English words.
 */

import { generate } from "random-words";

/**
 * Generate a passphrase.
 *
 * @param wordCount Number of words (default: 4)
 * @param separator Word separator (default: "-")
 * @returns Passphrase like "crystal-mountain-river-dance"
 */
export function generatePassphrase(wordCount = 4, separator = "-"): string {
  const words = generate({ exactly: wordCount, maxLength: 8 });
  return Array.isArray(words) ? words.join(separator) : words;
}

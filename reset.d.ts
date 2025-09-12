/**
 * ts-reset - Fixes TypeScript's loose default types
 * @see https://www.totaltypescript.com/ts-reset
 *
 * Makes TypeScript safer by default:
 * - JSON.parse() and .json() return `unknown` instead of `any`
 * - .filter(Boolean) properly removes falsy values
 * - .includes() and .indexOf() work correctly with const arrays
 * - Set.has() and Map.has() accept any value, not just set/map contents
 * - localStorage/sessionStorage return `unknown` for type safety
 * - Array.isArray() no longer adds `any[]` to type unions
 */
import "@total-typescript/ts-reset";

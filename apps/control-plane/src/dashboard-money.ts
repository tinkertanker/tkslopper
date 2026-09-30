/**
 * Pure helpers shared by the dashboard page and its unit tests.
 *
 * `dashboard.ts` embeds these functions into the page's inline script with
 * `Function.prototype.toString`, so each one must be fully self-contained: no
 * references to imports or other module-level names, no nested named function
 * bindings (bundlers may wrap those in helpers that do not exist in the
 * browser), and only syntax every supported browser runs natively. The page
 * binds each embedded source to a fixed name, so bundler renaming is harmless.
 *
 * Money is shown in US dollars and stored as integer microcents:
 * 1 US dollar = 100,000,000 μ¢, so any amount with at most eight decimal places
 * converts exactly. Conversion works on the decimal string and BigInt, never
 * floating point.
 */

/** Largest classroom amount accepted by the API: 1e15 μ¢, i.e. US$10,000,000. */
export const DASHBOARD_MICROCENTS_MAX = 1_000_000_000_000_000;

/**
 * Formats integer microcents as US dollars with at least two and at most
 * eight decimal places. `grouped` adds thousands separators and a `$` sign
 * ("$1,234.50"); otherwise the plain decimal suits an input ("1234.50").
 * Missing values render as an em dash (or an empty string when ungrouped).
 */
export function formatDollars(
  value: string | number | bigint | null | undefined,
  grouped: boolean,
): string {
  if (value === null || value === undefined || value === "")
    return grouped ? "—" : "";
  let amount: bigint;
  try {
    amount = BigInt(String(value));
  } catch {
    return String(value);
  }
  const perDollar = BigInt(100000000);
  const negative = amount < BigInt(0);
  if (negative) amount = -amount;
  const whole = (amount / perDollar).toString();
  let fraction = (amount % perDollar)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  const wholeText = grouped ? whole.replace(/\B(?=(\d{3})+$)/g, ",") : whole;
  return (
    (negative ? "-" : "") + (grouped ? "$" : "") + wholeText + "." + fraction
  );
}

/**
 * Parses a US dollar amount typed by a person into integer microcents.
 * Accepts an optional "$" or "US$" prefix, surrounding spaces, and thousands
 * separators only in their proper place (so "1,5" is never read as 15).
 * Rejects negatives, exponents, more than eight decimal places and anything
 * above US$10,000,000.
 */
export function parseDollars(
  text: string | null | undefined,
): { empty: true } | { error: string } | { value: number } {
  const cleaned = String(text ?? "")
    .trim()
    .replace(/^(?:US)?\$\s*/i, "");
  if (cleaned === "") return { empty: true };
  if (/^[-−]/.test(cleaned)) return { error: "must not be negative" };
  const plain = /^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(cleaned)
    ? cleaned.replace(/,/g, "")
    : cleaned;
  const match = /^(\d*)(?:\.(\d*))?$/.exec(plain);
  if (!match || (!match[1] && !match[2]))
    return { error: "must be an amount in US dollars, such as 5 or 2.50" };
  const fraction = match[2] || "";
  if (fraction.length > 8)
    return {
      error: "can have at most 8 decimal places (1 μ¢ is $0.00000001)",
    };
  const microcents =
    BigInt(match[1] || "0") * BigInt(100000000) +
    BigInt(fraction.padEnd(8, "0"));
  if (microcents > BigInt(1000000000000000))
    return { error: "can be at most $10,000,000" };
  return { value: Number(microcents) };
}

/**
 * Quotes one CSV cell. Cells a spreadsheet would execute as a formula
 * (starting with =, +, -, @, tab or carriage return) are prefixed with an
 * apostrophe so exported student names cannot run anything.
 */
export function csvCell(value: string | number | null | undefined): string {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

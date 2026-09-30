import { describe, expect, it } from "vitest";

import {
  DASHBOARD_EMBEDDED_HELPERS,
  dashboardPage,
} from "../apps/control-plane/src/dashboard";
import {
  DASHBOARD_MICROCENTS_MAX,
  csvCell,
  formatDollars,
  parseDollars,
} from "../apps/control-plane/src/dashboard-money";
import { CLASSROOM_MICROCENTS_MAX } from "../packages/shared/src/classrooms";

describe("dashboard dollar parsing", () => {
  it.each([
    ["5", 500_000_000],
    ["0.1", 10_000_000],
    [".5", 50_000_000],
    ["1.", 100_000_000],
    ["$5", 500_000_000],
    ["US$ 3", 300_000_000],
    ["us$3", 300_000_000],
    [" 2.50 ", 250_000_000],
    ["1,000", 100_000_000_000],
    ["1,234,567.89", 123_456_789_000_000],
    ["0.00000001", 1],
    ["0.15", 15_000_000],
    ["0", 0],
    ["10,000,000", 1_000_000_000_000_000],
  ])("converts %j exactly to %d microcents", (text, microcents) => {
    expect(parseDollars(text)).toEqual({ value: microcents });
  });

  it("treats blank input as empty", () => {
    expect(parseDollars("")).toEqual({ empty: true });
    expect(parseDollars("   ")).toEqual({ empty: true });
    expect(parseDollars("$")).toEqual({ empty: true });
    expect(parseDollars(undefined)).toEqual({ empty: true });
  });

  it.each([
    ["-5", "must not be negative"],
    ["−5", "must not be negative"],
    ["$-1", "must not be negative"],
    [".", "must be an amount in US dollars, such as 5 or 2.50"],
    ["1e3", "must be an amount in US dollars, such as 5 or 2.50"],
    ["1,5", "must be an amount in US dollars, such as 5 or 2.50"],
    ["1,0000", "must be an amount in US dollars, such as 5 or 2.50"],
    ["1.2.3", "must be an amount in US dollars, such as 5 or 2.50"],
    ["five", "must be an amount in US dollars, such as 5 or 2.50"],
    ["0x10", "must be an amount in US dollars, such as 5 or 2.50"],
    ["0.000000001", "can have at most 8 decimal places (1 μ¢ is $0.00000001)"],
    ["10000000.00000001", "can be at most $10,000,000"],
    ["10,000,001", "can be at most $10,000,000"],
    ["99999999999999999999", "can be at most $10,000,000"],
  ])("rejects %j", (text, error) => {
    expect(parseDollars(text)).toEqual({ error });
  });

  it("caps amounts at the classroom API maximum", () => {
    expect(DASHBOARD_MICROCENTS_MAX).toBe(CLASSROOM_MICROCENTS_MAX);
    expect(parseDollars("10000000")).toEqual({
      value: DASHBOARD_MICROCENTS_MAX,
    });
  });
});

describe("dashboard dollar formatting", () => {
  it.each([
    [0, "$0.00", "0.00"],
    [1, "$0.00000001", "0.00000001"],
    [15_000_000, "$0.15", "0.15"],
    [150_000_000, "$1.50", "1.50"],
    [123_456_789_000_000, "$1,234,567.89", "1234567.89"],
    ["987654321", "$9.87654321", "9.87654321"],
    [-250_000_000, "-$2.50", "-2.50"],
    [1_000_000_000_000_000, "$10,000,000.00", "10000000.00"],
  ])("formats %j", (value, grouped, plain) => {
    expect(formatDollars(value, true)).toBe(grouped);
    expect(formatDollars(value, false)).toBe(plain);
  });

  it("shows a dash for missing values and passes through non-integers", () => {
    expect(formatDollars(undefined, true)).toBe("—");
    expect(formatDollars(null, true)).toBe("—");
    expect(formatDollars("", true)).toBe("—");
    expect(formatDollars(null, false)).toBe("");
    expect(formatDollars("1.5", true)).toBe("1.5");
  });

  it("round-trips through parsing", () => {
    for (const value of [0, 1, 15_000_000, 123_456_789_012, 999_999_999]) {
      expect(parseDollars(formatDollars(value, true))).toEqual({ value });
      expect(parseDollars(formatDollars(value, false))).toEqual({ value });
    }
  });
});

describe("dashboard CSV cells", () => {
  it.each([
    ["Ada Lovelace", "Ada Lovelace"],
    ["O'Brien, Siobhán", '"O\'Brien, Siobhán"'],
    ['Say "hi"', '"Say ""hi"""'],
    ["line\nbreak", '"line\nbreak"'],
    ["=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"],
    ["+1", "'+1"],
    ["-2", "'-2"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tTabbed", "'\tTabbed"],
    ["=1,2", '"\'=1,2"'],
    [null, ""],
    [42, "42"],
  ])("quotes %j", (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });
});

describe("embedded page helpers", () => {
  it("serves exactly these helper sources under fixed names in the inline script", async () => {
    const html = await dashboardPage().text();
    expect(html).toContain(DASHBOARD_EMBEDDED_HELPERS);
    for (const [name, helper] of [
      ["formatDollars", formatDollars],
      ["parseDollars", parseDollars],
      ["csvCell", csvCell],
    ] as const) {
      expect(html).toContain(`const ${name} = (${String(helper)});`);
    }
    expect(html).not.toContain("__DASHBOARD_HELPERS__");
    // Bundler name-keeping wrappers do not exist in the browser.
    expect(DASHBOARD_EMBEDDED_HELPERS).not.toContain("__name(");
    expect(html).toContain(
      "const money = (value) => formatDollars(value, true);",
    );
  });
});

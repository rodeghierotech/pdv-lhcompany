import { describe, expect, it } from "vitest";
import { formatCents, parseBrazilianMoneyToCents } from "./money";

describe("Brazilian money in integer cents", () => {
  it.each([
    ["189,90", 18990], ["1.234,56", 123456], ["189", 18900],
    ["1.234", 123400], ["0", 0], ["0,01", 1], ["12,5", 1250], [" 12,50 ", 1250],
  ])("parses %s without losing cents", (input, cents) => {
    expect(parseBrazilianMoneyToCents(input)).toBe(cents);
  });

  it.each(["", "-1,00", "1.23", "1,234", "1,234.56", "1.23.456,78", "1e3", "R$ 12,00", "12 34", "1,", "+1", "90071992547410,00"])("rejects invalid or ambiguous input %s", (input) => {
    expect(() => parseBrazilianMoneyToCents(input)).toThrow();
  });

  it.each([[0, "0,00"], [1, "0,01"], [18990, "189,90"], [123456, "1.234,56"], [-123456, "-1.234,56"]])("formats %s integer cents", (cents, formatted) => {
    expect(formatCents(cents)).toBe(formatted);
  });

  it.each([1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("refuses non-integer or unsafe cents %s", (value) => {
    expect(() => formatCents(value)).toThrow();
  });
});

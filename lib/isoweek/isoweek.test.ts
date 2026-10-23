import { describe, expect, it } from "vitest";
import {
  addWeeks,
  compareWeeks,
  isValidWeek,
  mondayOf,
  nextWeek,
  parseWeek,
  prevWeek,
  sundayCloseIST,
  sundayOf,
  weekDiff,
  weekOfDate,
  weekRange,
  weeksInYear,
} from "./index";

describe("UP-09 W52 → W53 → W01", () => {
  it("2026 has 53 ISO weeks; 2027 has 52", () => {
    expect(weeksInYear(2026)).toBe(53);
    expect(weeksInYear(2027)).toBe(52);
    expect(weeksInYear(2020)).toBe(53);
    expect(weeksInYear(2025)).toBe(52);
  });

  it("steps 2026-W52 → 2026-W53 → 2027-W01", () => {
    expect(nextWeek("2026-W52")).toBe("2026-W53");
    expect(nextWeek("2026-W53")).toBe("2027-W01");
    expect(prevWeek("2027-W01")).toBe("2026-W53");
    expect(nextWeek("2027-W52")).toBe("2028-W01");
  });

  it("rejects weeks that do not exist", () => {
    expect(isValidWeek("2026-W53")).toBe(true);
    expect(isValidWeek("2027-W53")).toBe(false);
    expect(isValidWeek("2026-W00")).toBe(false);
    expect(isValidWeek("2026-W5")).toBe(false);
    expect(isValidWeek("2026W05")).toBe(false);
    expect(() => parseWeek("2027-W53")).toThrow(/2027-W53/);
  });

  it("2026-W53 runs Monday 28 Dec 2026 to Sunday 3 Jan 2027", () => {
    expect(mondayOf("2026-W53")).toBe("2026-12-28");
    expect(sundayOf("2026-W53")).toBe("2027-01-03");
    expect(weekOfDate("2027-01-01")).toBe("2026-W53");
    expect(weekOfDate("2027-01-04")).toBe("2027-W01");
  });

  it("counts weeks across the year end", () => {
    expect(weekDiff("2026-W52", "2027-W01")).toBe(2);
    expect(addWeeks("2026-W43", 12)).toBe("2027-W02");
    expect(addWeeks("2027-W02", -12)).toBe("2026-W43");
    expect(weekRange("2026-W52", "2027-W01")).toEqual(["2026-W52", "2026-W53", "2027-W01"]);
  });

  it("orders week labels correctly across years", () => {
    expect(compareWeeks("2026-W53", "2027-W01")).toBeLessThan(0);
    expect(compareWeeks("2026-W09", "2026-W10")).toBeLessThan(0);
    expect(compareWeeks("2026-W10", "2026-W10")).toBe(0);
  });
});

describe("case-data weeks", () => {
  it("2026-W43 starts Monday 19 Oct; its snapshot is Sunday 18 Oct 23:59 IST", () => {
    expect(mondayOf("2026-W43")).toBe("2026-10-19");
    expect(weekOfDate("2026-10-18")).toBe("2026-W42");
    expect(sundayCloseIST("2026-W42")).toBe("2026-10-18T23:59:00+05:30");
  });

  it("week 1 can start in the previous calendar year", () => {
    expect(mondayOf("2026-W01")).toBe("2025-12-29");
    expect(weekOfDate("2025-12-29")).toBe("2026-W01");
  });

  it("rejects malformed dates", () => {
    expect(() => weekOfDate("2026-02-30")).toThrow();
    expect(() => weekOfDate("19/10/2026")).toThrow();
  });
});

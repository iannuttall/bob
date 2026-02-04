import { describe, expect, test } from "bun:test";
import { parseSchedule } from "./schedule";

describe("parseSchedule", () => {
  test("parses recurring interval", () => {
    const parsed = parseSchedule("every 3m");
    expect(parsed).toEqual({ kind: "every", spec: "3m" });
  });

  test("parses daily cron", () => {
    const parsed = parseSchedule("every day at 9am");
    expect(parsed).toEqual({ kind: "cron", spec: "0 9 * * *" });
  });

  test("parses relative duration into ISO", () => {
    const realNow = Date.now;
    const fixed = Date.parse("2026-02-03T10:00:00Z");
    Date.now = () => fixed;
    try {
      const parsed = parseSchedule("1h");
      expect(parsed?.kind).toBe("at");
      expect(parsed?.spec).toBe(new Date(fixed + 60 * 60 * 1000).toISOString());
    } finally {
      Date.now = realNow;
    }
  });
});

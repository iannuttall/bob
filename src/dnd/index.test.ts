import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDndActive } from "./index";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "bob-dnd-"));
}

describe("isDndActive timezone end time", () => {
  test("computes end time in UTC timezone", () => {
    const dataRoot = makeTempDir();
    try {
      const config = { enabled: true, start: "22:00", end: "08:00" };
      const now = new Date(Date.UTC(2026, 1, 3, 23, 0, 0));
      const status = isDndActive(config, dataRoot, "UTC", now);
      expect(status.active).toBe(true);
      expect(status.endsAt?.toISOString()).toBe("2026-02-04T08:00:00.000Z");
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

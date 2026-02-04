import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRecallStore } from "./store";
import { indexAll } from "./index";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "bob-recall-index-"));
}

describe("recall index reindex-on-change", () => {
  test("reindexes when source content changes", async () => {
    const root = makeTempDir();
    const memoryRoot = path.join(root, "memory");
    try {
      mkdirSync(memoryRoot, { recursive: true });
      const userPath = path.join(memoryRoot, "USER.md");

      writeFileSync(userPath, "# USER.md\n\nfirst version\n", "utf-8");
      const store = createRecallStore(root);

      await indexAll(store, memoryRoot);
      let hits = store.getBySource("memory:user");
      expect(hits.some((h) => h.content.includes("first version"))).toBe(true);

      writeFileSync(userPath, "# USER.md\n\nsecond version\n", "utf-8");
      await indexAll(store, memoryRoot);
      hits = store.getBySource("memory:user");

      expect(hits.some((h) => h.content.includes("second version"))).toBe(true);
      expect(hits.some((h) => h.content.includes("first version"))).toBe(false);

      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

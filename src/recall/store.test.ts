import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRecallStore } from "./store";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "bob-recall-"));
}

describe("recall store sqlite-vec integration", () => {
  test("searchVector returns results when vectors_vec exists", () => {
    const root = makeTempDir();
    try {
      const store = createRecallStore(root);
      const chunkId = store.addChunk({
        source: "memory:user",
        title: "User",
        breadcrumbs: ["# USER"],
        content: "hello world",
        preview: "hello world",
        lineStart: 1,
        lineEnd: 1,
        tokenCount: 2,
      });

      const dims = 4;
      const embedding = new Float32Array(dims).fill(0.5);

      // Create vec table and insert a vector directly (qmd two-step pattern)
      store.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS vectors_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${dims}] distance_metric=cosine)`,
      );
      store.db
        .prepare("INSERT OR REPLACE INTO vectors_vec (chunk_id, embedding) VALUES (?, ?)")
        .run(chunkId, embedding);

      const results = store.searchVector(embedding, 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.id).toBe(chunkId);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

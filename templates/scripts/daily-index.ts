#!/usr/bin/env bun
/**
 * Daily memory indexing script.
 * Runs via scheduler, indexes new memory files for FTS search.
 * Fails gracefully if nothing to index yet.
 */

const proc = Bun.spawn(["bun", "bob", "remember", "--index"], {
  stdout: "inherit",
  stderr: "inherit",
});

await proc.exited;

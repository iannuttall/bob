/**
 * Recall module - unified memory and session search.
 */

export { chunkMarkdown, type Chunk } from "./chunk";
export { embed, cosineSimilarity, cleanup as cleanupEmbed } from "./embed";
export { createRecallStore, type RecallStore, type RecallHit } from "./store";
export { search, formatResults, type SearchResult } from "./search";

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { chunkMarkdown } from "./chunk";
import { embed } from "./embed";
import type { RecallStore } from "./store";

/**
 * Index all memory files into recall store.
 *
 * Structure:
 *   memory/USER.md, memory/MEMORY.md - permanent facts
 *   memory/journal/YYYY/MM-DD.md - daily notes from `bob learn`
 *   memory/conversations/YYYY/MM-DD-{engine}.md - conversation logs
 */
export async function indexAll(
  store: RecallStore,
  memoryRoot: string,
  _sessionsRoot?: string, // deprecated, kept for API compat
  options: { embedNow?: boolean; verbose?: boolean } = {},
): Promise<{ memory: number; sessions: number; embedded: number }> {
  let memoryCount = 0;
  let conversationCount = 0;
  let embeddedCount = 0;

  if (existsSync(memoryRoot)) {
    // Index top-level files (USER.md, MEMORY.md)
    memoryCount += await indexTopLevelFiles(store, memoryRoot, options.verbose);

    // Index journal (daily notes from bob learn)
    const journalRoot = path.join(memoryRoot, "journal");
    if (existsSync(journalRoot)) {
      memoryCount += await indexYearDirs(store, journalRoot, "journal", options.verbose);
    }

    // Index conversations (daily chat logs)
    const conversationsRoot = path.join(memoryRoot, "conversations");
    if (existsSync(conversationsRoot)) {
      conversationCount = await indexYearDirs(store, conversationsRoot, "conversation", options.verbose);
    }
  }

  // Embed unembedded chunks if requested
  if (options.embedNow) {
    embeddedCount = await embedUnembedded(store, options.verbose);
  }

  return { memory: memoryCount, sessions: conversationCount, embedded: embeddedCount };
}

async function indexTopLevelFiles(store: RecallStore, memoryRoot: string, verbose?: boolean): Promise<number> {
  let count = 0;

  for (const file of ["USER.md", "MEMORY.md"]) {
    const filePath = path.join(memoryRoot, file);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      const source = `memory:${file.replace(".md", "").toLowerCase()}`;

      const fingerprint = fingerprintContent(content);
      const existingFingerprint = store.getSourceFingerprint(source);
      if (existingFingerprint === fingerprint) continue;
      if (existingFingerprint) {
        store.deleteBySource(source);
      }

      const chunks = chunkMarkdown(content, source);
      store.addChunks(chunks);
      store.setSourceFingerprint(source, fingerprint);
      count += chunks.length;
      if (verbose) console.log(`Indexed ${file}: ${chunks.length} chunks`);
    }
  }

  return count;
}

/**
 * Index year directories under a given root (journal or conversations).
 * Source format: {type}:{year}/{filename}
 *   e.g., journal:2026/02-03, conversation:2026/02-03-claude
 */
async function indexYearDirs(
  store: RecallStore,
  root: string,
  sourceType: "journal" | "conversation",
  verbose?: boolean,
): Promise<number> {
  let count = 0;

  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}$/.test(entry.name)) continue;

    const yearDir = path.join(root, entry.name);
    const files = readdirSync(yearDir).filter((f) => f.endsWith(".md"));

    for (const file of files) {
      const filePath = path.join(yearDir, file);
      const content = readFileSync(filePath, "utf-8");
      const source = `${sourceType}:${entry.name}/${file.replace(".md", "")}`;

      const fingerprint = fingerprintContent(content);
      const existingFingerprint = store.getSourceFingerprint(source);
      if (existingFingerprint === fingerprint) continue;
      if (existingFingerprint) {
        store.deleteBySource(source);
      }

      const chunks = chunkMarkdown(content, source);
      store.addChunks(chunks);
      store.setSourceFingerprint(source, fingerprint);
      count += chunks.length;
      if (verbose) console.log(`Indexed ${sourceType}:${entry.name}/${file}: ${chunks.length} chunks`);
    }
  }

  return count;
}

async function embedUnembedded(store: RecallStore, verbose?: boolean): Promise<number> {
  const batchSize = 100;
  let count = 0;

  for (;;) {
    const unembedded = store.getUnembedded(batchSize);
    if (unembedded.length === 0) {
      break;
    }
    let progressed = false;

    for (const { id, content } of unembedded) {
      try {
        const embedding = await embed(content);
        store.setEmbedding(id, embedding);
        count++;
        progressed = true;
        if (verbose && count % 10 === 0) {
          console.log(`Embedded ${count} chunks`);
        }
      } catch (e) {
        if (verbose) console.error(`Failed to embed chunk ${id}: ${e}`);
      }
    }

    if (!progressed) {
      break;
    }
  }

  return count;
}

/**
 * Get recent context from a session (last N user turns).
 */
export function getRecentContext(
  turns: Array<{ user?: string; assistant?: string; actions: unknown[] }>,
  maxUserTurns = 20,
): Array<{ user?: string; assistant?: string; actions: unknown[] }> {
  const result: typeof turns = [];
  let userCount = 0;

  // Walk backwards
  for (let i = turns.length - 1; i >= 0 && userCount < maxUserTurns; i--) {
    const turn = turns[i];
    if (!turn) continue;
    result.unshift(turn);
    if (turn.user) userCount++;
  }

  return result;
}

function fingerprintContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

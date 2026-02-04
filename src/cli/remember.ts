/**
 * bob remember "query" [--source <id>] [--full <id>]
 *
 * Unified search across memory and sessions.
 */

import { loadConfig } from "../config/load";
import { createRecallStore, search, formatResults, indexAll } from "../recall";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export async function remember(args: string[]): Promise<void> {
  if (args[0] === "help" || args[0] === "--help" || args.length === 0) {
    console.log(`Usage: bob remember <query> [options]

Search your memory and past sessions.

Commands:
  bob remember "query"            Search all memory and sessions
  bob remember "query" <id>       Search within a specific session/memory
  bob remember --full <id>        Show full content of a session/memory
  bob remember --index            Index new files only
  bob remember --index --force    Clear and rebuild entire index
  bob remember --index --embed    Also generate embeddings

Examples:
  bob remember "weather location"
  bob remember "auth decision" session:abc123
  bob remember --full session:abc123
  bob remember --full memory:user

Note: Agent can also use grep/rg for simple text searches in memory files.
`);
    return;
  }

  const config = await loadConfig();
  const store = createRecallStore(config.paths.dataRoot);

  try {
    // Handle --index
    if (args[0] === "--index") {
      const embedNow = args.includes("--embed");
      const force = args.includes("--force");

      if (force) {
        console.log("Clearing index...");
        store.clear();
      }

      console.log("Indexing files...");
      const stats = await indexAll(store, config.paths.memoryRoot, config.paths.sessionsRoot, {
        embedNow,
        verbose: true,
      });
      console.log(`\nIndexed: ${stats.memory} memory chunks, ${stats.sessions} session chunks`);
      if (embedNow) {
        console.log(`Embedded: ${stats.embedded} chunks`);
      }
      return;
    }

    // Handle --full <id>
    if (args[0] === "--full") {
      const sourceId = args[1];
      if (!sourceId) {
        throw new Error("Usage: bob remember --full <source_id>");
      }
      await showFull(config, sourceId);
      return;
    }

    // Search
    const query = args[0] ?? "";
    const sourceFilter = args[1]; // Optional source filter

    const results = await search(store, query, {
      limit: 10,
      source: sourceFilter,
    });

    if (results.length === 0) {
      console.log("No matches found.");
      console.log("\nTip: Try `bob remember --index` to ensure all files are indexed.");
      return;
    }

    console.log(formatResults(results));

    // Show hint for full content
    const firstResult = results[0];
    if (firstResult) {
      console.log(`\nTo see full content: bob remember --full ${firstResult.source}`);
    }
  } finally {
    store.close();
  }
}

async function showFull(
  config: { paths: { memoryRoot: string; sessionsRoot: string } },
  sourceId: string,
): Promise<void> {
  let filePath: string;

  if (sourceId.startsWith("memory:")) {
    const id = sourceId.replace("memory:", "");
    if (id === "user") {
      filePath = path.join(config.paths.memoryRoot, "USER.md");
    } else if (id === "memory") {
      filePath = path.join(config.paths.memoryRoot, "MEMORY.md");
    } else {
      filePath = path.join(config.paths.memoryRoot, `${id}.md`);
    }
  } else if (sourceId.startsWith("journal:")) {
    // journal:2026/02-03
    const id = sourceId.replace("journal:", "");
    filePath = path.join(config.paths.memoryRoot, "journal", `${id}.md`);
  } else if (sourceId.startsWith("conversation:")) {
    // conversation:2026/02-03-claude
    const id = sourceId.replace("conversation:", "");
    filePath = path.join(config.paths.memoryRoot, "conversations", `${id}.md`);
  } else {
    // Try to guess - check multiple locations
    const candidates = [
      path.join(config.paths.memoryRoot, `${sourceId}.md`),
      path.join(config.paths.memoryRoot, "journal", `${sourceId}.md`),
      path.join(config.paths.memoryRoot, "conversations", `${sourceId}.md`),
    ];
    const fallback = candidates[0];
    if (!fallback) {
      throw new Error("No file candidates available.");
    }
    filePath = candidates.find((p) => existsSync(p)) ?? fallback;
  }

  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    console.error("\nSource types:");
    console.error("  memory:user, memory:memory - permanent facts");
    console.error("  journal:2026/02-03 - daily notes");
    console.error("  conversation:2026/02-03-claude - conversation logs");
    return;
  }

  const content = readFileSync(filePath, "utf-8");
  console.log(content);
}

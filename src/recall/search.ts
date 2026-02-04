/**
 * Hybrid search - combines FTS and vector search using RRF fusion.
 */

import type { RecallHit, RecallStore } from "./store";
import { embed } from "./embed";

export type SearchResult = RecallHit & {
  matchType: "fts" | "vector" | "hybrid";
};

/**
 * Search using hybrid FTS + vector approach.
 * - FTS for keyword matching (works on today's data)
 * - Vector for semantic matching (works on embedded data)
 * - RRF fusion to combine results
 */
export async function search(
  store: RecallStore,
  query: string,
  options: { limit?: number; source?: string } = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;

  // If searching within a specific source, filter by source
  if (options.source) {
    const chunks = store.getBySource(options.source);
    // Simple text search within source
    const queryLower = query.toLowerCase();
    const matches = chunks.filter(
      (c) =>
        c.content.toLowerCase().includes(queryLower) ||
        c.title.toLowerCase().includes(queryLower),
    );
    return matches.slice(0, limit).map((h) => ({ ...h, matchType: "fts" as const }));
  }

  // Get FTS results
  let ftsResults: RecallHit[] = [];
  try {
    // Clean query for FTS5 (escape special characters)
    const ftsQuery = query.replace(/[^\w\s]/g, " ").trim();
    if (ftsQuery) {
      ftsResults = store.searchFts(ftsQuery, limit * 2);
    }
  } catch {
    // FTS can fail on malformed queries
  }

  // Get vector results if we have embeddings
  let vecResults: RecallHit[] = [];
  try {
    const queryEmbedding = await embed(query);
    vecResults = store.searchVector(queryEmbedding, limit * 2);
  } catch {
    // Embedding can fail if model not available
  }

  // If only one type of results, return those
  if (ftsResults.length === 0 && vecResults.length === 0) {
    return [];
  }
  if (ftsResults.length === 0) {
    return vecResults.slice(0, limit).map((h) => ({ ...h, matchType: "vector" as const }));
  }
  if (vecResults.length === 0) {
    return ftsResults.slice(0, limit).map((h) => ({ ...h, matchType: "fts" as const }));
  }

  // RRF fusion
  const k = 60;
  const scores = new Map<number, { hit: RecallHit; score: number; types: Set<string> }>();

  for (const [i, hit] of ftsResults.entries()) {
    const rrf = 1 / (k + i + 1);
    const existing = scores.get(hit.id);
    if (existing) {
      existing.score += rrf;
      existing.types.add("fts");
    } else {
      scores.set(hit.id, { hit, score: rrf, types: new Set(["fts"]) });
    }
  }

  for (const [i, hit] of vecResults.entries()) {
    const rrf = 1 / (k + i + 1);
    const existing = scores.get(hit.id);
    if (existing) {
      existing.score += rrf;
      existing.types.add("vector");
    } else {
      scores.set(hit.id, { hit, score: rrf, types: new Set(["vector"]) });
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({
      ...entry.hit,
      score: entry.score,
      matchType:
        entry.types.size > 1 ? ("hybrid" as const) : (entry.types.values().next().value as "fts" | "vector"),
    }));
}

/**
 * Format search results for display.
 */
export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No matches found.";
  }

  const lines: string[] = [];
  for (const result of results) {
    // Format breadcrumbs: "# USER.md > ## preferences > ### editor"
    const path = result.breadcrumbs.length > 0
      ? result.breadcrumbs.map((h) => h.replace(/^#+\s*/, "")).join(" > ")
      : result.title;

    const matchTag = result.matchType === "hybrid" ? "[H]" : result.matchType === "vector" ? "[V]" : "[F]";
    lines.push(`${matchTag} [${result.source}] ${path}`);
    lines.push(result.preview);
    lines.push("");
  }

  return lines.join("\n").trim();
}

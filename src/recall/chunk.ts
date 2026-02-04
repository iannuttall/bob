/**
 * Simple markdown chunking for memory and sessions.
 * Tracks heading hierarchy as breadcrumbs.
 */

export type Chunk = {
  content: string;
  source: string; // 'session:abc123' or 'memory:2026/02-03'
  title: string;
  breadcrumbs: string[]; // ["# USER.md", "## preferences", "### editor"]
  preview: string;
  lineStart: number;
  lineEnd: number;
  tokenCount: number;
};

const MAX_TOKENS = 500;
const MIN_TOKENS = 50;
const OVERLAP_TOKENS = 40;

function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildPreview(text: string, limit = 200): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit - 3)}...`;
}

/**
 * Chunk markdown content by headings, tracking hierarchy as breadcrumbs.
 */
export function chunkMarkdown(content: string, source: string): Chunk[] {
  const lines = content.split("\n");
  const sections = splitByHeadingsWithBreadcrumbs(lines);

  if (sections.length > 0) {
    return sections.flatMap((section) =>
      enforceTokenLimit(
        section.content,
        source,
        section.title,
        section.breadcrumbs,
        section.start,
        section.end
      )
    );
  }

  // Fallback: chunk by size (no headings found)
  return enforceTokenLimit(content, source, source, [source], 1, lines.length);
}

type Section = {
  title: string;
  breadcrumbs: string[];
  content: string;
  start: number;
  end: number;
};

/**
 * Split markdown by headings while tracking the heading hierarchy.
 * Maintains a stack of headings at each level (h1, h2, h3, etc.)
 */
function splitByHeadingsWithBreadcrumbs(lines: string[]): Section[] {
  const sections: Section[] = [];

  // Stack of headings by level: headingStack[0] = h1, headingStack[1] = h2, etc.
  const headingStack: string[] = [];
  let current: Section | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = line.match(/^(#{1,6})\s+(.+)$/);

    if (match) {
      // Finish previous section
      if (current) {
        current.end = i;
        current.content = lines.slice(current.start - 1, current.end).join("\n");
        if (current.content.trim()) sections.push(current);
      }

      const level = match[1]?.length ?? 0; // 1 for #, 2 for ##, etc.
      const headingText = line.trim();
      if (!level) continue;

      // Update heading stack: clear everything at this level and below
      headingStack.length = level - 1;
      headingStack[level - 1] = headingText;

      // Build breadcrumbs from stack (filter out undefined entries)
      const breadcrumbs = headingStack.filter(Boolean);

      current = {
        title: (match[2] ?? "").trim(),
        breadcrumbs: [...breadcrumbs],
        content: "",
        start: i + 1,
        end: lines.length,
      };
    }
  }

  // Finish last section
  if (current) {
    current.content = lines.slice(current.start - 1).join("\n");
    if (current.content.trim()) sections.push(current);
  }

  return sections;
}

function enforceTokenLimit(
  content: string,
  source: string,
  title: string,
  breadcrumbs: string[],
  startLine: number,
  endLine: number,
): Chunk[] {
  const text = content.trim();
  if (!text) return [];

  const tokens = approxTokens(text);
  if (tokens <= MAX_TOKENS) {
    return [{
      content: text,
      source,
      title,
      breadcrumbs,
      preview: buildPreview(text),
      lineStart: startLine,
      lineEnd: endLine,
      tokenCount: tokens,
    }];
  }

  // Split into smaller chunks with overlap
  const chunks: Chunk[] = [];
  const lines = text.split("\n");
  let current: string[] = [];
  let chunkStart = startLine;
  let chunkIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    current.push(lines[i] ?? "");
    const currentTokens = approxTokens(current.join("\n"));

    if (currentTokens >= MAX_TOKENS) {
      const chunkText = current.join("\n").trim();
      if (approxTokens(chunkText) >= MIN_TOKENS) {
        chunkIndex++;
        chunks.push({
          content: chunkText,
          source,
          title: chunkIndex > 1 ? `${title} (cont.)` : title,
          breadcrumbs,
          preview: buildPreview(chunkText),
          lineStart: chunkStart,
          lineEnd: startLine + i,
          tokenCount: approxTokens(chunkText),
        });
      }

      // Keep overlap
      const overlap = takeOverlapLines(current, OVERLAP_TOKENS);
      current = overlap;
      chunkStart = startLine + i - overlap.length + 1;
    }
  }

  // Remaining content
  if (current.length > 0) {
    const chunkText = current.join("\n").trim();
    if (approxTokens(chunkText) >= MIN_TOKENS) {
      chunkIndex++;
      chunks.push({
        content: chunkText,
        source,
        title: chunkIndex > 1 ? `${title} (cont.)` : title,
        breadcrumbs,
        preview: buildPreview(chunkText),
        lineStart: chunkStart,
        lineEnd: endLine,
        tokenCount: approxTokens(chunkText),
      });
    }
  }

  return chunks;
}

function takeOverlapLines(lines: string[], overlapTokens: number): string[] {
  const overlap: string[] = [];
  let tokens = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    overlap.unshift(line);
    tokens += approxTokens(line);
    if (tokens >= overlapTokens) break;
  }
  return overlap;
}

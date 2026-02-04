import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/load";

/**
 * bob learn "important fact"
 * bob learn --user "user fact"
 * bob learn --pinned "evergreen fact"
 * bob learn today
 */
export async function learn(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    console.log(`Usage: bob learn [options] <text>

Save something to memory.

Options:
  --user      Add to USER.md (permanent user facts)
  --pinned    Add to MEMORY.md (evergreen memories)
  (default)   Add to today's log (transient notes)

Commands:
  today       Show today's memory log

Examples:
  bob learn "discussed auth options today"
  bob learn --user "User's name is Ian"
  bob learn --pinned "DECISION: use sqlite for storage"
  bob learn today
`);
    return;
  }

  const config = await loadConfig();
  const memoryRoot = config.paths.memoryRoot;

  // Handle "today" command
  if (args[0] === "today") {
    const today = new Date();
    const year = today.getFullYear().toString();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    const dailyPath = path.join(memoryRoot, "journal", year, `${month}-${day}.md`);

    if (!existsSync(dailyPath)) {
      console.log("No entries for today.");
      return;
    }

    const content = readFileSync(dailyPath, "utf-8");
    console.log(content);
    return;
  }

  // Parse flags and text
  const isUser = args.includes("--user");
  const isPinned = args.includes("--pinned");
  const textArgs = args.filter((a) => a !== "--pinned" && a !== "--user");
  const text = textArgs.join(" ").trim();

  if (!text) {
    throw new Error("Usage: bob learn [--user|--pinned] <text>");
  }

  if (isUser) {
    const userPath = path.join(memoryRoot, "USER.md");
    ensureMemoryFile(userPath, "# USER.md\n\nPermanent facts about the user.\n\n");
    const entry = formatEntry(text);
    appendFileSync(userPath, entry);
    console.log(`Added to USER.md`);
  } else if (isPinned) {
    const pinnedPath = path.join(memoryRoot, "MEMORY.md");
    ensureMemoryFile(pinnedPath, "# MEMORY.md\n\nCurated long-term memory.\n\n");
    const entry = formatEntry(text);
    appendFileSync(pinnedPath, entry);
    console.log(`Added to MEMORY.md`);
  } else {
    const today = new Date();
    const year = today.getFullYear().toString();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");

    const journalDir = path.join(memoryRoot, "journal", year);
    mkdirSync(journalDir, { recursive: true });

    const dailyPath = path.join(journalDir, `${month}-${day}.md`);
    ensureMemoryFile(dailyPath, `# ${year}-${month}-${day}\n\n`);

    const entry = formatEntry(text);
    appendFileSync(dailyPath, entry);
    console.log(`Added to today's journal`);
  }
}

function formatEntry(text: string): string {
  const time = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `- [${time}] ${text}\n`;
}

function ensureMemoryFile(filePath: string, defaultContent: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(filePath)) {
    appendFileSync(filePath, defaultContent);
  }
}

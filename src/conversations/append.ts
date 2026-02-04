/**
 * Append conversation turns to daily conversation files.
 *
 * Structure: ~/.bob/memory/conversations/{year}/{MM-DD}-{engine}.md
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Action } from "./parse";
import { formatActionCompact } from "./format";

export type ConversationTurn = {
  userText: string;
  assistantText: string;
  actions?: Action[];
  timestamp?: Date;
};

/**
 * Append a conversation turn to today's conversation file.
 */
export function appendConversation(
  memoryRoot: string,
  engine: "claude" | "codex",
  turn: ConversationTurn,
): void {
  const now = turn.timestamp ?? new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  const conversationsDir = path.join(memoryRoot, "conversations", year);
  mkdirSync(conversationsDir, { recursive: true });

  const filePath = path.join(conversationsDir, `${month}-${day}-${engine}.md`);

  // Create file with header if new
  if (!existsSync(filePath)) {
    const header = `# ${year}-${month}-${day} ${engine}\n\n`;
    appendFileSync(filePath, header, "utf-8");
  }

  // Format the turn
  const time = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const lines: string[] = [];
  lines.push("---");
  lines.push("");
  lines.push(`[user] ${year}-${month}-${day} ${time}`);
  lines.push(turn.userText);
  lines.push("");

  // Add tool calls if any - using shared formatter
  if (turn.actions && turn.actions.length > 0) {
    if (turn.actions.length === 1) {
      const firstAction = turn.actions[0];
      if (firstAction) {
        lines.push(`[tool] ${formatActionCompact(firstAction)}`);
      }
    } else {
      lines.push("[tools]");
      for (const action of turn.actions) {
        lines.push(`- ${formatActionCompact(action)}`);
      }
    }
    lines.push("");
  }

  lines.push(`[bob] ${year}-${month}-${day} ${time}`);
  lines.push(turn.assistantText);
  lines.push("");

  appendFileSync(filePath, lines.join("\n"), "utf-8");
}

/**
 * Get recent turns from today's conversation file.
 * Returns the last N turns for context injection.
 */
export function getRecentConversation(
  memoryRoot: string,
  engine: "claude" | "codex",
  limit: number = 20,
): string | null {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  const filePath = path.join(
    memoryRoot,
    "conversations",
    year,
    `${month}-${day}-${engine}.md`,
  );

  if (!existsSync(filePath)) {
    return null;
  }

  const content = readFileSync(filePath, "utf-8");

  // Split by turn separator and take last N
  const turns = content.split(/^---$/m).filter((t) => t.trim());
  const recentTurns = turns.slice(-limit);

  if (recentTurns.length === 0) {
    return null;
  }

  return recentTurns.join("\n---\n");
}

/**
 * Get the path to today's conversation file.
 */
export function getTodayConversationPath(
  memoryRoot: string,
  engine: "claude" | "codex",
): string {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return path.join(
    memoryRoot,
    "conversations",
    year,
    `${month}-${day}-${engine}.md`,
  );
}

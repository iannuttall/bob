import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export type PromptParts = {
  soulContent: string | null;
  skillsBlock?: string | null;
  userBlock: string | null;
  memoryBlock: string | null;
  contextBlock: string | null;
  userText: string;
  chatId?: number;
  messageId?: number;
  locale?: string;
  timezone?: string;
  versionNotice?: string | null;
};

export type MemoryBlocks = {
  userBlock: string | null;
  memoryBlock: string | null;
};

export type PromptBuildConfig = {
  globalRoot: string;
  memoryRoot: string;
  skillsRoot?: string;
  userText: string;
  contextBlock: string | null;
  chatId?: number;
  messageId?: number;
  locale?: string;
  timezone?: string;
  versionNotice?: string | null;
  memoryOverride?: string | null;
};

/**
 * Load SOUL.md from the global ~/.bob directory.
 */
export function loadSoulFile(globalRoot: string): string | null {
  const agentsPath = path.join(globalRoot, "SOUL.md");
  return readFileIfExists(agentsPath);
}

/**
 * Load skill names from skills directory.
 * Returns a simple list - full details are provided by agent SDKs.
 */
export function loadSkillsBlock(skillsRoot: string): string | null {
  if (!existsSync(skillsRoot)) return null;

  const skillNames: string[] = [];

  try {
    const dirs = readdirSync(skillsRoot, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const skillPath = path.join(skillsRoot, dir.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;

      const content = readFileSync(skillPath, "utf-8");
      const frontmatter = parseFrontmatter(content);
      if (frontmatter.name) {
        skillNames.push(frontmatter.name);
      }
    }
  } catch {
    return null;
  }

  if (skillNames.length === 0) return null;

  const lines = [
    "## your skills (in ~/.bob/skills/)",
    "",
    "these are YOUR bob-specific skills. use `bun bob <skill>` to run them. do NOT confuse these with claude code skills:",
    "",
  ];
  for (const name of skillNames) {
    lines.push(`- ${name}`);
  }
  return lines.join("\n");
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return {};

  const result: Record<string, string> = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    result[key] = value;
  }
  return result;
}

/**
 * Load memory blocks from the memory directory.
 */
export function loadMemoryBlocks(memoryRoot: string): MemoryBlocks {
  const userPath = path.join(memoryRoot, "USER.md");
  const memoryPath = path.join(memoryRoot, "MEMORY.md");

  const userContent = readFileIfExists(userPath);
  const memoryContent = readFileIfExists(memoryPath);

  return {
    userBlock: userContent ? `USER:\n${userContent}` : null,
    memoryBlock: memoryContent ? `MEMORY:\n${memoryContent}` : null,
  };
}

/**
 * Build prompt from filesystem context (SOUL, skills, memory).
 * Centralizes prompt assembly to avoid drift across call sites.
 */
export function buildPromptFromConfig(config: PromptBuildConfig): string {
  const soulContent = loadSoulFile(config.globalRoot);
  const skillsBlock = config.skillsRoot ? loadSkillsBlock(config.skillsRoot) : null;
  const memoryBlocks = loadMemoryBlocks(config.memoryRoot);
  const memoryBlock = config.memoryOverride ?? memoryBlocks.memoryBlock;

  return buildPrompt({
    soulContent,
    skillsBlock,
    userBlock: memoryBlocks.userBlock,
    memoryBlock,
    contextBlock: config.contextBlock,
    userText: config.userText,
    chatId: config.chatId,
    messageId: config.messageId,
    locale: config.locale,
    timezone: config.timezone,
    versionNotice: config.versionNotice,
  });
}

/**
 * Build the full prompt from parts.
 */
export function buildPrompt(parts: PromptParts): string {
  const chunks: string[] = [];

  // Add SOUL.md content as system context
  if (parts.soulContent) {
    chunks.push(parts.soulContent);
  }

  // Add skills list
  if (parts.skillsBlock) {
    chunks.push(parts.skillsBlock);
  }

  // Add current session context (time, chat ID for scheduling, etc.)
  const locale = parts.locale ?? Intl.DateTimeFormat().resolvedOptions().locale;
  const timezone = parts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const timeStr = now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone: timezone });
  const dateStr = now.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: timezone });
  const sessionLines = [
    `CURRENT SESSION:`,
    `- current_time: ${timeStr}`,
    `- current_date: ${dateStr}`,
  ];
  if (parts.chatId) {
    sessionLines.push(`- chat_id: ${parts.chatId}`);
  }
  if (parts.messageId) {
    sessionLines.push(`- message_id: ${parts.messageId}`);
  }
  if (parts.chatId || parts.messageId) {
    sessionLines.push(`- for scheduling: use --chat-id ${parts.chatId ?? "<id>"}${parts.messageId ? `, optionally --quote "..." --reply-to ${parts.messageId} for follow-ups` : ""}`);
  }
  if (parts.versionNotice) {
    sessionLines.push(`- ${parts.versionNotice}`);
  }
  chunks.push(sessionLines.join("\n"));

  // Add user profile
  if (parts.userBlock) {
    chunks.push(parts.userBlock);
  }

  // Add memory
  if (parts.memoryBlock) {
    chunks.push(parts.memoryBlock);
  }

  // Add conversation context
  if (parts.contextBlock) {
    chunks.push(parts.contextBlock);
  }

  // Guardrail: prefer clarification over exploration
  chunks.push("IMPORTANT: if the user's message is unclear or vague, ask them for details before taking action. do not launch into tool use or file exploration without a clear task.");

  // Add the user's message
  chunks.push(`User: ${parts.userText}`);

  return chunks.join("\n\n");
}

function readFileIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    return raw ? raw : null;
  } catch {
    return null;
  }
}

// Keep old exports for backwards compatibility during migration
export const DEFAULT_SYSTEM_PROMPT = "";

export function loadSoulBlock(_repoRoot: string): string | null {
  return null;
}

export function loadGuidanceBlocks(_params: {
  repoRoot: string;
  globalRoot?: string;
}): { userBlock: string | null; toolsBlock: string | null; longMemoryBlock: string | null } {
  return { userBlock: null, toolsBlock: null, longMemoryBlock: null };
}

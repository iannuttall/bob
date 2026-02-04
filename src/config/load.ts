import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import type { EngineId, ProjectConfig, RawConfig, ResolvedConfig } from "./types";

const DEFAULT_ENGINE: EngineId = "claude";
const GLOBAL_ROOT = ".bob";
const CONFIG_FILE = "config.toml";

export type LoadConfigOptions = {
  env?: Record<string, string | undefined>;
  homedir?: string;
};

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? osHomedir();
  const globalRoot = path.join(homedir, GLOBAL_ROOT);
  const configPath = path.join(globalRoot, CONFIG_FILE);

  const rawConfig = await readTomlIfExists(configPath);
  const envConfig = await readEnvIfExists(path.join(globalRoot, ".env"));
  const mergedEnv = { ...envConfig, ...env };

  const engine = resolveEngine(mergedEnv, rawConfig);
  // Auto-detect system locale and timezone if not configured
  const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = resolveLocale(rawConfig?.locale, systemLocale);
  const timezone = resolveTimeZone(rawConfig?.timezone, systemTimezone);
  const telegram = resolveTelegram(mergedEnv, rawConfig);
  const engines = resolveEngines(rawConfig);
  const heartbeat = resolveHeartbeat(rawConfig);
  const dnd = resolveDnd(rawConfig);
  const projects = resolveProjects(rawConfig, homedir);

  const dataRoot = path.join(globalRoot, "data");
  await ensureDir(dataRoot);
  await ensureDir(path.join(globalRoot, "logs"));

  return {
    engine,
    locale,
    timezone,
    globalRoot,
    dataRoot,
    telegram,
    engines,
    heartbeat,
    dnd,
    projects,
    paths: {
      configPath,
      sessionsPath: path.join(globalRoot, "sessions.json"),
      memoryRoot: path.join(globalRoot, "memory"),
      sessionsRoot: path.join(globalRoot, "sessions"),
      skillsRoot: path.join(globalRoot, "skills"),
      logsRoot: path.join(globalRoot, "logs"),
      scriptsRoot: path.join(globalRoot, "scripts"),
      dataRoot,
    },
  };
}

function resolveEngine(
  env: Record<string, string | undefined>,
  config: RawConfig | null,
): EngineId {
  const raw = env.BOB_ENGINE ?? config?.default_engine ?? DEFAULT_ENGINE;
  if (!isValidEngine(raw)) {
    console.warn(`Invalid engine "${raw}", using "${DEFAULT_ENGINE}"`);
    return DEFAULT_ENGINE;
  }
  return raw;
}

function isValidEngine(engine: string | undefined): engine is EngineId {
  return engine === "claude" || engine === "codex" || engine === "opencode" || engine === "pi";
}

function resolveTelegram(
  env: Record<string, string | undefined>,
  config: RawConfig | null,
) {
  const allowlistRaw = config?.telegram?.allowlist ?? [];
  const allowlist = allowlistRaw
    .map((id) => (typeof id === "string" ? Number(id) : id))
    .filter((id): id is number => Number.isFinite(id));

  return {
    token: env.BOB_TELEGRAM_TOKEN ?? config?.telegram?.token,
    allowlist,
    ackReaction: config?.telegram?.ack_reaction?.trim() || undefined,
    queueMessages: config?.telegram?.queue_messages ?? true,
    showCancelButton: config?.telegram?.show_cancel_button ?? true,
  };
}

function resolveEngines(config: RawConfig | null) {
  return {
    claude: {
      skipPermissions: config?.engines?.claude?.skip_permissions ?? true,
    },
    codex: {
      yolo: config?.engines?.codex?.yolo ?? true,
    },
    opencode: config?.engines?.opencode ?? {},
    pi: config?.engines?.pi ?? {},
  };
}

function resolveHeartbeat(config: RawConfig | null) {
  return {
    enabled: config?.heartbeat?.enabled ?? true,
    prompt: config?.heartbeat?.prompt,
    file: config?.heartbeat?.file,
  };
}

function resolveDnd(config: RawConfig | null) {
  return {
    enabled: config?.dnd?.enabled ?? false,
    start: config?.dnd?.start ?? "22:00",
    end: config?.dnd?.end ?? "08:00",
  };
}

function resolveProjects(
  config: RawConfig | null,
  homedir: string,
): Map<string, ProjectConfig> {
  const projects = new Map<string, ProjectConfig>();

  if (!config?.projects) {
    return projects;
  }

  for (const [alias, raw] of Object.entries(config.projects)) {
    if (!raw.path) {
      console.warn(`Project "${alias}" missing path, skipping`);
      continue;
    }

    const projectPath = expandHome(raw.path, homedir);
    if (!existsSync(projectPath)) {
      console.warn(`Project "${alias}" path "${projectPath}" does not exist, skipping`);
      continue;
    }

    const worktreesRootRaw = raw.worktrees_root ?? ".worktrees";
    const expandedWorktreesRoot = expandHome(worktreesRootRaw, homedir);
    const worktreesRoot = path.isAbsolute(expandedWorktreesRoot)
      ? expandedWorktreesRoot
      : path.join(projectPath, expandedWorktreesRoot);

    projects.set(alias, {
      alias,
      path: projectPath,
      worktreesRoot,
      defaultBranch: raw.default_branch ?? "main",
      defaultEngine: isValidEngine(raw.default_engine) ? raw.default_engine : undefined,
    });
  }

  return projects;
}

function expandHome(input: string, homedir: string) {
  if (input.startsWith("~/")) {
    return path.join(homedir, input.slice(2));
  }
  return input;
}

function resolveLocale(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  try {
    new Intl.DateTimeFormat(input);
    return input;
  } catch {
    console.warn(`Invalid locale "${input}", using "${fallback}"`);
    return fallback;
  }
}

function resolveTimeZone(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input });
    return input;
  } catch {
    console.warn(`Invalid timezone "${input}", using "${fallback}"`);
    return fallback;
  }
}

async function readTomlIfExists(configPath: string): Promise<RawConfig | null> {
  try {
    const contents = await readFile(configPath, "utf-8");
    return Bun.TOML.parse(contents) as RawConfig;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") {
        return null;
      }
    }
    throw new Error(`Failed to read config at ${configPath}`);
  }
}

async function readEnvIfExists(envPath: string): Promise<Record<string, string>> {
  try {
    const contents = await readFile(envPath, "utf-8");
    return parseEnv(contents);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") {
        return {};
      }
    }
    throw new Error(`Failed to read env at ${envPath}`);
  }
}

function parseEnv(contents: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function ensureDir(dir: string) {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // Best-effort
  }
}

/**
 * Get the chat ID from environment or throw an error.
 * Used by CLI commands that need to know which chat to operate on.
 */
export function getChatIdFromEnv(): number {
  const chatIdRaw = process.env.BOB_CHAT_ID;
  if (!chatIdRaw) {
    throw new Error(
      "No chat ID found. Run this from a bob context or specify BOB_CHAT_ID environment variable.",
    );
  }
  const chatId = Number(chatIdRaw);
  if (!Number.isFinite(chatId)) {
    throw new Error(`Invalid BOB_CHAT_ID: ${chatIdRaw}`);
  }
  return chatId;
}

/**
 * Get the optional thread ID from environment.
 */
export function getThreadIdFromEnv(): number | null {
  const threadIdRaw = process.env.BOB_THREAD_ID;
  if (!threadIdRaw) {
    return null;
  }
  const threadId = Number(threadIdRaw);
  if (!Number.isFinite(threadId)) {
    return null;
  }
  return threadId;
}

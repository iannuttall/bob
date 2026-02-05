import {
  existsSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createJobStore } from "../scheduler/store";
import { confirm, text, isCancel, note, password, spinner } from "@clack/prompts";

const BOB_ROOT = path.join(homedir(), ".bob");
const DATA_ROOT = path.join(BOB_ROOT, "data");

/**
 * bob setup - create initial config and directories from templates
 */
export async function setup(args: string[]): Promise<void> {
  const fromStart = args.includes("--from-start");
  // Find templates directory (relative to this file when running from source)
  const templatesRoot = path.resolve(import.meta.dir, "../../templates");

  if (!existsSync(templatesRoot)) {
    console.error("templates directory not found");
    process.exit(1);
  }

  console.log("\nbob setup\n");

  // Create directories
  const dirs = ["data", "logs", "memory", "scripts", "skills"];
  for (const dir of dirs) {
    const dirPath = path.join(BOB_ROOT, dir);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
      console.log(`  created ${dir}/`);
    }
  }

  // Copy config.toml if missing
  const configDest = path.join(BOB_ROOT, "config.toml");
  if (!existsSync(configDest)) {
    copyFileSync(path.join(templatesRoot, "config.toml"), configDest);
    console.log("  created config.toml");
  }

  // Copy SOUL.md if missing
  const soulDest = path.join(BOB_ROOT, "SOUL.md");
  if (!existsSync(soulDest)) {
    copyFileSync(path.join(templatesRoot, "SOUL.md"), soulDest);
    console.log("  created SOUL.md");
  }

  // Copy memory templates if missing
  const userDest = path.join(BOB_ROOT, "memory", "USER.md");
  if (!existsSync(userDest)) {
    copyFileSync(path.join(templatesRoot, "USER.md"), userDest);
    console.log("  created memory/USER.md");
  }

  const memoryDest = path.join(BOB_ROOT, "memory", "MEMORY.md");
  if (!existsSync(memoryDest)) {
    copyFileSync(path.join(templatesRoot, "MEMORY.md"), memoryDest);
    console.log("  created memory/MEMORY.md");
  }

  // Copy skills if missing
  const skillsDest = path.join(BOB_ROOT, "skills");
  const skillsSrc = path.join(templatesRoot, "skills");
  if (existsSync(skillsSrc)) {
    cpSync(skillsSrc, skillsDest, { recursive: true, force: false });
    console.log("  created skills/");
  }

  // Copy scripts
  const scriptsSrc = path.join(templatesRoot, "scripts");
  const scriptsDest = path.join(BOB_ROOT, "scripts");
  if (existsSync(scriptsSrc)) {
    cpSync(scriptsSrc, scriptsDest, { recursive: true, force: false });
    console.log("  copied scripts/");
  }

  // Lock down permissions (owner-only)
  securePermissions(BOB_ROOT);

  // Pairing flow (optional)
  const didPair = await maybePairTelegram(configDest);

  // Schedule daily indexing job (system job with chatId=0, no notifications)
  try {
    const store = createJobStore({ dataRoot: DATA_ROOT });
    try {
      // Check if already exists
      const jobs = store.listJobs();
      const hasIndexJob = jobs.some(
        (j) => j.jobType === "script" && (j.payload as { script?: string }).script === "daily-index.ts",
      );
      if (!hasIndexJob) {
        store.addJob({
          chatId: 0, // System job - no chat target
          scheduleKind: "cron",
          scheduleSpec: "0 3 * * *", // 3am daily
          jobType: "script",
          payload: { script: "daily-index.ts", notify: false },
        });
        console.log("  scheduled daily indexing (3am)");
      }
    } finally {
      store.close();
    }
  } catch {
    // Non-fatal - job can be added later
  }

  console.log("\nsetup complete.\n");
  if (!fromStart) {
    console.log("next steps:");
    if (!didPair.tokenPresent) {
      console.log("  1. add your telegram bot token to ~/.bob/config.toml");
    } else {
      console.log("  1. verify your telegram bot token in ~/.bob/config.toml");
    }
    if (!didPair.allowlistPresent) {
      console.log("  2. add your telegram user id to the allowlist (or re-run setup to pair)");
    } else {
      console.log("  2. verify your allowlist in ~/.bob/config.toml");
    }
    console.log("  3. run: bob start\n");
  } else {
    console.log("continuing to start...\n");
  }
}

type PairingStatus = {
  tokenPresent: boolean;
  allowlistPresent: boolean;
};

type TomlConfig = {
  telegram?: {
    token?: string;
    allowlist?: Array<string | number>;
  };
};

async function maybePairTelegram(configPath: string): Promise<PairingStatus> {
  const initial = readTomlConfig(configPath);
  const initialToken = initial?.telegram?.token;
  const initialAllowlist = normalizeAllowlist(initial?.telegram?.allowlist);

  const wantsPair = await confirm({
    message: "Pair this bot now and add your Telegram user ID to the allowlist?",
    initialValue: true,
  });
  if (isCancel(wantsPair) || !wantsPair) {
    if (initialAllowlist.length === 0) {
      note("Allowlist is empty. Anyone can message the bot.", "warning");
    }
    return {
      tokenPresent: Boolean(initialToken),
      allowlistPresent: initialAllowlist.length > 0,
    };
  }

  let token = initialToken?.trim() ?? "";
  if (!token) {
    const entered = await password({
      message: "Enter your Telegram bot token (looks like 123456:ABCDEF...)",
      mask: "*",
      validate: (value) => (value.trim().length < 10 ? "token looks too short" : undefined),
    });
    if (isCancel(entered)) {
      return {
        tokenPresent: false,
        allowlistPresent: initialAllowlist.length > 0,
      };
    }
    token = String(entered).trim();
    updateTomlValue(configPath, "telegram", "token", tomlString(token));
  }

  for (;;) {
    note("Send /start to your bot now. Waiting for the message...", "telegram");
    const wait = spinner();
    wait.start("Waiting for /start...");
    const result = await waitForTelegramStart(token, 90_000);
    wait.stop(result ? "Message received." : "No /start message yet.");
    if (!result) {
      const retry = await confirm({
        message: "No /start message yet. Keep waiting?",
        initialValue: true,
      });
      if (isCancel(retry) || !retry) {
        return {
          tokenPresent: Boolean(token),
          allowlistPresent: initialAllowlist.length > 0,
        };
      }
      continue;
    }

    if (!result.sawStart) {
      note("Found a recent message, but not a /start. Continuing anyway.", "info");
    }

    const user = result.user;

    const label = user.username ? `@${user.username}` : `${user.firstName ?? "user"}`;
    const ok = await confirm({
      message: `Use ${label} (ID ${user.id}) for allowlist?`,
      initialValue: true,
    });
    if (!isCancel(ok) && ok) {
      const updated = updateAllowlist(configPath, user.id);
      return {
        tokenPresent: Boolean(token),
        allowlistPresent: updated.length > 0,
      };
    }

    const manual = await text({
      message: "Enter your Telegram user ID (numeric)",
      placeholder: "123456789",
      validate: (value) => (Number.isFinite(Number(value)) ? undefined : "must be a number"),
    });
    if (isCancel(manual)) {
      return {
        tokenPresent: Boolean(token),
        allowlistPresent: initialAllowlist.length > 0,
      };
    }
    const manualId = Number(manual);
    if (Number.isFinite(manualId)) {
      const updated = updateAllowlist(configPath, manualId);
      return {
        tokenPresent: Boolean(token),
        allowlistPresent: updated.length > 0,
      };
    }
    return {
      tokenPresent: Boolean(token),
      allowlistPresent: initialAllowlist.length > 0,
    };
  }
}

function updateAllowlist(configPath: string, userId: number): number[] {
  const current = readTomlConfig(configPath);
  const allowlist = normalizeAllowlist(current?.telegram?.allowlist);
  if (!allowlist.includes(userId)) {
    allowlist.push(userId);
  }
  const value = `[${allowlist.join(", ")}]`;
  updateTomlValue(configPath, "telegram", "allowlist", value);
  return allowlist;
}

function readTomlConfig(configPath: string): TomlConfig | null {
  try {
    const raw = readFileSync(configPath, "utf-8");
    return Bun.TOML.parse(raw) as TomlConfig;
  } catch {
    return null;
  }
}

function normalizeAllowlist(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw
    .map((id) => (typeof id === "string" ? Number(id) : id))
    .filter((id): id is number => Number.isFinite(id));
  return Array.from(new Set(ids));
}

function updateTomlValue(configPath: string, section: string, key: string, value: string) {
  let content = "";
  try {
    content = readFileSync(configPath, "utf-8");
  } catch {
    content = "";
  }
  const updated = setTomlValue(content, section, key, value);
  writeFileSync(configPath, updated, "utf-8");
}

function setTomlValue(content: string, section: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  let sectionStart = -1;
  let sectionEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() ?? "";
    const match = trimmed.match(/^\[([^\]]+)\]$/);
    if (match?.[1] === section) {
      sectionStart = i;
      for (let j = i + 1; j < lines.length; j++) {
        const nextTrimmed = lines[j]?.trim() ?? "";
        if (/^\[([^\]]+)\]$/.test(nextTrimmed)) {
          sectionEnd = j;
          break;
        }
      }
      break;
    }
  }

  if (sectionStart === -1) {
    const suffix = lines.length > 0 && lines[lines.length - 1]?.trim() ? [""] : [];
    return [...lines, ...suffix, `[${section}]`, `${key} = ${value}`].join("\n");
  }

  const keyRe = new RegExp(`^\\s*(#\\s*)?${key}\\s*=`);
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (keyRe.test(lines[i] ?? "")) {
      lines[i] = `${key} = ${value}`;
      return lines.join("\n");
    }
  }

  lines.splice(sectionEnd, 0, `${key} = ${value}`);
  return lines.join("\n");
}

function tomlString(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

type TelegramUser = {
  id: number;
  username?: string;
  firstName?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    from?: { id: number; username?: string; first_name?: string };
  };
  callback_query?: {
    data?: string;
    from?: { id: number; username?: string; first_name?: string };
  };
  my_chat_member?: {
    from?: { id: number; username?: string; first_name?: string };
  };
  chat_member?: {
    from?: { id: number; username?: string; first_name?: string };
  };
};

type WaitResult = {
  user: TelegramUser;
  sawStart: boolean;
};

async function waitForTelegramStart(token: string, timeoutMs: number): Promise<WaitResult | null> {
  const startedAt = Date.now();
  let offset: number | undefined;
  let fallbackUser: TelegramUser | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    const timeoutSec = Math.max(1, Math.min(25, Math.ceil(remainingMs / 1000)));

    const updates = await fetchTelegramUpdates(token, {
      offset,
      limit: 50,
      timeout: timeoutSec,
    });
    if (!updates) {
      return fallbackUser ? { user: fallbackUser, sawStart: false } : null;
    }
    if (updates.length === 0) {
      continue;
    }

    const sorted = [...updates].sort((a, b) => (a.update_id ?? 0) - (b.update_id ?? 0));
    const lastId = sorted[sorted.length - 1]?.update_id;
    if (typeof lastId === "number" && Number.isFinite(lastId)) {
      offset = lastId + 1;
    }

    for (const update of sorted) {
      const candidate = extractTelegramUser(update);
      if (!candidate) {
        continue;
      }
      if (candidate.sawStart) {
        return { user: candidate.user, sawStart: true };
      }
      fallbackUser = candidate.user;
    }
  }

  return fallbackUser ? { user: fallbackUser, sawStart: false } : null;
}

async function fetchTelegramUpdates(
  token: string,
  params: { offset?: number; limit?: number; timeout?: number },
): Promise<TelegramUpdate[] | null> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset: params.offset,
        limit: params.limit ?? 50,
        timeout: params.timeout ?? 0,
        allowed_updates: ["message", "callback_query", "my_chat_member", "chat_member"],
      }),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as {
      ok: boolean;
      result?: TelegramUpdate[];
    };
    if (!data.ok || !Array.isArray(data.result)) {
      return null;
    }
    return data.result;
  } catch {
    return null;
  }
}

function extractTelegramUser(update: TelegramUpdate): { user: TelegramUser; sawStart: boolean } | null {
  const from =
    update.message?.from ??
    update.callback_query?.from ??
    update.my_chat_member?.from ??
    update.chat_member?.from;
  if (!from || !Number.isFinite(from.id)) {
    return null;
  }
  const text = update.message?.text ?? update.callback_query?.data;
  const sawStart = typeof text === "string" && text.trim().startsWith("/start");
  return {
    user: {
      id: from.id,
      username: from.username,
      firstName: from.first_name,
    },
    sawStart,
  };
}

function securePermissions(root: string) {
  try {
    chmodSync(root, 0o700);
  } catch {
    // ignore
  }
  let dirents: Array<import("node:fs").Dirent> = [];
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of dirents) {
    const full = path.join(root, entry.name);
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        try {
          chmodSync(full, 0o700);
        } catch {
          // ignore
        }
        securePermissions(full);
      } else {
        try {
          chmodSync(full, 0o600);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
}

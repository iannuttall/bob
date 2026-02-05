import { createTelegramClient } from "./client";
import { parseTelegramUpdate, parseCallbackQuery } from "./parse";
import type { TelegramChatAction } from "./client";
import type {
  TelegramEntity,
  TelegramMessage,
  TelegramImage,
  TelegramInlineKeyboard,
  TelegramCallbackData,
} from "./types";
import { TELEGRAM_SAFE_CHARS, chunkTelegramMessage, renderTelegramMarkdown } from "./render";
import { atomicWriteText } from "../utils/atomic-write";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type TelegramTransportConfig = {
  token: string;
  allowlist: number[];
  statePath?: string;
};

export type TelegramTransportHandlers = {
  onMessage: (message: TelegramMessage) => Promise<void> | void;
  onCallback?: (callback: TelegramCallbackData) => Promise<void> | void;
  onIgnored?: (message: TelegramMessage, reason: string) => void;
  onError?: (error: Error) => void;
  onReady?: () => void;
};

export async function startTelegramTransport(
  config: TelegramTransportConfig,
  handlers: TelegramTransportHandlers,
) {
  const client = createTelegramClient({ token: config.token });
  let offset: number | undefined = loadOffset(config.statePath);
  let didReady = false;

  for (;;) {
    try {
      const updates = await client.getUpdates({
        offset,
        timeoutSeconds: 30,
        allowedUpdates: ["message", "callback_query"],
      });
      if (!didReady) {
        didReady = true;
        handlers.onReady?.();
      }

      for (const update of updates) {
        // Handle callback queries (button presses)
        if (update.callback_query && handlers.onCallback) {
          const callback = parseCallbackQuery(update);
          if (callback) {
            if (config.allowlist.length > 0 && !config.allowlist.includes(callback.senderId)) {
              continue;
            }
            await handlers.onCallback(callback);
          }
          offset = update.update_id + 1;
          persistOffset(config.statePath, offset);
          continue;
        }

        // Handle regular messages
        const parsed = parseTelegramUpdate(update);
        if (!parsed) {
          offset = update.update_id + 1;
          persistOffset(config.statePath, offset);
          continue;
        }
        if (config.allowlist.length > 0 && !config.allowlist.includes(parsed.senderId)) {
          handlers.onIgnored?.(parsed, "sender-not-allowed");
          offset = update.update_id + 1;
          persistOffset(config.statePath, offset);
          continue;
        }
        await handlers.onMessage(parsed);

        offset = update.update_id + 1;
        persistOffset(config.statePath, offset);
      }
    } catch (error) {
      handlers.onError?.(asError(error));
      await sleep(1500);
    }
  }
}

export async function sendTelegramMessage(
  config: TelegramTransportConfig,
  chatId: number,
  text: string,
  options: {
    threadId?: number;
    replyToMessageId?: number;
    chunk?: boolean;
    entities?: TelegramEntity[];
    replyMarkup?: TelegramInlineKeyboard;
  } = {},
) {
  const client = createTelegramClient({ token: config.token });
  if (!text.trim()) {
    return null;
  }
  const rendered = options.entities
    ? { text, entities: options.entities }
    : renderTelegramMarkdown(text);
  const chunks =
    options.chunk === false
      ? [trimRendered(rendered, TELEGRAM_SAFE_CHARS)]
      : chunkTelegramMessage(rendered);
  let firstMessageId: number | null = null;
  for (const chunk of chunks) {
    const result = await safeSendMessage(client, chatId, chunk.text, {
      threadId: options.threadId,
      replyToMessageId: options.replyToMessageId,
      entities: chunk.entities,
      replyMarkup: options.replyMarkup,
    });
    if (firstMessageId === null) {
      firstMessageId = result.messageId;
    }
  }
  return firstMessageId;
}

export function startTypingIndicator(
  config: TelegramTransportConfig,
  chatId: number,
  options: { threadId?: number; intervalMs?: number } = {},
) {
  const client = createTelegramClient({ token: config.token });
  const intervalMs = options.intervalMs ?? 4000;
  let stopped = false;

  const sendOnce = async () => {
    try {
      await client.sendChatAction(chatId, "typing", { threadId: options.threadId });
    } catch {
      // Ignore typing failures; they should not block replies.
    }
  };

  void sendOnce();
  const timer = setInterval(() => {
    void sendOnce();
  }, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}

export async function sendTelegramChatAction(
  config: TelegramTransportConfig,
  chatId: number,
  action: TelegramChatAction,
  options: { threadId?: number } = {},
) {
  const client = createTelegramClient({ token: config.token });
  return client.sendChatAction(chatId, action, { threadId: options.threadId });
}

export async function editTelegramMessage(
  config: TelegramTransportConfig,
  chatId: number,
  messageId: number,
  text: string,
  options: { entities?: TelegramEntity[]; replyMarkup?: TelegramInlineKeyboard } = {},
) {
  const client = createTelegramClient({ token: config.token });
  return safeEditMessage(client, chatId, messageId, text, {
    entities: options.entities,
    replyMarkup: options.replyMarkup,
  });
}

export async function sendTelegramReaction(
  config: TelegramTransportConfig,
  chatId: number,
  messageId: number,
  emoji: string,
  options: { isBig?: boolean } = {},
) {
  const client = createTelegramClient({ token: config.token });
  try {
    await client.setMessageReaction(
      chatId,
      messageId,
      emoji ? [{ type: "emoji", emoji }] : [],
      options,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Telegram reaction failed: ${message}`);
    return false;
  }
}

async function safeSendMessage(
  client: ReturnType<typeof createTelegramClient>,
  chatId: number,
  text: string,
  options: {
    threadId?: number;
    replyToMessageId?: number;
    entities?: TelegramEntity[];
    replyMarkup?: TelegramInlineKeyboard;
  },
) {
  try {
    return await client.sendMessage(chatId, text, {
      threadId: options.threadId,
      replyToMessageId: options.replyToMessageId,
      entities: options.entities,
      replyMarkup: options.replyMarkup,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/parse entities|entity/i.test(message)) {
      return client.sendMessage(chatId, text, {
        threadId: options.threadId,
        replyToMessageId: options.replyToMessageId,
        replyMarkup: options.replyMarkup,
      });
    }
    throw error;
  }
}

function trimRendered(rendered: { text: string; entities: TelegramEntity[] }, maxChars: number) {
  if (rendered.text.length <= maxChars) {
    return rendered;
  }
  const trimmedText = `${rendered.text.slice(0, maxChars - 1)}…`;
  const entities = rendered.entities
    .map((entity) => {
      const end = entity.offset + entity.length;
      if (entity.offset >= maxChars) return null;
      const nextEnd = Math.min(end, maxChars - 1);
      const length = nextEnd - entity.offset;
      if (length <= 0) return null;
      return { ...entity, length };
    })
    .filter(Boolean) as TelegramEntity[];
  return { text: trimmedText, entities };
}

async function safeEditMessage(
  client: ReturnType<typeof createTelegramClient>,
  chatId: number,
  messageId: number,
  text: string,
  options: { entities?: TelegramEntity[]; replyMarkup?: TelegramInlineKeyboard },
) {
  try {
    return await client.editMessageText(chatId, messageId, text, {
      entities: options.entities,
      replyMarkup: options.replyMarkup,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/parse entities|entity/i.test(message)) {
      return client.editMessageText(chatId, messageId, text, {
        replyMarkup: options.replyMarkup,
      });
    }
    throw error;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadOffset(statePath?: string): number | undefined {
  if (!statePath) return undefined;
  try {
    if (!existsSync(statePath)) return undefined;
    const raw = readFileSync(statePath, "utf-8").trim();
    if (!raw) return undefined;
    if (/^\d+$/.test(raw)) {
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    }
    const parsed = JSON.parse(raw) as { offset?: number } | number;
    if (typeof parsed === "number" && Number.isFinite(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && Number.isFinite(parsed.offset)) {
      return parsed.offset;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function persistOffset(statePath: string | undefined, offset: number) {
  if (!statePath) return;
  try {
    mkdirSync(path.dirname(statePath), { recursive: true });
    atomicWriteText(statePath, JSON.stringify({ offset }));
  } catch {
    // best-effort only
  }
}

export async function answerTelegramCallback(
  config: TelegramTransportConfig,
  queryId: string,
  options: { text?: string; showAlert?: boolean } = {},
) {
  const client = createTelegramClient({ token: config.token });
  try {
    await client.answerCallbackQuery(queryId, options);
    return true;
  } catch {
    return false;
  }
}

export async function removeTelegramKeyboard(
  config: TelegramTransportConfig,
  chatId: number,
  messageId: number,
) {
  const client = createTelegramClient({ token: config.token });
  try {
    await client.editMessageReplyMarkup(chatId, messageId);
    return true;
  } catch {
    return false;
  }
}

export function makeCancelKeyboard(): TelegramInlineKeyboard {
  return {
    inline_keyboard: [[{ text: "cancel", callback_data: "cancel" }]],
  };
}

export async function registerTelegramCommands(config: TelegramTransportConfig) {
  const client = createTelegramClient({ token: config.token });
  const commands = [
    { command: "agent", description: "switch between claude and codex" },
    { command: "status", description: "show current engine and upcoming jobs" },
  ];
  try {
    await client.setMyCommands(commands);
    return true;
  } catch {
    return false;
  }
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : "Unknown error");
}

export type DownloadedImage = {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
};

export async function downloadTelegramImage(
  config: TelegramTransportConfig,
  image: TelegramImage,
): Promise<DownloadedImage> {
  const client = createTelegramClient({ token: config.token });
  const { filePath } = await client.getFile(image.fileId);
  const data = await client.downloadFile(filePath);

  // Detect media type from file extension
  const ext = filePath.split(".").pop()?.toLowerCase();
  let mediaType: DownloadedImage["mediaType"] = "image/jpeg";
  if (ext === "png") mediaType = "image/png";
  else if (ext === "gif") mediaType = "image/gif";
  else if (ext === "webp") mediaType = "image/webp";

  // Convert to base64
  const base64 = Buffer.from(data).toString("base64");
  return { base64, mediaType };
}

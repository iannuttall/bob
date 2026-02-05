import TelegramBot from "node-telegram-bot-api";
import type { TelegramSendOptions, TelegramUpdate } from "./types";

export type TelegramClientOptions = {
  token: string;
};

export type TelegramGetUpdatesParams = {
  offset?: number;
  timeoutSeconds?: number;
  allowedUpdates?: string[];
};

export type TelegramSendResult = {
  ok: true;
  messageId: number;
  chatId: number;
};

export type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

export type TelegramReaction = {
  type: "emoji" | "custom_emoji";
  emoji?: string;
  custom_emoji_id?: string;
};

const botCache = new Map<string, TelegramBot>();

function getBot(token: string) {
  const existing = botCache.get(token);
  if (existing) return existing;
  const bot = new TelegramBot(token, { polling: false });
  botCache.set(token, bot);
  return bot;
}

export function createTelegramClient(options: TelegramClientOptions) {
  const bot = getBot(options.token);

  async function getUpdates(params: TelegramGetUpdatesParams = {}) {
    const payload: TelegramBot.GetUpdatesOptions = {
      timeout: params.timeoutSeconds ?? 30,
    };
    if (params.offset !== undefined) {
      payload.offset = params.offset;
    }
    if (params.allowedUpdates) {
      payload.allowed_updates = params.allowedUpdates;
    }
    const result = await bot.getUpdates(payload);
    return result as unknown as TelegramUpdate[];
  }

  async function sendMessage(
    chatId: number,
    text: string,
    options: TelegramSendOptions = {},
  ): Promise<TelegramSendResult> {
    const payload: TelegramBot.SendMessageOptions & { message_thread_id?: number } = {};
    if (options.replyToMessageId !== undefined) {
      payload.reply_to_message_id = options.replyToMessageId;
    }
    if (options.threadId !== undefined) {
      payload.message_thread_id = options.threadId;
    }
    if (options.entities && options.entities.length > 0) {
      payload.entities = options.entities as TelegramBot.MessageEntity[];
    } else if (options.parseMode) {
      payload.parse_mode = options.parseMode;
    }
    if (options.disableWebPreview !== undefined) {
      payload.disable_web_page_preview = options.disableWebPreview;
    }
    if (options.replyMarkup) {
      payload.reply_markup = options.replyMarkup as TelegramBot.InlineKeyboardMarkup;
    }
    const result = await bot.sendMessage(chatId, text, payload);
    return { ok: true, messageId: result.message_id, chatId: result.chat.id };
  }

  async function editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options: Omit<TelegramSendOptions, "replyToMessageId" | "threadId"> = {},
  ): Promise<TelegramSendResult> {
    const payload: TelegramBot.EditMessageTextOptions & {
      entities?: TelegramBot.MessageEntity[];
    } = {
      chat_id: chatId,
      message_id: messageId,
    };
    if (options.entities && options.entities.length > 0) {
      payload.entities = options.entities as TelegramBot.MessageEntity[];
    } else if (options.parseMode) {
      payload.parse_mode = options.parseMode;
    }
    if (options.disableWebPreview !== undefined) {
      payload.disable_web_page_preview = options.disableWebPreview;
    }
    if (options.replyMarkup) {
      payload.reply_markup = options.replyMarkup as TelegramBot.InlineKeyboardMarkup;
    }
    const result = await bot.editMessageText(text, payload);
    const resolved = result as TelegramBot.Message;
    return { ok: true, messageId: resolved.message_id, chatId: resolved.chat.id };
  }

  async function editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup?: Record<string, unknown>,
  ): Promise<TelegramSendResult> {
    const payload: TelegramBot.EditMessageReplyMarkupOptions = {
      chat_id: chatId,
      message_id: messageId,
    };
    const markup = (replyMarkup ?? {
      inline_keyboard: [],
    }) as unknown as TelegramBot.InlineKeyboardMarkup;
    const result = await bot.editMessageReplyMarkup(markup, payload);
    const resolved = result as TelegramBot.Message;
    return { ok: true, messageId: resolved.message_id, chatId: resolved.chat.id };
  }

  async function answerCallbackQuery(
    callbackQueryId: string,
    options: { text?: string; showAlert?: boolean } = {},
  ) {
    const payload: Partial<TelegramBot.AnswerCallbackQueryOptions> = {};
    if (options.text) {
      payload.text = options.text;
    }
    if (options.showAlert !== undefined) {
      payload.show_alert = options.showAlert;
    }
    return bot.answerCallbackQuery(callbackQueryId, payload);
  }

  async function setMessageReaction(
    chatId: number,
    messageId: number,
    reaction: TelegramReaction[] | null,
    options: { isBig?: boolean } = {},
  ) {
    return bot.setMessageReaction(chatId, messageId, {
      reaction: (reaction ?? []) as TelegramBot.ReactionType[],
      is_big: options.isBig,
    });
  }

  async function sendChatAction(
    chatId: number,
    action: TelegramChatAction,
    options: { threadId?: number } = {},
  ) {
    const payload: TelegramBot.SendChatActionOptions =
      options.threadId !== undefined ? { message_thread_id: options.threadId } : {};
    return bot.sendChatAction(chatId, action as TelegramBot.ChatAction, payload);
  }

  async function setMyCommands(commands: Array<{ command: string; description: string }>) {
    return bot.setMyCommands(commands);
  }

  async function getFile(fileId: string): Promise<{ filePath: string }> {
    const result = await bot.getFile(fileId);
    const filePath = (result as TelegramBot.File).file_path;
    if (!filePath) {
      throw new Error("No file_path in getFile response");
    }
    return { filePath };
  }

  async function downloadFile(filePath: string): Promise<ArrayBuffer> {
    const url = `https://api.telegram.org/file/bot${options.token}/${filePath}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download file: HTTP ${response.status}`);
    }
    return response.arrayBuffer();
  }

  return {
    getUpdates,
    sendMessage,
    editMessageText,
    editMessageReplyMarkup,
    sendChatAction,
    setMessageReaction,
    answerCallbackQuery,
    setMyCommands,
    getFile,
    downloadFile,
  };
}

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

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

export function createTelegramClient(options: TelegramClientOptions) {
  const baseUrl = `https://api.telegram.org/bot${options.token}`;

  async function call<T>(method: string, payload?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${baseUrl}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });

    let dataText = "";
    try {
      dataText = await response.text();
    } catch {
      dataText = "";
    }
    let data: TelegramApiResponse<T> | null = null;
    if (dataText) {
      try {
        data = JSON.parse(dataText) as TelegramApiResponse<T>;
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const detail = data?.description ?? (dataText || "unknown");
      throw new Error(`Telegram API HTTP ${response.status}: ${detail}`);
    }

    if (!data) {
      data = (await response.json()) as TelegramApiResponse<T>;
    }
    if (!data.ok || data.result === undefined) {
      throw new Error(`Telegram API error: ${data.description ?? "unknown"}`);
    }

    return data.result;
  }

  async function getUpdates(params: TelegramGetUpdatesParams = {}) {
    const payload: Record<string, unknown> = {
      timeout: params.timeoutSeconds ?? 30,
    };
    if (params.offset !== undefined) {
      payload.offset = params.offset;
    }
    if (params.allowedUpdates) {
      payload.allowed_updates = params.allowedUpdates;
    }
    return call<TelegramUpdate[]>("getUpdates", payload);
  }

  async function sendMessage(
    chatId: number,
    text: string,
    options: TelegramSendOptions = {},
  ): Promise<TelegramSendResult> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (options.replyToMessageId !== undefined) {
      payload.reply_to_message_id = options.replyToMessageId;
    }
    if (options.threadId !== undefined) {
      payload.message_thread_id = options.threadId;
    }
    if (options.entities && options.entities.length > 0) {
      payload.entities = options.entities;
    } else if (options.parseMode) {
      payload.parse_mode = options.parseMode;
    }
    if (options.disableWebPreview !== undefined) {
      payload.disable_web_page_preview = options.disableWebPreview;
    }
    if (options.replyMarkup) {
      payload.reply_markup = options.replyMarkup;
    }

    const result = await call<{ message_id: number; chat: { id: number } }>("sendMessage", payload);
    return { ok: true, messageId: result.message_id, chatId: result.chat.id };
  }

  async function editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options: Omit<TelegramSendOptions, "replyToMessageId" | "threadId"> = {},
  ): Promise<TelegramSendResult> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (options.entities && options.entities.length > 0) {
      payload.entities = options.entities;
    } else if (options.parseMode) {
      payload.parse_mode = options.parseMode;
    }
    if (options.disableWebPreview !== undefined) {
      payload.disable_web_page_preview = options.disableWebPreview;
    }
    if (options.replyMarkup) {
      payload.reply_markup = options.replyMarkup;
    }
    const result = await call<{ message_id: number; chat: { id: number } }>(
      "editMessageText",
      payload,
    );
    return { ok: true, messageId: result.message_id, chatId: result.chat.id };
  }

  async function editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup?: Record<string, unknown>,
  ): Promise<TelegramSendResult> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const result = await call<{ message_id: number; chat: { id: number } }>(
      "editMessageReplyMarkup",
      payload,
    );
    return { ok: true, messageId: result.message_id, chatId: result.chat.id };
  }

  async function answerCallbackQuery(
    callbackQueryId: string,
    options: { text?: string; showAlert?: boolean } = {},
  ) {
    const payload: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    };
    if (options.text) {
      payload.text = options.text;
    }
    if (options.showAlert !== undefined) {
      payload.show_alert = options.showAlert;
    }
    return call<boolean>("answerCallbackQuery", payload);
  }

  async function setMessageReaction(
    chatId: number,
    messageId: number,
    reaction: TelegramReaction[] | null,
    options: { isBig?: boolean } = {},
  ) {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      reaction: reaction ?? [],
    };
    if (options.isBig !== undefined) {
      payload.is_big = options.isBig;
    }
    return call<boolean>("setMessageReaction", payload);
  }

  async function sendChatAction(
    chatId: number,
    action: TelegramChatAction,
    options: { threadId?: number } = {},
  ) {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      action,
    };
    if (options.threadId !== undefined) {
      payload.message_thread_id = options.threadId;
    }
    return call<boolean>("sendChatAction", payload);
  }

  async function setMyCommands(
    commands: Array<{ command: string; description: string }>,
  ) {
    return call<boolean>("setMyCommands", { commands });
  }

  async function getFile(fileId: string): Promise<{ filePath: string }> {
    const result = await call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!result.file_path) {
      throw new Error("No file_path in getFile response");
    }
    return { filePath: result.file_path };
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

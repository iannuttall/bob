export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessagePayload;
  callback_query?: TelegramCallbackQuery;
};

export type TelegramCallbackQuery = {
  id: string;
  from: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  message?: TelegramMessagePayload;
  chat_instance: string;
  data?: string;
};

export type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};

export type TelegramMessagePayload = {
  message_id: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  chat: {
    id: number;
    type: string;
  };
  from?: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  message_thread_id?: number;
};

export type TelegramImage = {
  fileId: string;
  width: number;
  height: number;
};

export type TelegramMessage = {
  updateId: number;
  messageId: number;
  chatId: number;
  threadId?: number;
  senderId: number;
  text: string;
  images?: TelegramImage[];
};

export type TelegramEntity = {
  type: "bold" | "italic" | "underline" | "strikethrough" | "code" | "pre" | "text_link" | "blockquote";
  offset: number;
  length: number;
  url?: string;
  language?: string;
};

export type TelegramSendOptions = {
  replyToMessageId?: number;
  threadId?: number;
  entities?: TelegramEntity[];
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  disableWebPreview?: boolean;
  replyMarkup?: TelegramInlineKeyboard;
};

export type TelegramInlineKeyboard = {
  inline_keyboard: TelegramInlineButton[][];
};

export type TelegramInlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type TelegramCallbackData = {
  queryId: string;
  chatId: number;
  messageId: number;
  senderId: number;
  data: string;
};

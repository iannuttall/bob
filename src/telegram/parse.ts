import type { TelegramMessage, TelegramUpdate, TelegramCallbackData, TelegramImage } from "./types";

export function parseTelegramUpdate(update: TelegramUpdate): TelegramMessage | null {
  const message = update.message;
  if (!message) {
    return null;
  }

  // Text can come from text field or caption (for photos)
  const text = (message.text ?? message.caption)?.trim();
  const hasPhoto = message.photo && message.photo.length > 0;

  // Need either text or photo
  if (!text && !hasPhoto) {
    return null;
  }

  const senderId = message.from?.id;
  if (!senderId) {
    return null;
  }

  // Extract images - Telegram sends multiple sizes, pick the largest
  let images: TelegramImage[] | undefined;
  if (message.photo && message.photo.length > 0) {
    // Sort by size descending, take the largest
    const sorted = [...message.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0));
    const largest = sorted[0];
    if (largest) {
      images = [{
        fileId: largest.file_id,
        width: largest.width,
        height: largest.height,
      }];
    }
  }

  return {
    updateId: update.update_id,
    messageId: message.message_id,
    chatId: message.chat.id,
    threadId: message.message_thread_id,
    senderId,
    text: text ?? "",
    images,
  };
}

export function parseCallbackQuery(update: TelegramUpdate): TelegramCallbackData | null {
  const callback = update.callback_query;
  if (!callback) {
    return null;
  }
  const senderId = callback.from.id;
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;
  if (!chatId || !messageId) {
    return null;
  }

  return {
    queryId: callback.id,
    chatId,
    messageId,
    senderId,
    data: callback.data ?? "",
  };
}

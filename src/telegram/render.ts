import MarkdownIt from "markdown-it";
import type { TelegramEntity } from "./types";

type MarkdownItInstance = InstanceType<typeof MarkdownIt>;
type Token = ReturnType<MarkdownItInstance["parse"]>[number];

export type RenderedTelegramMessage = {
  text: string;
  entities: TelegramEntity[];
};

export const TELEGRAM_MAX_CHARS = 4096;
export const TELEGRAM_SAFE_CHARS = 3500;

// Use "default" preset which includes tables, enable strikethrough
const md = new MarkdownIt("default", { html: false, linkify: true }).enable("strikethrough");

type EntityFrame = {
  type: TelegramEntity["type"];
  offset: number;
  url?: string;
  language?: string;
};

type ListState = {
  type: "bullet" | "ordered";
  index: number;
};

type TableState = {
  rows: string[][];
  currentRow: string[];
  currentCell: string | null;
};

type RenderState = {
  text: string;
  entities: TelegramEntity[];
  offset: number;
  stack: EntityFrame[];
  listStack: ListState[];
  listItemDepth: number;
  needsNewline: boolean;
  inBlockquote: boolean;
  blockquoteStart: number;
  table: TableState | null;
};

export function renderTelegramMarkdown(markdown: string): RenderedTelegramMessage {
  const tokens = md.parse(markdown ?? "", {});
  const state: RenderState = {
    text: "",
    entities: [],
    offset: 0,
    stack: [],
    listStack: [],
    listItemDepth: 0,
    needsNewline: false,
    inBlockquote: false,
    blockquoteStart: 0,
    table: null,
  };
  renderTokens(tokens, state);
  state.entities.sort((a, b) => a.offset - b.offset || a.length - b.length);
  const trimmed = state.text.replace(/\s+$/g, "");
  const trimmedLength = trimmed.length;
  const entities = state.entities
    .map((entity) => {
      if (entity.offset >= trimmedLength) {
        return null;
      }
      const end = entity.offset + entity.length;
      const nextEnd = Math.min(end, trimmedLength);
      const length = nextEnd - entity.offset;
      if (length <= 0) return null;
      return { ...entity, length };
    })
    .filter(Boolean) as TelegramEntity[];
  return {
    text: trimmed,
    entities,
  };
}

export function chunkTelegramMessage(
  rendered: RenderedTelegramMessage,
  maxChars: number = TELEGRAM_SAFE_CHARS,
): RenderedTelegramMessage[] {
  if (rendered.text.length <= maxChars) {
    return [rendered];
  }

  const chunks: RenderedTelegramMessage[] = [];
  let start = 0;
  while (start < rendered.text.length) {
    const end = findChunkEnd(rendered.text, start, maxChars);
    const chunkText = rendered.text.slice(start, end);
    const chunkEntities = sliceEntities(rendered.entities, start, end);
    chunks.push({ text: chunkText, entities: chunkEntities });
    start = end;
  }
  return chunks;
}

function findChunkEnd(text: string, start: number, maxChars: number): number {
  const maxEnd = Math.min(text.length, start + maxChars);
  if (maxEnd === text.length) {
    return maxEnd;
  }
  const newline = text.lastIndexOf("\n", maxEnd);
  if (newline > start + Math.floor(maxChars * 0.4)) {
    return newline + 1;
  }
  return maxEnd;
}

function sliceEntities(entities: TelegramEntity[], start: number, end: number): TelegramEntity[] {
  const sliced: TelegramEntity[] = [];
  for (const entity of entities) {
    const entityStart = entity.offset;
    const entityEnd = entity.offset + entity.length;
    if (entityEnd <= start || entityStart >= end) {
      continue;
    }
    const nextStart = Math.max(entityStart, start);
    const nextEnd = Math.min(entityEnd, end);
    const nextLength = nextEnd - nextStart;
    if (nextLength <= 0) continue;
    sliced.push({
      ...entity,
      offset: nextStart - start,
      length: nextLength,
    });
  }
  return sliced;
}

function renderTokens(tokens: Token[], state: RenderState) {
  for (const token of tokens) {
    if (token.type === "inline") {
      renderInline(token.children ?? [], state);
      continue;
    }

    switch (token.type) {
      case "paragraph_open":
        if (!isInListItem(state)) {
          ensureBlockStart(state);
        }
        break;
      case "paragraph_close":
        if (!isInListItem(state)) {
          pushNewline(state, 2);
        }
        break;
      case "heading_open":
        ensureBlockStart(state);
        openEntity(state, "bold");
        break;
      case "heading_close":
        closeEntity(state, "bold");
        pushNewline(state, 2);
        break;
      case "bullet_list_open":
        state.listStack.push({ type: "bullet", index: 1 });
        break;
      case "bullet_list_close":
        state.listStack.pop();
        pushNewline(state, 2);
        break;
      case "ordered_list_open": {
        const start = Number(token.attrGet("start") ?? 1);
        state.listStack.push({ type: "ordered", index: Number.isFinite(start) ? start : 1 });
        break;
      }
      case "ordered_list_close":
        state.listStack.pop();
        pushNewline(state, 2);
        break;
      case "list_item_open":
        ensureBlockStart(state);
        state.listItemDepth += 1;
        appendListPrefix(state);
        break;
      case "list_item_close":
        state.listItemDepth = Math.max(0, state.listItemDepth - 1);
        pushNewline(state, 1);
        break;
      case "blockquote_open":
        ensureBlockStart(state);
        state.inBlockquote = true;
        state.blockquoteStart = state.offset;
        break;
      case "blockquote_close":
        if (state.inBlockquote) {
          const length = state.offset - state.blockquoteStart;
          if (length > 0) {
            state.entities.push({
              type: "blockquote",
              offset: state.blockquoteStart,
              length,
            });
          }
          state.inBlockquote = false;
        }
        pushNewline(state, 2);
        break;
      case "hr":
        ensureBlockStart(state);
        appendText(state, "───────────────");
        pushNewline(state, 2);
        break;
      case "fence":
      case "code_block":
        ensureBlockStart(state);
        appendCodeBlock(state, token);
        pushNewline(state, 3);
        break;
      // Table handling - buffer cells, render on close
      case "table_open":
        ensureBlockStart(state);
        state.table = { rows: [], currentRow: [], currentCell: null };
        break;
      case "table_close":
        if (state.table) {
          renderTable(state, state.table);
          state.table = null;
        }
        pushNewline(state, 1);
        break;
      case "thead_open":
      case "thead_close":
      case "tbody_open":
      case "tbody_close":
        break;
      case "tr_open":
        if (state.table) state.table.currentRow = [];
        break;
      case "tr_close":
        if (state.table) {
          state.table.rows.push(state.table.currentRow);
          state.table.currentRow = [];
        }
        break;
      case "th_open":
      case "td_open":
        if (state.table) state.table.currentCell = "";
        break;
      case "th_close":
      case "td_close":
        if (state.table && state.table.currentCell !== null) {
          state.table.currentRow.push(state.table.currentCell);
          state.table.currentCell = null;
        }
        break;
      default:
        break;
    }
  }
}

function renderInline(tokens: Token[], state: RenderState) {
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        appendText(state, token.content);
        break;
      case "softbreak":
      case "hardbreak":
        appendText(state, "\n");
        break;
      case "code_inline":
        appendInlineCode(state, token.content);
        break;
      case "strong_open":
        openEntity(state, "bold");
        break;
      case "strong_close":
        closeEntity(state, "bold");
        break;
      case "em_open":
        openEntity(state, "italic");
        break;
      case "em_close":
        closeEntity(state, "italic");
        break;
      case "s_open":
      case "del_open":
        openEntity(state, "strikethrough");
        break;
      case "s_close":
      case "del_close":
        closeEntity(state, "strikethrough");
        break;
      case "link_open": {
        const href = token.attrGet("href") ?? "";
        openEntity(state, "text_link", href.trim() || undefined);
        break;
      }
      case "link_close":
        closeEntity(state, "text_link");
        break;
      default:
        break;
    }
  }
}

function appendText(state: RenderState, text: string) {
  if (!text) return;
  // If inside a table cell, buffer the text
  if (state.table && state.table.currentCell !== null) {
    state.table.currentCell += text;
    return;
  }
  state.text += text;
  state.offset += text.length;
  state.needsNewline = true;
}

function appendInlineCode(state: RenderState, content: string) {
  if (!content) return;
  const start = state.offset;
  appendText(state, content);
  state.entities.push({
    type: "code",
    offset: start,
    length: state.offset - start,
  });
}

function appendCodeBlock(state: RenderState, token: Token) {
  const content = token.content ?? "";
  const info = token.info?.trim() || undefined;
  const start = state.offset;
  appendText(state, content);
  const length = state.offset - start;
  if (length > 0) {
    state.entities.push({
      type: "pre",
      offset: start,
      length,
      ...(info ? { language: info.split(/\s+/)[0] } : {}),
    });
  }
}

function pushNewline(state: RenderState, count: number) {
  if (!state.text) return;
  const existing = state.text.match(/\n+$/);
  const current = existing ? existing[0].length : 0;
  if (current >= count) return;
  appendText(state, "\n".repeat(count - current));
  state.needsNewline = false;
}

function ensureBlockStart(state: RenderState) {
  if (!state.text) return;
  if (state.needsNewline) {
    pushNewline(state, 1);
  }
}

function appendListPrefix(state: RenderState) {
  const depth = Math.max(0, state.listStack.length - 1);
  const indent = depth > 0 ? "  ".repeat(depth) : "";
  const current = state.listStack[state.listStack.length - 1];
  if (!current) {
    appendText(state, indent);
    return;
  }
  if (current.type === "ordered") {
    appendText(state, `${indent}${current.index}. `);
    current.index += 1;
  } else {
    appendText(state, `${indent}- `);
  }
}

function isInListItem(state: RenderState) {
  return state.listItemDepth > 0;
}

function openEntity(state: RenderState, type: TelegramEntity["type"], url?: string) {
  state.stack.push({ type, offset: state.offset, url });
}

function closeEntity(state: RenderState, type: TelegramEntity["type"]) {
  for (let i = state.stack.length - 1; i >= 0; i -= 1) {
    const frame = state.stack[i];
    if (!frame) {
      continue;
    }
    if (frame.type !== type) {
      continue;
    }
    state.stack.splice(i, 1);
    const length = state.offset - frame.offset;
    if (length <= 0) {
      return;
    }
    state.entities.push({
      type,
      offset: frame.offset,
      length,
      ...(frame.url ? { url: frame.url } : {}),
      ...(frame.language ? { language: frame.language } : {}),
    });
    return;
  }
}

function renderTable(state: RenderState, table: TableState) {
  if (table.rows.length === 0) return;

  const headers = table.rows[0] ?? [];
  const dataRows = table.rows.slice(1);

  for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
    const row = dataRows[rowIdx];
    if (!row) continue;

    for (let i = 0; i < row.length; i++) {
      const header = headers[i] ?? `Col ${i + 1}`;
      const value = row[i] ?? "";

      // Bold header
      const headerStart = state.offset;
      state.text += header;
      state.offset += header.length;
      state.entities.push({
        type: "bold",
        offset: headerStart,
        length: header.length,
      });

      state.text += `: ${value}\n`;
      state.offset += 2 + value.length + 1;
    }

    // Blank line between rows (except last)
    if (rowIdx < dataRows.length - 1) {
      state.text += "\n";
      state.offset += 1;
    }
  }

  state.needsNewline = false;
}

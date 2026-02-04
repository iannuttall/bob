import { Codex } from "@openai/codex-sdk";
import { parseCodexToolCall, type Action } from "../conversations/parse";
import { writeTempImages } from "./image-utils";

export type ImageContent = {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
};

export type CodexSdkRunOptions = {
  prompt: string;
  images?: ImageContent[];
  cwd: string;
  sessionId?: string;
  onDelta?: (delta: string) => void;
  yolo?: boolean;
};

export type CodexSdkRunResult = {
  result: string;
  sessionId: string;
  actions: Action[];
};

/**
 * Run Codex using the SDK.
 * Native streaming and session management.
 */
export async function runCodexSdk(
  options: CodexSdkRunOptions,
): Promise<CodexSdkRunResult> {
  const codex = new Codex({
    env: process.env as Record<string, string>,
  });
  const yolo = options.yolo ?? true;
  const sandboxMode = yolo ? "danger-full-access" : "workspace-write";
  const approvalPolicy = yolo ? "never" : "on-request";

  // Resume or start new thread
  const thread = options.sessionId
    ? codex.resumeThread(options.sessionId, {
        workingDirectory: options.cwd,
        sandboxMode,
        approvalPolicy,
      })
    : codex.startThread({
        workingDirectory: options.cwd,
        sandboxMode,
        approvalPolicy,
      });

  let result = "";
  const actions: Action[] = [];

  // Build prompt with images if present
  type InputEntry = { type: "text"; text: string } | { type: "local_image"; path: string };
  let prompt: string | InputEntry[];
  const tempImages = writeTempImages("bob-codex", options.images);

  if (tempImages) {
    const parts: InputEntry[] = [];
    for (const imgPath of tempImages.paths) {
      parts.push({ type: "local_image", path: imgPath });
    }
    parts.push({ type: "text", text: options.prompt });
    prompt = parts;
  } else {
    prompt = options.prompt;
  }

  try {
    const { events } = await thread.runStreamed(prompt);

    for await (const event of events) {
      // Handle agent messages (the main text output)
      if (event.type === "item.completed") {
        const item = (event as { item?: { type?: string; text?: string; name?: string; arguments?: string } }).item;
        if (item?.type === "agent_message" && item.text) {
          options.onDelta?.(item.text);
          result += item.text;
        }
        // Parse tool calls using shared parser
        if (item?.type === "function_call" && item.name) {
          const action = parseCodexToolCall(item.name, item.arguments);
          if (action) {
            actions.push(action);
          }
        }
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex SDK error: ${msg}`);
  } finally {
    tempImages?.cleanup();
  }

  // Get the thread ID for session persistence
  const sessionId = thread.id ?? "";

  if (!result.trim()) {
    result = "(no response)";
  }

  return {
    result: result.trim(),
    sessionId,
    actions,
  };
}

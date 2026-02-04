import { query } from "@anthropic-ai/claude-agent-sdk";
import { parseClaudeContent, type Action } from "../conversations/parse";
import { writeTempImages } from "./image-utils";

export type ImageContent = {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
};

export type ClaudeSdkRunOptions = {
  prompt: string;
  images?: ImageContent[];
  cwd: string;
  sessionId?: string;
  onDelta?: (delta: string) => void;
  skipPermissions?: boolean;
};

export type ClaudeSdkRunResult = {
  result: string;
  sessionId: string;
  actions: Action[];
};

/**
 * Run Claude using the Agent SDK.
 * Native streaming, session management, and hooks.
 */
export async function runClaudeSdk(
  options: ClaudeSdkRunOptions,
): Promise<ClaudeSdkRunResult> {
  let result = "";
  let newSessionId = "";
  const actions: Action[] = [];
  const skipPermissions = options.skipPermissions ?? true;
  // Build prompt - save images to temp files and reference them
  let prompt = options.prompt;
  const tempImages = writeTempImages("bob-claude", options.images);
  if (tempImages) {
    const imageList = tempImages.paths.join(", ");
    prompt = `The user has attached ${tempImages.paths.length} image(s) at: ${imageList}\nPlease read the image(s) first to see what they sent.\n\n${options.prompt}`;
  }

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: options.cwd,
        resume: options.sessionId,
        allowedTools: [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "WebSearch",
          "WebFetch",
        ],
        permissionMode: skipPermissions ? "bypassPermissions" : "default",
        allowDangerouslySkipPermissions: skipPermissions,
        settingSources: ["user"],
      },
    })) {
      // Capture session ID from init message
      if (
        message.type === "system" &&
        (message as { subtype?: string }).subtype === "init"
      ) {
        newSessionId = (message as { session_id?: string }).session_id ?? "";
      }

      // Parse assistant messages using shared parser
      if (message.type === "assistant") {
        const content = (message as { message?: { content?: unknown } }).message?.content;
        if (content) {
          const parsed = parseClaudeContent(
            content as string | Array<{ type: string; text?: string; name?: string; input?: unknown }>,
          );
          // Stream text deltas
          if (parsed.text) {
            options.onDelta?.(parsed.text);
            result += parsed.text;
          }
          // Collect actions
          actions.push(...parsed.actions);
        }
      }

      // Capture final result
      if ("result" in message && message.result) {
        result = message.result as string;
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Claude SDK error: ${msg}`);
  } finally {
    tempImages?.cleanup();
  }

  if (!result.trim()) {
    result = "(no response)";
  }

  return {
    result: result.trim(),
    sessionId: newSessionId,
    actions,
  };
}

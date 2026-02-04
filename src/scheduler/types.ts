export type ScheduleKind = "at" | "every" | "cron";

export type JobType = "send_message" | "agent_turn" | "script";

/**
 * Context mode for scheduled agent turns:
 * - "session": Resume the chat's session (has conversation history)
 * - "isolated": Fresh session with no history (for standalone tasks)
 */
export type ContextMode = "session" | "isolated";

export type SendMessagePayload = {
  text: string;
  replyToMessageId?: number;
  /** Bypass DND for critical alerts */
  urgent?: boolean;
};

export type AgentTurnPayload = {
  prompt: string;
  replyToMessageId?: number;
  /** Original user message to quote when delivering the reminder */
  quotedMessage?: string;
  /** Bypass DND for critical alerts */
  urgent?: boolean;
};

export type ScriptPayload = {
  /** Path to the script, relative to ~/.bob/scripts/ */
  script: string;
  /** Optional arguments to pass to the script */
  args?: string[];
  /** Whether to notify the chat when the script completes */
  notify?: boolean;
};

export type JobPayload = SendMessagePayload | AgentTurnPayload | ScriptPayload;

export type JobRecord = {
  id: number;
  bobId: string;
  chatId: number;
  threadId: number | null;
  scheduleKind: ScheduleKind;
  scheduleSpec: string;
  jobType: JobType;
  payload: JobPayload;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  contextMode: ContextMode;
};

export type EngineId = "claude" | "codex" | "opencode" | "pi";

export type RawConfig = {
  default_engine?: EngineId | string;
  locale?: string;
  timezone?: string;
  telegram?: {
    token?: string;
    allowlist?: (string | number)[];
    ack_reaction?: string;
    queue_messages?: boolean;
    show_cancel_button?: boolean;
  };
  engines?: {
    claude?: {
      skip_permissions?: boolean;
    };
    codex?: {
      yolo?: boolean;
    };
    opencode?: Record<string, unknown>;
    pi?: Record<string, unknown>;
  };
  heartbeat?: {
    enabled?: boolean;
    prompt?: string;
    file?: string;
  };
  dnd?: {
    enabled?: boolean;
    start?: string; // "22:00" format
    end?: string;   // "08:00" format
  };
  projects?: Record<
    string,
    {
      path?: string;
      worktrees_root?: string;
      default_branch?: string;
      default_engine?: EngineId | string;
    }
  >;
};

export type ProjectConfig = {
  alias: string;
  path: string;
  worktreesRoot: string;
  defaultBranch: string;
  defaultEngine?: EngineId;
};

export type ResolvedConfig = {
  engine: EngineId;
  locale: string;
  timezone: string;
  globalRoot: string;
  dataRoot: string;
  telegram: {
    token?: string;
    allowlist: number[];
    ackReaction?: string;
    queueMessages: boolean;
    showCancelButton: boolean;
  };
  engines: {
    claude: {
      skipPermissions: boolean;
    };
    codex: {
      yolo: boolean;
    };
    opencode: Record<string, unknown>;
    pi: Record<string, unknown>;
  };
  heartbeat: {
    enabled: boolean;
    prompt?: string;
    file?: string;
  };
  dnd: {
    enabled: boolean;
    start: string; // "22:00" format
    end: string;   // "08:00" format
  };
  projects: Map<string, ProjectConfig>;
  paths: {
    configPath: string;
    sessionsPath: string;
    memoryRoot: string;
    sessionsRoot: string;
    skillsRoot: string;
    logsRoot: string;
    scriptsRoot: string;
    dataRoot: string;
  };
};

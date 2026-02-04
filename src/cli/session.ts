import { loadConfig } from "../config/load";
import { SessionStore } from "../sessions/store";

/**
 * Session management commands
 */
export const session = {
  /**
   * bob status - Show engine, session, context
   */
  async status(_args: string[]): Promise<void> {
    const config = await loadConfig();

    console.log("bob status\n");
    console.log(`Default engine: ${config.engine}`);
    console.log(`Config: ${config.paths.configPath}`);
    console.log(`Data: ${config.dataRoot}`);
    console.log();

    // Show chat-specific info if in a bob context
    const chatIdRaw = process.env.BOB_CHAT_ID;
    if (chatIdRaw) {
      const chatId = Number(chatIdRaw);
      if (Number.isFinite(chatId)) {
        const store = new SessionStore(config.paths.sessionsPath);
        const chatDefaultEngine = store.getDefaultEngine(chatId);

        console.log(`Chat ID: ${chatId}`);
        const threadId = process.env.BOB_THREAD_ID;
        if (threadId) {
          console.log(`Thread ID: ${threadId}`);
        }
        if (chatDefaultEngine) {
          console.log(`Chat engine: ${chatDefaultEngine}`);
        }
      }
    } else {
      console.log("Not running in a bob context (no BOB_CHAT_ID).");
    }

    console.log();
    console.log("Engine settings:");
    console.log(`  claude: skip_permissions=${config.engines.claude.skipPermissions}`);
    console.log(`  codex: yolo=${config.engines.codex.yolo}`);

    if (config.projects.size > 0) {
      console.log();
      console.log("Projects:");
      for (const [alias, project] of config.projects) {
        console.log(`  ${alias}: ${project.path}`);
      }
    }
  },
};

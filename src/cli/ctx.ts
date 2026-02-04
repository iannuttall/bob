import { loadConfig, getChatIdFromEnv } from "../config/load";
import { SessionStore } from "../sessions/store";
import { ensureWorktree, WorktreeError } from "../worktrees";

/**
 * bob ctx set <project> [@branch]
 * bob ctx clear
 * bob ctx show
 *
 * Context binding for worktrees.
 */
export async function ctx(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "show";

  if (subcommand === "help" || subcommand === "--help") {
    console.log(`Usage: bob ctx <command>

Commands:
  set <project> [@branch]     Bind chat to project/branch
  clear                       Unbind current context
  show                        Show current binding

Examples:
  bob ctx set myapp           Bind to myapp project (main branch)
  bob ctx set myapp @feature  Bind to myapp project, feature branch
  bob ctx clear               Remove binding
`);
    return;
  }

  const config = await loadConfig();
  const chatId = getChatIdFromEnv();
  const sessions = new SessionStore(config.paths.sessionsPath);

  if (subcommand === "show") {
    const context = sessions.getContext(chatId);

    console.log(`Chat ID: ${chatId}`);
    console.log();

    if (context?.project) {
      const project = config.projects.get(context.project);
      console.log(`Current context:`);
      console.log(`  Project: ${context.project}`);
      console.log(`  Branch: ${context.branch ?? project?.defaultBranch ?? "main"}`);
      if (project) {
        console.log(`  Path: ${project.path}`);
      }
    } else {
      console.log("No context bound.");
    }

    console.log();
    if (config.projects.size > 0) {
      console.log("Available projects:");
      for (const [alias, project] of config.projects) {
        console.log(`  ${alias}: ${project.path} (${project.defaultBranch})`);
      }
    } else {
      console.log("No projects configured.");
      console.log('Add projects in ~/.bob/config.toml under [projects.name]');
    }
    return;
  }

  if (subcommand === "set") {
    const projectArg = args[1];
    const branchArg = args[2]; // Optional @branch

    if (!projectArg) {
      throw new Error("Usage: bob ctx set <project> [@branch]");
    }

    const project = config.projects.get(projectArg);
    if (!project) {
      const available = Array.from(config.projects.keys()).join(", ") || "(none)";
      throw new Error(`Unknown project: ${projectArg}. Available: ${available}`);
    }

    let branch: string | null = null;
    if (branchArg?.startsWith("@")) {
      branch = branchArg.slice(1);
    }

    // If branch specified, ensure worktree exists
    if (branch) {
      try {
        const worktreePath = ensureWorktree(project, branch);
        console.log(`Worktree ready at: ${worktreePath}`);
      } catch (error) {
        if (error instanceof WorktreeError) {
          throw new Error(`Failed to create worktree: ${error.message}`);
        }
        throw error;
      }
    }

    sessions.setContext(chatId, { project: projectArg, branch });

    const effectiveBranch = branch ?? project.defaultBranch;
    console.log(`Bound chat ${chatId} to ${projectArg}@${effectiveBranch}`);
    console.log(`Project path: ${project.path}`);
    return;
  }

  if (subcommand === "clear") {
    sessions.clearContext(chatId);
    console.log(`Cleared context for chat ${chatId}`);
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  console.error('Run "bob ctx help" for usage.');
}

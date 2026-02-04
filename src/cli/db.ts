import { loadConfig } from "../config/load";

/**
 * bob db migrate
 * bob db push
 *
 * Database management commands.
 */
export async function db(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "help";

  if (subcommand === "help" || subcommand === "--help") {
    console.log(`Usage: bob db <command>

Commands:
  migrate    Run pending migrations
  push       Push schema changes (development)
  studio     Open database studio (if available)
`);
    return;
  }

  const config = await loadConfig();

  if (subcommand === "migrate") {
    console.log(`Data root: ${config.dataRoot}`);
    console.log("Database migrations are applied automatically on startup.");
    console.log("No manual migration needed.");
    return;
  }

  if (subcommand === "push") {
    console.log(`Data root: ${config.dataRoot}`);
    console.log("Schema changes are applied automatically when stores are created.");
    console.log("No manual push needed with bun:sqlite.");
    return;
  }

  if (subcommand === "studio") {
    console.log("Database studio not implemented.");
    console.log(`You can use any SQLite viewer to inspect: ${config.dataRoot}/*.db`);
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  console.error('Run "bob db help" for usage.');
}

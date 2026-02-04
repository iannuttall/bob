#!/usr/bin/env bun
/**
 * bob - AI assistant CLI with scheduling, memory, and session management
 *
 * Usage:
 *   bob schedule "1h" "check deployment"
 *   bob schedule "every day at 9am" "summarize emails"
 *   bob event "task_done" '{"result": "..."}'
 *   bob learn "important fact"
 *   bob remember "query"
 *   bob jobs list
 *   bob status
 *   bob start
 *   bob stop
 */

import { schedule } from "../src/cli/schedule";
import { event, events } from "../src/cli/events";
import { learn } from "../src/cli/learn";
import { remember } from "../src/cli/remember";
import { jobs } from "../src/cli/jobs";
import { session } from "../src/cli/session";
import { daemon } from "../src/cli/daemon";
import { ctx } from "../src/cli/ctx";
import { run } from "../src/cli/run";
import { setup } from "../src/cli/setup";
import { db } from "../src/cli/db";
import { version } from "../src/cli/version";
import { dnd } from "../src/cli/dnd";
import { syncSkills } from "../src/cli/sync-skills";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

const commands: Record<string, (args: string[]) => Promise<void>> = {
  // Scheduling
  schedule,
  jobs,

  // Events
  event,
  events,

  // Learning & Remembering
  learn,
  remember,

  // Session management
  status: session.status,

  // Context/worktrees
  ctx,

  // Daemon
  start: daemon.start,
  stop: daemon.stop,
  restart: daemon.restart,
  logs: daemon.logs,

  // Internal
  run,

  // Setup
  setup,

  // Database
  db,

  // Info
  version,

  // Do Not Disturb
  dnd,

  // Skills
  "sync-skills": syncSkills,
};

function printHelp() {
  console.log(`bob - AI assistant with scheduling and memory

Usage: bob <command> [options]

Scheduling:
  schedule <time> <prompt>    Schedule a task
  jobs list                   List scheduled jobs
  jobs remove <id>            Remove a job

Events:
  event <kind> [payload]      Emit an event
  events list                 List pending events

Learn (save to memory):
  learn <text>                Add to today's log (transient)
  learn --user <text>         Add to USER.md (permanent user facts)
  learn --pinned <text>       Add to MEMORY.md (evergreen memories)
  learn today                 Show today's log

Remember (search memory & sessions):
  remember "query"            Search memory and sessions
  remember "query" <id>       Search within a source
  remember --full <id>        Show full content
  remember --index            Index new files only
  remember --index --force    Rebuild entire index
  remember --index --embed    Also generate embeddings

Session:
  status                      Show engine, session, context

Context:
  ctx set <project> [@branch] Bind chat to project/branch
  ctx clear                   Unbind context
  ctx show                    Show current binding

Daemon:
  start                       Install and start daemon
  stop                        Stop daemon
  restart                     Restart daemon
  logs                        Tail daemon logs

Setup:
  setup                       Interactive setup wizard
  sync-skills                 Symlink bob skills to SDK directories

Database:
  db migrate                  Run pending migrations
  db push                     Push schema changes (dev)

Environment:
  BOB_CHAT_ID                 Chat ID for events (auto-injected by daemon)
  BOB_TELEGRAM_TOKEN          Telegram bot token
`);
}

async function main() {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "-v" || command === "--version") {
    await version([]);
    return;
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error('Run "bob help" for usage.');
    process.exit(1);
  }

  await handler(args.slice(1));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});

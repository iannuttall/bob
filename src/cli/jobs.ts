import { loadConfig } from "../config/load";
import { createJobStore } from "../scheduler/store";

/**
 * bob jobs list
 * bob jobs remove <id>
 */
export async function jobs(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "list";

  if (subcommand === "help" || subcommand === "--help") {
    console.log(`Usage: bob jobs <command>

Commands:
  list              List all scheduled jobs
  remove <id>       Remove a job by ID
`);
    return;
  }

  const config = await loadConfig();
  const store = createJobStore({ dataRoot: config.dataRoot });

  try {
    if (subcommand === "list") {
      const jobsList = store.listJobs();
      if (jobsList.length === 0) {
        console.log("No scheduled jobs.");
        return;
      }

      console.log("Scheduled jobs:\n");
      for (const job of jobsList) {
        const status = job.enabled ? "enabled" : "disabled";
        const next = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "-";
        const last = job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "-";
        const payload = job.payload as { prompt?: string; text?: string };
        const desc = payload.prompt ?? payload.text ?? job.jobType;
        const preview = desc.length > 50 ? `${desc.slice(0, 50)}...` : desc;

        console.log(`#${job.id} [${status}]`);
        console.log(`  Schedule: ${job.scheduleKind} ${job.scheduleSpec}`);
        console.log(`  Type: ${job.jobType}`);
        console.log(`  Chat: ${job.chatId}${job.threadId ? ` (thread ${job.threadId})` : ""}`);
        console.log(`  Next: ${next}`);
        console.log(`  Last: ${last}`);
        console.log(`  Desc: ${preview}`);
        console.log();
      }
      return;
    }

    if (subcommand === "remove") {
      const idStr = args[1];
      if (!idStr) {
        throw new Error("Usage: bob jobs remove <id>");
      }
      const id = Number(idStr);
      if (!Number.isFinite(id)) {
        throw new Error(`Invalid job ID: ${idStr}`);
      }

      const removed = store.removeJob(id);
      if (removed) {
        console.log(`Removed job #${id}`);
      } else {
        console.log(`No job found with ID ${id}`);
      }
      return;
    }

    console.error(`Unknown subcommand: ${subcommand}`);
    console.error('Run "bob jobs help" for usage.');
  } finally {
    store.close();
  }
}

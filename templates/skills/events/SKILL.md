---
name: events
description: use when writing background scripts that need to notify you on completion or failure, or when you need to wake yourself up immediately from an external trigger. triggers include "background task", "script finished", "notify on complete", "wake me when done", "event hook", "callback", "on error", "on success", and similar.
---

# events

use events to wake yourself up from background scripts or external triggers.

## emit an event
always include `--chat-id <id>` using the chat_id from your current session.

`bun bob event --chat-id <id> "task_done" '{"result": "..."}'` - signal success
`bun bob event --chat-id <id> "task_failed" '{"error": "..."}'` - signal failure
`bun bob event --chat-id <id> "custom_event" '{"data": "..."}'` - any custom event

## in scripts
when writing scripts, hardcode the chat_id so it knows where to send the event.

```typescript
const CHAT_ID = 123456; // from current session

try {
  const result = await doSomething();
  await $`bun bob event --chat-id ${CHAT_ID} "task_done" '{"result": "${result}"}'`;
} catch (err) {
  await $`bun bob event --chat-id ${CHAT_ID} "task_failed" '{"error": "${err.message}"}'`;
}
```

## list pending events
`bun bob events list` - see unprocessed events

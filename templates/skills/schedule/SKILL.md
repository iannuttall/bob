---
name: schedule
description: use when you need to set a reminder, schedule a task for later, create recurring jobs, check back on something in the future, or wake yourself up at a specific time. triggers include "remind me", "in an hour", "tomorrow", "every day", "later", "follow up", "check back", "schedule", "timer", "alarm", "recurring", "cron", and similar.
---

# scheduling

## schedule a task

the `--chat-id` is auto-provided when running in bob context. use the chat_id from your current session info.

**options:**
- `--chat-id <id>` - target chat (required, use BOB_CHAT_ID from session)
- `--quote "text"` - original user message to quote when delivering (use for follow-ups)
- `--reply-to <id>` - message ID to reply to (use BOB_MESSAGE_ID from session)

**one-time delays:**
- `bun bob schedule --chat-id <id> "3m" "check on this"`
- `bun bob schedule --chat-id <id> "1h" "follow up"`
- `bun bob schedule --chat-id <id> "in 30 minutes" "reminder"`

**exact times:**
- `bun bob schedule --chat-id <id> "8:05am" "wake up"` - today (or tomorrow if passed)
- `bun bob schedule --chat-id <id> "3pm" "meeting"`
- `bun bob schedule --chat-id <id> "tomorrow at 8am" "review"`

**recurring:**
- `bun bob schedule --chat-id <id> "every day at 9am" "daily standup"`
- `bun bob schedule --chat-id <id> "every monday at 10am" "weekly review"`
- `bun bob schedule --chat-id <id> "cron 0 9 * * *" "backup"`

**with quote-reply (for follow-ups):**
```bash
bun bob schedule --chat-id <id> --quote "user's original request" --reply-to <msg_id> "1h" "follow up on this"
```
when the reminder fires, you'll see both the reminder prompt and the quoted original message, and the reply will thread under the original.

**when to use quote-reply:**
- use for follow-ups where the user needs context about what they asked
- skip if the reminder is self-explanatory (e.g., "daily standup")
- skip if the original message was recent (last 3 messages) and context is obvious
- the goal is to help the user remember what they asked, not spam them with quotes

## manage jobs
- `bun bob jobs list` - list all scheduled jobs
- `bun bob jobs remove <id>` - remove a job

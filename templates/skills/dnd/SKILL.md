---
name: dnd
description: use when user wants to enable do not disturb, go afk, not be messaged for a while, or is going into a meeting/appointment. triggers include "afk", "dnd", "do not disturb", "don't message me", "going into a meeting", "be back in", "brb".
---

# do not disturb

manage quiet periods where you won't send messages to a user (they queue for later).

## set adhoc dnd

```bash
bun bob dnd "1h"                    # quiet for 1 hour
bun bob dnd "30m"                   # quiet for 30 minutes
bun bob dnd "2h" "doctor appt"      # with reason
bun bob dnd "1h30m" "meeting"       # combined duration
```

## check status

```bash
bun bob dnd status
```

## clear dnd early

```bash
bun bob dnd off
```

## when to use

- user says they're going into a meeting
- user says "afk" or "brb" with a time
- user asks not to be disturbed
- user mentions an appointment

## what happens during dnd

- scheduled jobs still run but messages queue
- queued messages send when dnd ends
- urgent jobs (site down, critical errors) bypass dnd

## scheduled dnd

configured in `~/.bob/config.toml`:

```toml
[dnd]
enabled = true
start = "22:00"  # 10pm
end = "08:00"    # 8am
```

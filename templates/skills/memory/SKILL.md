---
name: memory
description: use when you need to remember something, recall past decisions, look up what the user told you before, store preferences, save important facts, or search your memory for context. triggers include "learn", "remember", "forget", "recall", "what did i say", "did i mention", "store", "save", "memory", "notes", "log", and similar.
---

# memory

your memory is what makes you "you". proactively store things you learn - don't wait to be asked.

## storage structure

```
~/.bob/memory/
├── USER.md                      # who the user is (permanent)
├── MEMORY.md                    # evergreen facts & decisions
├── journal/
│   └── 2026/
│       └── 02-03.md             # daily notes (transient)
└── conversations/
    └── 2026/
        ├── 02-03-claude.md      # today's chats (auto)
        └── 02-03-codex.md
```

## what goes where

| file | what | examples |
|------|------|----------|
| USER.md | permanent facts about user | name, location, job, timezone, communication style |
| MEMORY.md | evergreen facts & decisions | "use sqlite", "project uses bun", "prefers minimal UI" |
| journal/ | daily notes (transient) | "debugging telegram", "user mentioned trip next week" |
| conversations/ | raw chat history | (automatic - you don't write here) |

## when to proactively learn

store memories WITHOUT being asked when:
- user mentions name, location, job, preferences → USER.md
- user shares communication style → USER.md
- you make a decision together → MEMORY.md
- you discover something about a project → MEMORY.md
- user mentions something temporary (trip, deadline) → journal
- a pattern emerges from conversations → MEMORY.md

## how to write

**USER.md and MEMORY.md**: edit directly - read, find section, add/update. these are yours to organize.

**journal**: use CLI (append-only timestamped):
```bash
bun bob learn "discussed auth options"     # today's journal
bun bob learn --user "fact"                # append to USER.md
bun bob learn --pinned "decision"          # append to MEMORY.md
bun bob learn today                        # show today's journal
```

## how to search

```bash
bun bob remember "query"                   # search everything (hybrid FTS + vector)
bun bob remember --full memory:user        # show USER.md
bun bob remember --full journal:2026/02-03 # show specific journal
bun bob remember --index                   # re-index after adding content
```

you can also grep files directly at `~/.bob/memory/`.

## memory lifecycle

```
conversation → auto-logged to conversations/
notice something → bun bob learn "note" → journal/
pattern emerges → edit MEMORY.md
learn about user → edit USER.md
```

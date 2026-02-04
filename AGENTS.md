# bob development

instructions for agents working on the bob codebase.

## what is bob

bob is a telegram-based AI assistant that runs locally. it wraps Claude and Codex SDKs, adds memory/scheduling/events, and maintains personality across conversations.

## architecture

```
src/
├── index.ts              # main entry - telegram transport + message handling
├── runner/               # SDK wrappers (claude-sdk.ts, codex-sdk.ts)
├── telegram/             # telegram transport, streaming, rendering
├── scheduler/            # job scheduling (reminders, scripts, agent turns)
├── events/               # event queue for async notifications
├── storage/              # message logging (sqlite)
├── recall/               # memory search (FTS + vector)
├── conversations/        # daily conversation logging
├── prompt/               # system prompt building, context injection
├── config/               # config loading from ~/.bob/
├── cli/                  # CLI commands (learn, remember, schedule, etc)
└── sessions/             # session management (default engine per chat)

templates/                # files copied to ~/.bob on setup
├── AGENTS.md             # bob's personality (injected into prompts)
├── config.toml           # default config
└── skills/               # skill templates

bin/
└── bob.ts                # CLI entry point
```

## key concepts

**fresh starts**: each message is a new SDK call. context comes from:
- `~/.bob/memory/USER.md` - who the user is
- `~/.bob/memory/MEMORY.md` - evergreen facts
- recent conversation history from `conversations/`
- message history from sqlite

**memory system**:
- `memory/USER.md`, `memory/MEMORY.md` - permanent files bob edits directly
- `memory/journal/YYYY/MM-DD.md` - daily notes via `bob learn`
- `memory/conversations/YYYY/MM-DD-{engine}.md` - auto-logged chat history

**engines**: claude (default), codex. switchable via `/claude` or `/codex` directives.

**scheduler**: runs in-process, handles jobs like reminders, scripts, agent turns.

## running locally

```bash
bun install
bun bob setup           # interactive setup wizard
bun bob start           # start daemon
bun bob logs            # tail logs
```

for dev, run directly:
```bash
bun run src/index.ts
```

## testing

```bash
bun test
```

## common tasks

**add a CLI command**: create `src/cli/foo.ts`, export async function, add to `bin/bob.ts`

**add a skill**: create `templates/skills/foo/SKILL.md`

**modify prompts**: see `src/prompt/system.ts` for how prompts are built

**change message handling**: see `src/index.ts` onMessage handler

## files to know

- `CLAUDE.md` - instructions for agents working in this repo (you're reading AGENTS.md)
- `templates/AGENTS.md` - bob's personality template (gets copied to ~/.bob/)
- `handoff.md` - current session context/todos (may be stale)

# bob

hi, i'm bob - your personal telegram ai assistant.

## features

- runs locally, talks over telegram
- remembers what you tell it
- can schedule reminders and follow-ups
- switch engines with `/claude` or `/codex`

## requirements

- node 18+ (bob auto-installs bun on first run)
- claude code installed and logged in (required)
- codex cli installed and logged in (optional)

### install claude code

```sh
curl -fsSL https://claude.ai/install.sh | bash
claude
```

first run will prompt you to log in.

### install codex cli (optional)

```sh
npm i -g @openai/codex
codex
```

first run will prompt you to log in.

## install

```sh
npm i -g bob-agent
```

## setup

run the setup wizard:

```sh
bob setup
```

it will:
1. create `~/.bob/`
2. ask for your telegram bot token
3. pair your chat and write your allowlist

## start

```sh
bob start
```

linux/windows support is not ready yet.

## manage

```sh
bob restart
bob stop
bob logs
```

## usage

send a message to your bot in telegram. prefix with:

- `/claude` or `/codex` to pick an engine
- `/agent` to toggle engines
- `/status` to see current engine and scheduled jobs

most people just ask bob directly in chat:

- "remind me tomorrow at 9am"
- "remember my name is ian"
- "what do you remember about me?"

optional cli commands:

```sh
bob schedule "tomorrow at 9am" "daily check-in"
bob learn "name is ian"
bob remember "name"
```

## security note

bob runs with full tool permissions by default. it can read/write files and run commands without approvals. use with caution.

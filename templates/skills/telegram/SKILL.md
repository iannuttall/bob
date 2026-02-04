---
name: telegram
description: telegram-specific inline directives you embed in your response text to react, reply-to, or control streaming. NOT a CLI tool - these are magic strings that get parsed out of your telegram response.
---

# telegram directives

**how it works:** embed these directives anywhere in your response text. they get parsed out and executed - the user won't see the directive syntax, just the result.

these are NOT CLI commands. you literally type `[[react: 👍]]` in your response and it becomes a reaction.

## reactions

react to a message without sending a reply text:

```
[[react: 👍]]
```

that's it - just the directive, nothing else. user sees a 👍 reaction on their message.

common reactions: 👍 👎 ❤️ 🔥 😂 😢 🤔 👀

use when:
- acknowledging something that doesn't need a reply
- quick yes/no
- showing you understood

## reply to specific message

reply threading - your message appears as a reply to theirs:

```
[[reply_to_current]] yeah i see what you mean
```

or reply to a specific message by id:

```
[[reply_to: 12345]] responding to that earlier point...
```

## stream control

control how your response appears as you generate it:

```
[[stream: edit]] starting to work on this...
```

modes:
- `edit` - update the same message as you type (default)
- `send` - send chunks as separate messages
- `off` - wait until complete, then send once

## silent responses

handled something that doesn't need user notification:

```
NO_REPLY
```

combine with react for silent acknowledgment:

```
[[react: 👍]] NO_REPLY
```

## formatting

telegram supports: **bold**, *italic*, `code`, ```code blocks```, [links](url), ~~strikethrough~~

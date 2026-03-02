# 🦞 OpenClaw — Personal AI Assistant

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.png">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <strong>EXFOLIATE! EXFOLIATE!</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**OpenClaw** is a _personal AI assistant_ you run on your own devices. It answers you on the channels you already use (WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, Microsoft Teams, WebChat), plus extension channels like BlueBubbles, Matrix, Zalo, and Zalo Personal. It can speak and listen on macOS/iOS/Android, and can render a live Canvas you control.

This fork adds a **Telegram Manager Module** — a full userbot/bot automation system for Telegram user accounts and bot accounts, with AI auto-reply, monitoring, broadcasting, and parsing behaviors.

[Website](https://openclaw.ai) · [Docs](https://docs.openclaw.ai) · [Getting Started](https://docs.openclaw.ai/start/getting-started) · [Discord](https://discord.gg/clawd)

---

## Changes from upstream openclaw

This fork adds the following on top of the original openclaw:

| Change                                                          | Location                       |
| --------------------------------------------------------------- | ------------------------------ |
| **Telegram Manager Module** (userbot + bot agents, 4 behaviors) | `extensions/telegram-manager/` |
| `ui/src/ui/app-render.ts` — minor UI render adjustments         | `ui/src/ui/app-render.ts`      |

Everything else is the original openclaw codebase. To pull upstream updates:

```bash
git remote add upstream https://github.com/openclaw/openclaw.git
git fetch upstream
git rebase upstream/main
```

---

## Install (recommended)

Runtime: **Node ≥22**.

```bash
npm install -g openclaw@latest
# or: pnpm add -g openclaw@latest

openclaw onboard --install-daemon
```

## Quick start

```bash
openclaw onboard --install-daemon
openclaw gateway --port 18789 --verbose

# Send a message
openclaw message send --to +1234567890 --message "Hello from OpenClaw"

# Run the AI agent
openclaw agent --message "Ship checklist" --thinking high
```

---

## Telegram Manager Module

> **Location:** `extensions/telegram-manager/`
> **Type:** OpenClaw plugin extension
> **Adds:** Telegram user account automation (userbot) and bot account automation

### What it does

The Telegram Manager adds two kinds of agents to OpenClaw:

| Agent type  | What it is                             | Requires                                       |
| ----------- | -------------------------------------- | ---------------------------------------------- |
| **UserBot** | Runs as your personal Telegram account | `TG_API_ID`, `TG_API_HASH`, phone number + OTP |
| **Bot**     | Runs as a Telegram bot service account | Bot token from @BotFather                      |

Each agent can run one or more **behaviors** simultaneously:

| Behavior     | What it does                                                         |
| ------------ | -------------------------------------------------------------------- |
| `auto_reply` | Watches incoming messages and replies automatically (AI or template) |
| `monitor`    | Watches specific chats for keywords, saves to DB or POSTs to webhook |
| `broadcast`  | Sends a message to multiple chats (one-time or on a cron schedule)   |
| `parser`     | Scrapes historical messages and/or member lists from chats           |

### Architecture

```
OpenClaw Gateway :18792
├── Browser Relay  /extension?token=…  (existing, unchanged)
└── Telegram Plugin /telegram/…        (new)
        │
        ├── AgentManager
        │     ├── UserBotAgent  (telegram-cli / GramJS)
        │     └── BotAgent      (grammY)
        ├── TelegramStorage     (~/.openclaw/data/telegram/)
        └── WebSocket protocol  telegram.*
```

Agents emit events to all connected WebSocket clients (`telegram.event`). You can drive agents imperatively via `telegram.tool.call`.

### Setup

#### 1. Get Telegram API credentials

Go to [my.telegram.org](https://my.telegram.org) → API development tools → create an app. Copy **App api_id** and **App api_hash**.

#### 2. Set environment variables

```bash
export TG_API_ID=12345678
export TG_API_HASH=abcdef1234567890abcdef1234567890
export ANTHROPIC_API_KEY=sk-ant-...   # only needed for ai-mode auto_reply
```

Add these to `~/.profile` or `~/.zshrc` so they persist.

#### 3. Load the plugin

In your gateway entry point (`gateway/src/index.ts` or equivalent) add:

```typescript
import { TelegramPlugin } from "../../extensions/telegram-manager/src/TelegramPlugin";

const telegramPlugin = new TelegramPlugin();
gateway.registerPlugin(telegramPlugin);
```

#### 4. Authenticate a userbot agent

Via WebSocket:

```jsonc
// Step 1: create the agent record
{ "method": "telegram.agent.create", "id": 1, "params": {
    "name": "my-account",
    "credentials": { "type": "userbot", "phoneNumber": "+79991234567" }
}}

// Step 2: send OTP to the phone
{ "method": "telegram.agent.authStart", "id": 2, "params": { "agentId": "<id from step 1>" }}

// Step 3: submit the OTP (and optional 2FA password)
{ "method": "telegram.agent.authSubmit", "id": 3, "params": {
    "agentId": "<id>", "code": "12345", "password": "optional2fa"
}}

// Step 4: start the agent
{ "method": "telegram.agent.start", "id": 4, "params": { "agentId": "<id>" }}
```

Session string is saved automatically — subsequent starts do not need re-auth.

#### 5. Add a bot agent (no auth flow needed)

```jsonc
{ "method": "telegram.agent.create", "id": 1, "params": {
    "name": "my-bot",
    "credentials": { "type": "bot", "token": "123456:ABC-your-bot-token" }
}}
{ "method": "telegram.agent.start", "id": 2, "params": { "agentId": "<id>" }}
```

---

### Behaviors reference

#### `auto_reply`

Replies to incoming messages automatically.

```jsonc
{
  "type": "auto_reply",
  "enabled": true,
  "replyMode": "ai", // "ai" | "template"
  "aiSystemPrompt": "You are a helpful assistant.",
  "triggerKeywords": ["help", "support"], // optional — only reply if text contains one of these
  "onlyInChats": ["-1001234567890"], // optional — limit to specific chat IDs
  "cooldownSeconds": 10, // min seconds between replies to same chat
}
```

Template mode (no AI key needed):

```jsonc
{
  "type": "auto_reply",
  "enabled": true,
  "replyMode": "template",
  "templates": [
    { "trigger": "price", "response": "Our price is $99/month." },
    { "trigger": "hello", "response": "Hi! How can I help?" },
  ],
}
```

#### `monitor`

Watches chats for messages matching keyword filters.

```jsonc
{
  "type": "monitor",
  "enabled": true,
  "targets": ["-1001234567890", "some_channel_username"],
  "filters": {
    "keywords": ["bitcoin", "crypto"], // optional
    "hasMedia": false, // optional — only media messages
  },
  "saveToDb": true, // save matched messages to local SQLite
  "webhookUrl": "https://your-server.com/hook", // POST matched items here
}
```

Webhook payload format:

```jsonc
{
  "agentId": "abc",
  "agentName": "my-account",
  "type": "monitor",
  "item": {
    "chatId": "-1001234567890",
    "messageId": 12345,
    "text": "message text (max 4096 chars)",
    "date": "2026-03-02T09:00:00.000Z",
    "hasMedia": false,
  },
}
```

#### `broadcast`

Sends a message to multiple chats.

```jsonc
{
  "type": "broadcast",
  "enabled": true,
  "targets": ["-1001234567890", "+79991234567"],
  "message": "<b>Hello!</b> This is a broadcast.",
  "parseMode": "html", // "html" | "markdown"
  "schedule": "0 9 * * 1-5", // cron — omit for immediate one-shot
  "delayBetweenMs": 2000, // ms delay between each send
  "onlyOnce": false, // if true, disables behavior after first run
}
```

Cron examples: `"0 9 * * *"` = every day at 9:00, `"*/30 * * * *"` = every 30 minutes.

#### `parser`

Scrapes historical data from chats (runs once on agent start with `parser` behavior enabled).

```jsonc
{
  "type": "parser",
  "enabled": true,
  "targets": ["-1001234567890"],
  "parseMessages": true, // scrape message history
  "parseMembers": true, // scrape participant list
  "limit": 200, // max items per target
  "saveToDb": true,
  "webhookUrl": "https://your-server.com/hook",
}
```

---

### WebSocket API reference

All methods follow JSON-RPC style: `{ "method": "...", "id": N, "params": {...} }`.

#### Agent management

| Method                        | Params                              | Returns             |
| ----------------------------- | ----------------------------------- | ------------------- |
| `telegram.agent.list`         | —                                   | `AgentRecord[]`     |
| `telegram.agent.get`          | `agentId`                           | `AgentRecord`       |
| `telegram.agent.create`       | `name`, `credentials`, `behaviors?` | `AgentRecord`       |
| `telegram.agent.delete`       | `agentId`                           | `{ deleted: true }` |
| `telegram.agent.start`        | `agentId`                           | `AgentRecord`       |
| `telegram.agent.stop`         | `agentId`                           | `AgentRecord`       |
| `telegram.agent.restart`      | `agentId`                           | `AgentRecord`       |
| `telegram.agent.setBehaviors` | `agentId`, `behaviors`              | `AgentRecord`       |
| `telegram.agent.authStart`    | `agentId`                           | —                   |
| `telegram.agent.authSubmit`   | `agentId`, `code`, `password?`      | —                   |

#### Tool calls (imperative actions)

```jsonc
{
  "method": "telegram.tool.call",
  "id": 1,
  "params": {
    "agentId": "<id>",
    "tool": "sendMessage",
    "args": { "target": "+79991234567", "message": "Hello!" },
  },
}
```

Available tools:

| Tool          | Args                              | Description                |
| ------------- | --------------------------------- | -------------------------- |
| `sendMessage` | `target`, `message`, `parseMode?` | Send a message             |
| `getMessages` | `target`, `limit?`                | Fetch message history      |
| `getMembers`  | `target`, `limit?`                | List chat participants     |
| `joinChat`    | `target`                          | Join a public chat/channel |
| `leaveChat`   | `target`                          | Leave a chat               |
| `getMe`       | —                                 | Get current account info   |

#### Push events (server → client)

```jsonc
{ "method": "telegram.event", "params": {
    "agentId": "abc",
    "agentName": "my-account",
    "type": "message_in",   // message_in | message_out | parsed_item | status_change | error
    "payload": { ... },
    "timestamp": "2026-03-02T09:00:00.000Z"
}}
```

---

### Data storage

All agent data is stored in `~/.openclaw/data/telegram/` as SQLite:

- Agent records (credentials, behaviors, stats)
- Session strings (encrypted in memory, persisted to DB)
- Parsed messages/members (when `saveToDb: true`)

---

## Plugins and Skills configuration

### Obsidian skill

The Obsidian skill lets the AI agent work with your Obsidian vault (read, create, search, move notes).

**Requirements:** `obsidian-cli` binary.

```bash
brew install yakitrak/yakitrak/obsidian-cli
```

**Set default vault** (run once):

```bash
obsidian-cli set-default "My Vault"       # use your vault folder name
obsidian-cli print-default --path-only    # verify
```

The skill reads vault configuration from:
`~/Library/Application Support/obsidian/obsidian.json`

**Enable in OpenClaw:**

```bash
openclaw skills install obsidian
```

Or in config (`~/.openclaw/config.json`):

```json
{
  "skills": ["obsidian"]
}
```

**What the skill can do:**

| Action               | Command                                                       |
| -------------------- | ------------------------------------------------------------- |
| Search notes by name | `obsidian-cli search "query"`                                 |
| Search inside notes  | `obsidian-cli search-content "query"`                         |
| Create a note        | `obsidian-cli create "Folder/Note" --content "..."`           |
| Move/rename note     | `obsidian-cli move "old/path" "new/path"` (updates wikilinks) |
| Delete note          | `obsidian-cli delete "path/note"`                             |

### Other built-in skills

Enable any skill via `openclaw skills install <name>` or list available skills:

```bash
openclaw skills list
openclaw skills install github        # GitHub issues/PRs
openclaw skills install notion        # Notion pages/databases
openclaw skills install slack         # Slack actions
openclaw skills install discord       # Discord actions
openclaw skills install apple-notes   # Apple Notes
openclaw skills install spotify-player
openclaw skills install trello
openclaw skills install things-mac    # Things 3 (macOS)
openclaw skills install 1password     # 1Password
openclaw skills install peekaboo      # macOS screenshot
openclaw skills install tmux          # tmux session control
openclaw skills install gh-issues     # GitHub Issues
openclaw skills install weather
```

### Extension plugins

Extensions are workspace packages under `extensions/`. They extend channels, memory, and AI providers:

**Channel extensions:**

```bash
# Install a channel extension (example: Microsoft Teams)
openclaw extensions install msteams

# Available channel extensions:
# bluebubbles, discord, feishu, googlechat, imessage, irc, line,
# matrix, mattermost, msteams, nextcloud-talk, signal, slack,
# synology-chat, telegram, tlon, twitch, whatsapp, zalo, zalouser
```

**Memory extensions:**

```bash
openclaw extensions install memory-core      # core memory system
openclaw extensions install memory-lancedb   # vector search memory
```

**AI provider extensions:**

```bash
openclaw extensions install google-gemini-cli-auth   # Google Gemini via CLI auth
openclaw extensions install minimax-portal-auth       # MiniMax
openclaw extensions install qwen-portal-auth          # Alibaba Qwen
openclaw extensions install copilot-proxy             # GitHub Copilot proxy
```

**Utility extensions:**

```bash
openclaw extensions install voice-call     # voice call support
openclaw extensions install llm-task       # background LLM tasks
openclaw extensions install phone-control  # phone automation
openclaw extensions install nostr          # Nostr protocol
openclaw extensions install open-prose     # long-form writing assistant
```

---

## Core platform (original openclaw)

### Install

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

### From source

```bash
git clone https://github.com/Secret297-CODER-SOURCE/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm openclaw onboard --install-daemon

# Dev loop
pnpm gateway:watch
```

### Channels

WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, BlueBubbles (iMessage), iMessage (legacy), Microsoft Teams, Matrix, Zalo, Zalo Personal, WebChat.

### Security defaults

- **DM pairing** is on by default — unknown senders receive a pairing code.
- Approve: `openclaw pairing approve <channel> <code>`
- Open DMs: set `dmPolicy="open"` in config.

Run `openclaw doctor` to surface misconfigured policies.

### Architecture

```
WhatsApp / Telegram / Slack / Discord / ...
               │
               ▼
┌──────────────────────────────┐
│           Gateway            │
│      ws://127.0.0.1:18789    │
└──────────────┬───────────────┘
               │
               ├─ Pi agent (RPC)
               ├─ CLI (openclaw …)
               ├─ Telegram Manager Plugin
               ├─ WebChat UI
               ├─ macOS app
               └─ iOS / Android nodes
```

### Development channels

- **stable**: tagged releases (`vYYYY.M.D`), npm dist-tag `latest`
- **beta**: prerelease tags (`vYYYY.M.D-beta.N`), npm dist-tag `beta`
- **dev**: moving head of `main`

```bash
openclaw update --channel stable|beta|dev
```

### Build & test

```bash
pnpm install
pnpm build           # TypeScript compile
pnpm tsgo            # type-check
pnpm check           # lint + format
pnpm test            # vitest
pnpm test:coverage
```

---

## Sponsors

| OpenAI                                                            | Blacksmith                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [![OpenAI](docs/assets/sponsors/openai.svg)](https://openai.com/) | [![Blacksmith](docs/assets/sponsors/blacksmith.svg)](https://blacksmith.sh/) |

---

## License

MIT — see [LICENSE](LICENSE).

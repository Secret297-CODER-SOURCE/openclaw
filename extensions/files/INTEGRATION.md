# OpenClaw — Telegram Plugin

Интеграция Telegram-агентов в OpenClaw Gateway.

## Как работает интеграция

```
┌───────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway :18792                     │
│                                                               │
│  ┌──────────────────────┐   ┌──────────────────────────────┐  │
│  │  Browser Relay       │   │  Telegram Plugin (NEW)       │  │
│  │  /extension?token=…  │   │  /telegram/…                 │  │
│  │                      │   │                              │  │
│  │  WS: forwardCDP*     │   │  WS: telegram.*              │  │
│  │  tab attach/detach   │   │  agent create/start/stop     │  │
│  └──────────────────────┘   │  behaviors CRUD              │  │
│                              │  tools: send, parse, monitor │  │
│                              └──────────────────────────────┘  │
│                                                               │
│  Shared: auth token, logger, plugin registry                  │
└───────────────────────────────────────────────────────────────┘
         ↑                              ↑
    Chrome Extension               OpenClaw App / API clients
    (existing, unchanged)          (new Telegram UI tab)
```

## Структура файлов (добавляется в репо OpenClaw)

```
plugins/
└── telegram/
    ├── package.json
    ├── INTEGRATION.md          ← этот файл
    └── src/
        ├── index.ts            ← точка входа плагина
        ├── TelegramPlugin.ts   ← регистрация в Gateway
        ├── agents/
        │   ├── BaseAgent.ts
        │   ├── UserBotAgent.ts
        │   ├── BotAgent.ts
        │   └── AgentManager.ts
        ├── behaviors/
        │   └── AiReplyEngine.ts
        ├── storage/
        │   └── TelegramStorage.ts
        └── tools/
            └── TelegramTools.ts  ← OpenClaw Tool API

gateway/                    ← существующий Gateway
└── src/
    └── index.ts            ← добавить: loadPlugin(telegramPlugin)
```

## Подключение к существующему Gateway

В `gateway/src/index.ts` добавить:

```typescript
import { TelegramPlugin } from "../../plugins/telegram/src/TelegramPlugin";

const telegramPlugin = new TelegramPlugin({ gatewayToken, logger, db });
gateway.registerPlugin(telegramPlugin);
```

## WebSocket протокол (расширение существующего)

Telegram-плагин добавляет новые методы поверх существующего протокола:

```json
// Создать агента
{ "method": "telegram.agent.create", "id": 1, "params": { "name": "bot1", "credentials": {...} } }

// Запустить агента
{ "method": "telegram.agent.start", "id": 2, "params": { "agentId": "abc" } }

// Обновить поведения
{ "method": "telegram.agent.setBehaviors", "id": 3, "params": { "agentId": "abc", "behaviors": [...] } }

// Вызвать инструмент (как CDP-команда, но для TG)
{ "method": "telegram.tool.call", "id": 4, "params": { "agentId": "abc", "tool": "sendMessage", "args": {...} } }

// Push-события от агентов (сервер → клиент, без id)
{ "method": "telegram.event", "params": { "agentId": "...", "type": "message", "payload": {...} } }
```

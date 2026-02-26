# OpenClaw — Telegram Plugin

Нативная интеграция Telegram-агентов в OpenClaw Gateway.  
Работает на том же порту, с тем же токеном, по тому же WebSocket-протоколу — как полноценное расширение, а не сторонний сервис.

---

## Как устроена интеграция

```
OpenClaw Gateway (порт 18792)
├── /extension?token=…   ← Chrome Extension (существующий, без изменений)
├── /telegram/…          ← REST API плагина (новое)
└── WS: все методы       ← Browser CDP + telegram.* (добавлено)

WS-протокол (расширение существующего):
  telegram.agent.list / .get / .create / .delete
  telegram.agent.start / .stop / .restart
  telegram.agent.setBehaviors
  telegram.agent.authStart / .authSubmit    ← логин userbot через API
  telegram.tool.call                        ← imperative tool calls
  telegram.events.get / telegram.parsed.get
  telegram.event  ← push от агентов (сервер → клиент)
```

---

## Установка

### 1. Добавить плагин в репо OpenClaw

```bash
# В корне openclaw:
cp -r plugins/telegram ./plugins/telegram
cd plugins/telegram && npm install && npm run build
```

### 2. Добавить переменные среды (`.env` или `OPENCLAW_GATEWAY_TOKEN` уже есть)

```env
TG_API_ID=12345678
TG_API_HASH=abcdef...
ANTHROPIC_API_KEY=sk-ant-...   # для AI авто-ответов
```

### 3. Подключить в Gateway (одна строка)

```typescript
// gateway/src/index.ts
import { TelegramPlugin } from "../../plugins/telegram/src";

// В main():
gateway.registerPlugin(new TelegramPlugin());
```

Смотри `gateway-integration-patch.ts` для полного примера.

---

## Использование через WebSocket

```javascript
// Тот же WS что и для CDP, с тем же gateway token
const ws = new WebSocket("ws://localhost:18792/extension?token=YOUR_TOKEN");

// ── Создать бота ──────────────────────────────────────────────────────────
ws.send(
  JSON.stringify({
    id: 1,
    method: "telegram.agent.create",
    params: {
      name: "Support Bot",
      credentials: { type: "bot", token: "123:ABC..." },
      behaviors: [
        {
          type: "auto_reply",
          enabled: true,
          replyMode: "ai",
          aiSystemPrompt: "You are a helpful support agent. Reply in Russian.",
        },
      ],
    },
  }),
);

// ── Запустить ─────────────────────────────────────────────────────────────
ws.send(
  JSON.stringify({
    id: 2,
    method: "telegram.agent.start",
    params: { agentId: "<id from response>" },
  }),
);

// ── Создать Userbot ───────────────────────────────────────────────────────
ws.send(
  JSON.stringify({
    id: 3,
    method: "telegram.agent.create",
    params: { name: "Parser", credentials: { type: "userbot", phoneNumber: "+79001234567" } },
  }),
);

// ── Авторизовать userbot ──────────────────────────────────────────────────
ws.send(JSON.stringify({ id: 4, method: "telegram.agent.authStart", params: { agentId: "<id>" } }));
// → Telegram пришлёт код на телефон
ws.send(
  JSON.stringify({
    id: 5,
    method: "telegram.agent.authSubmit",
    params: { agentId: "<id>", code: "12345" },
  }),
);

// ── Горячая замена поведений ──────────────────────────────────────────────
ws.send(
  JSON.stringify({
    id: 6,
    method: "telegram.agent.setBehaviors",
    params: {
      agentId: "<id>",
      behaviors: [
        {
          type: "monitor",
          enabled: true,
          targets: ["@durov", "@telegram"],
          filters: { keywords: ["update", "new"] },
          saveToDb: true,
        },
        {
          type: "broadcast",
          enabled: true,
          schedule: "0 9 * * 1-5",
          targets: ["@mychannel"],
          message: "<b>Утренний дайджест</b>",
        },
      ],
    },
  }),
);

// ── Вызвать инструмент напрямую ───────────────────────────────────────────
ws.send(
  JSON.stringify({
    id: 7,
    method: "telegram.tool.call",
    params: {
      agentId: "<id>",
      tool: "sendMessage",
      args: { target: "@username", message: "Hello from OpenClaw!", parseMode: "html" },
    },
  }),
);

// ── Получать события в реальном времени ───────────────────────────────────
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method === "telegram.event") {
    const { agentId, agentName, type, payload } = msg.params;
    console.log(`[${agentName}] ${type}`, payload);
    // type: 'message_in' | 'message_out' | 'parsed_item' | 'status_change' | 'error'
  }
};
```

---

## REST API (для HTTP-клиентов)

Все маршруты защищены тем же токеном OpenClaw (`x-openclaw-relay-token`).

```
GET    /telegram/agents                 — список агентов
POST   /telegram/agents                 — создать агента
GET    /telegram/agents/:id             — получить агента
DELETE /telegram/agents/:id             — удалить агента
POST   /telegram/agents/:id/start       — запустить
POST   /telegram/agents/:id/stop        — остановить
POST   /telegram/agents/:id/restart     — перезапустить
PUT    /telegram/agents/:id/behaviors   — обновить поведения
POST   /telegram/agents/:id/auth/start  — начать авторизацию userbot
POST   /telegram/agents/:id/auth/submit — подтвердить код
POST   /telegram/agents/:id/tool        — вызвать инструмент
GET    /telegram/agents/:id/events      — история событий
GET    /telegram/agents/:id/parsed      — собранные данные
```

---

## Доступные инструменты (telegram.tool.call)

| tool          | Тип агента | Аргументы                        | Описание            |
| ------------- | ---------- | -------------------------------- | ------------------- |
| `sendMessage` | оба        | `{ target, message, parseMode }` | Отправить сообщение |
| `getMessages` | userbot    | `{ target, limit }`              | Получить сообщения  |
| `getMembers`  | userbot    | `{ target, limit }`              | Получить участников |
| `joinChat`    | userbot    | `{ target }`                     | Вступить в чат      |
| `leaveChat`   | userbot    | `{ target }`                     | Выйти из чата       |
| `getMe`       | оба        | `{}`                             | Информация о себе   |

---

## Поведения (behaviors)

### `auto_reply` — автоответы

```json
{
  "type": "auto_reply",
  "enabled": true,
  "replyMode": "ai",
  "aiSystemPrompt": "Ты поддержка. Отвечай по-русски кратко.",
  "triggerKeywords": [],
  "cooldownSeconds": 5
}
```

### `monitor` — мониторинг каналов

```json
{
  "type": "monitor",
  "enabled": true,
  "targets": ["@channel", "-100123456789"],
  "filters": { "keywords": ["важно", "срочно"] },
  "saveToDb": true,
  "webhookUrl": "https://my.server/hook"
}
```

### `broadcast` — рассылки

```json
{
  "type": "broadcast",
  "enabled": true,
  "targets": ["@channel"],
  "message": "<b>Привет!</b>",
  "schedule": "0 9 * * *",
  "delayBetweenMs": 2000
}
```

### `parser` — разовый парсинг

```json
{
  "type": "parser",
  "enabled": true,
  "targets": ["@group"],
  "parseMessages": false,
  "parseMembers": true,
  "limit": 500,
  "saveToDb": true
}
```

---

## Структура файлов

```
plugins/telegram/
├── package.json
├── INTEGRATION.md
└── src/
    ├── index.ts              ← public export
    ├── TelegramPlugin.ts     ← GatewayPlugin implementation
    ├── types.ts              ← все TypeScript типы
    ├── agents/
    │   ├── BaseAgent.ts
    │   ├── UserBotAgent.ts   ← MTProto (gram.js)
    │   ├── BotAgent.ts       ← Bot API (grammy)
    │   └── AgentManager.ts   ← пул агентов
    ├── behaviors/
    │   └── AiReplyEngine.ts  ← Claude AI
    └── storage/
        └── TelegramStorage.ts ← SQLite (отдельный файл от Gateway)
```

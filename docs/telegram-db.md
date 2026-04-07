# Просмотр базы данных Telegram-менеджера

## Быстрый старт

База данных хранится в: `~/.openclaw/telegram/telegram.db`

### Способ 1: Интерактивный скрипт (рекомендуется)

```bash
./scripts/view-telegram-db.sh
```

Выберите действие из меню:

- **1** - Показать всех агентов
- **2** - Статистика агентов
- **3** - Последние события
- **4** - История ре-ангажемента
- **5** - AI traces
- **6** - Структура таблиц
- **7** - Открыть sqlite3 консоль

### Способ 2: Прямые SQL запросы

```bash
./scripts/view-telegram-db.sh "SELECT * FROM tg_agents;"
```

### Способ 3: SQLite Browser (GUI)

Установите [DB Browser for SQLite](https://sqlitebrowser.org/):

```bash
brew install --cask db-browser-for-sqlite
```

Откройте БД:

```bash
open ~/.openclaw/telegram/telegram.db -a "DB Browser for SQLite"
```

## Полезные запросы

### Агенты

```sql
-- Все агенты
SELECT id, name, type, status, created_at FROM tg_agents;

-- Статистика агента
SELECT id, name, stats FROM tg_agents WHERE id = 'your-agent-id';
```

### История ре-ангажемента

```sql
-- Последние 20 отправленных сообщений
SELECT
  agent_id,
  first_name,
  username,
  delay_days,
  message_text,
  sent_at
FROM tg_reengagement_history
ORDER BY sent_at DESC
LIMIT 20;

-- Статистика по дням
SELECT
  date(sent_at) as date,
  COUNT(*) as count,
  agent_id
FROM tg_reengagement_history
GROUP BY date, agent_id
ORDER BY date DESC;
```

### AI Traces (отладка)

```sql
-- Последние 10 вызовов ИИ
SELECT
  agent_id,
  trace_type,
  input_data,
  output_data,
  meta,
  created_at
FROM tg_ai_traces
ORDER BY created_at DESC
LIMIT 10;
```

### События

```sql
-- Последние события
SELECT
  agent_name,
  type,
  payload,
  ts
FROM tg_events
ORDER BY ts DESC
LIMIT 50;

-- События по типу
SELECT type, COUNT(*) as count
FROM tg_events
GROUP BY type
ORDER BY count DESC;
```

### Настройки агента

```sql
-- Все настройки
SELECT agent_id, key, value
FROM tg_agent_settings
WHERE agent_id = 'your-agent-id';

-- Конкретная настройка
SELECT value
FROM tg_agent_settings
WHERE agent_id = 'your-agent-id'
  AND key = 'reEngagementEnabled';
```

### Лиды

```sql
-- Все лиды
SELECT
  id,
  agent_id,
  first_name,
  username,
  phone,
  tags,
  created_at
FROM tg_leads
ORDER BY created_at DESC;

-- Лиды с конкретным тегом
SELECT * FROM tg_leads
WHERE tags LIKE '%горячий%';
```

## Структура основных таблиц

### tg_agents

Основная таблица агентов:

- `id` - уникальный ID
- `name` - имя агента
- `type` - тип (userbot/bot)
- `status` - статус (running/stopped/error)
- `credentials` - учетные данные (зашифрованы)
- `behaviors` - поведения (JSON)
- `stats` - статистика (JSON)

### tg_reengagement_history

История отправленных сообщений реактивации:

- `agent_id` - ID агента
- `chat_id` - ID чата
- `first_name`, `username` - имя клиента
- `delay_days` - через сколько дней молчания отправлено
- `message_text` - текст сообщения
- `sent_at` - время отправки

### tg_ai_traces

Полный лог вызовов ИИ (для отладки):

- `agent_id` - ID агента
- `trace_type` - тип операции
- `input_data` - что отправлено в ИИ (JSON)
- `output_data` - что вернул ИИ (JSON)
- `meta` - метаданные (JSON)

### tg_agent_settings

Настройки агентов (key-value):

- `agent_id` - ID агента
- `key` - ключ настройки
- `value` - значение (JSON)

### tg_events

Лог событий:

- `agent_name` - имя агента
- `type` - тип события
- `payload` - данные события (JSON)
- `ts` - время

## Советы

1. **Бэкап перед изменениями:**

   ```bash
   cp ~/.openclaw/telegram/telegram.db ~/.openclaw/telegram/telegram.db.backup
   ```

2. **Просмотр размера БД:**

   ```bash
   du -h ~/.openclaw/telegram/telegram.db
   ```

3. **Вакуумирование (оптимизация):**

   ```bash
   sqlite3 ~/.openclaw/telegram/telegram.db "VACUUM;"
   ```

4. **Экспорт в CSV:**
   ```bash
   sqlite3 -header -csv ~/.openclaw/telegram/telegram.db \
     "SELECT * FROM tg_reengagement_history;" > reengagement.csv
   ```

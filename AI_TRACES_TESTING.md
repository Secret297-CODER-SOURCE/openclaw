# AI Traces - Тестирование

## Что было сделано

✅ Добавлена запись AI traces для **всех** schema-based ответов ИИ (раньше записывались только реактивации)
✅ Gateway перезапущен с новым кодом  
✅ Агент `dir` (ID: b90cd9d4...) работает в schema mode с активной диаграммой

## Почему сейчас пусто

В базе данных **0 записей** в таблице `ai_traces`:

```bash
$ sqlite3 ~/.openclaw/telegram/telegram.db "SELECT COUNT(*) FROM ai_traces;"
0
```

Это нормально! Traces начнут записываться **после того, как агент получит новое сообщение** и ИИ сгенерирует ответ.

## Как протестировать

1. **Отправьте тестовое сообщение агенту `dir`** в Telegram
2. **Подождите ответа** от агента
3. **Обновите страницу** в Telegram Manager UI
4. **Перейдите в раздел "Реактивации"** → вкладка **"🔍 AI Traces"**
5. **Нажмите кнопку "🔄 Загрузить"**

После этого вы должны увидеть trace с полной информацией:

- ✅ Что написал клиент
- ✅ Какой system prompt был использован
- ✅ История диалога (последние 8 сообщений)
- ✅ Что сгенерировал ИИ (raw response)
- ✅ Что было отправлено (final text после обработки)
- ✅ Время выполнения запроса к ИИ
- ✅ Настройки агента

## Проверка вручную

Если хотите проверить напрямую в базе данных:

```bash
# Посмотреть количество traces
sqlite3 ~/.openclaw/telegram/telegram.db "SELECT COUNT(*) FROM ai_traces WHERE agent_id='b90cd9d4-6007-402b-8b0a-06c778bdd782';"

# Посмотреть последний trace
sqlite3 ~/.openclaw/telegram/telegram.db "SELECT id, chat_id, type, created_at FROM ai_traces WHERE agent_id='b90cd9d4-6007-402b-8b0a-06c778bdd782' ORDER BY created_at DESC LIMIT 1;"
```

## Что дальше

После тестирования traces должны появляться для:

1. **Обычных ответов** в schema mode (это новое!)
2. **Реактиваций** с шаблоном
3. **Реактиваций** полностью от ИИ

Если traces не появляются, проверьте:

- ✅ Gateway запущен (должен быть процесс `openclaw-gateway`)
- ✅ Агент активен (`status = "running"`)
- ✅ ИИ включен (`aiEnabled = true`)
- ✅ Schema mode включен (`useSchema = true`)
- ✅ Есть активная диаграмма (`activeDiagramId` не null)

## Статус Gateway

Gateway запущен и работает:

```
worker   93506  63.7  6.6 445796672 1110176  openclaw-gateway
```

Logs: `/tmp/openclaw-gateway.log`

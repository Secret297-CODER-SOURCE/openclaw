# Проверка реактивации (Re-engagement)

## Структура реактивации

### Backend (extensions/telegram-manager)

1. **Cron job** (`BaseAgent.ts:3129-3149`):
   - Запускается каждые 30 минут: `*/30 * * * *`
   - Запускается при старте агента через `startReEngagementCron()`
   - Вызывает `runReEngagementCheck()` сразу при старте

2. **Проверка и отправка** (`BaseAgent.ts:3394-3594`):
   - `runReEngagementCheck()` - основная логика
   - Проверяет `settings.reEngagementEnabled`
   - Проверяет `settings.aiEnabled !== false`
   - Строит массив delays из `reEngagementDelayFrom`/`reEngagementDelayTo`
   - Использует окно ±12 часов для каждого дня
   - Поддерживает режим "и более" (`reEngagementDelayMore`)

3. **База данных** (`TelegramStorage.ts`):
   - Таблица `tg_contacts` - хранит контакты и `last_client_msg_at`
   - Таблица `tg_reengagement` - отслеживает отправленные сообщения (dedup)
   - Методы:
     - `upsertContact()` - сохраняет/обновляет контакт
     - `getContactsForReEngagement()` - находит контакты для отправки
     - `markReEngagementSent()` - помечает отправленное сообщение
     - `wasRecentlyReEngaged()` - проверяет недавнюю реактивацию

4. **Два режима генерации**:
   - **Template mode** (по умолчанию):
     - Использует шаблон из `settings.reEngagementTemplate`
     - Заменяет `{имя}`, `{фамилия}`, `{имя_полное}`
     - AI улучшает шаблон через `enhanceReEngagementMessage()`
   - **AI mode** (`settings.reEngagementAiMode === "ai"`):
     - AI читает всю историю чата
     - Генерирует сообщение с нуля через `generateAiReEngagement()`

5. **Фильтры и проверки**:
   - `reEngagementApplyGuards` - применять ли фильтры (по умолчанию true)
   - `reEngagementNameOnly` - отправлять только если есть имя
   - `reEngagementTone` - тон сообщения (soft/balanced/hard)
   - Пауза между сообщениями: `reEngagementPauseMin`/`reEngagementPauseMax`

### Frontend (UI)

1. **Настройки** (`telegram.ts:2735-3050`):
   - Включить/выключить реактивацию
   - Интервал молчания (от-до дней)
   - Чекбокс "и более"
   - Задержка между сообщениями
   - Режим после ответа клиента (ИИ продолжает / молчать)
   - Режим сообщения (шаблон / ИИ генерирует)
   - Тон реактивации
   - Текстовое поле шаблона (только для режима "шаблон")

2. **Промпты реактивации** (`telegram.ts:3054-3180+`):
   - Применять фильтры
   - Контекст реактивации
   - Анти-галлюцинации
   - Дополнительные инструкции

## Чеклист проверки

### 1. Настройки сохраняются?

- [ ] Проверить, что `saveNow()` вызывается
- [ ] Проверить, что данные отправляются на backend
- [ ] Проверить логи сохранения настроек

### 2. Агент запущен?

- [ ] Статус агента = "running"
- [ ] Cron job стартовал (проверить логи: `[TG:AgentName] re-engagement cron started`)

### 3. Контакты сохраняются?

- [ ] `saveContactInfo()` вызывается при получении сообщений
- [ ] Таблица `tg_contacts` не пуста
- [ ] `last_client_msg_at` обновляется

### 4. Логи проверки реактивации

Искать в логах:

```
[TG:AgentName] re-engagement check | delays=[...] more=... trackedContacts=...
[TG:AgentName] re-engagement contact | chat=... name=... silence=...d
[TG:AgentName] re-engagement day=X window=[...] found=...
[TG:AgentName] re-engagement sent | chat=... day=...
```

### 5. Диагностика "found=0"

Если `found=0`, проверить:

- [ ] `trackedContacts=0` → контакты не сохраняются → проверить `saveContactInfo()`
- [ ] `inWindow=0` → контакты есть, но вне окна → проверить даты
- [ ] `dedupBlocked>0` → уже отправлено → проверить таблицу `tg_reengagement`

## Возможные проблемы

1. **Настройки не сохраняются**:
   - UI отправляет неправильные данные
   - Backend не сохраняет в БД
   - Агент перезапускается и теряет настройки

2. **Cron не запускается**:
   - Агент не стартовал
   - Ошибка импорта `node-cron`
   - Cron задача упала с ошибкой

3. **Контакты не сохраняются**:
   - `saveContactInfo()` не вызывается
   - Ошибка записи в БД
   - Агент работает с другим `agent.id`

4. **Окно времени не совпадает**:
   - Неправильный расчет `±12 часов`
   - Временная зона не учитывается
   - `last_client_msg_at` не обновляется

5. **Dedup блокирует повторную отправку**:
   - Запись в `tg_reengagement` осталась от предыдущего запуска
   - `period_ref` не сбрасывается при новом сообщении

## Рекомендации для отладки

1. **Включить подробные логи**:

   ```typescript
   this.logger.info(`[TG:${this.name}] re-engagement check | delays=${JSON.stringify(delays)} ...`);
   ```

2. **Проверить БД напрямую**:

   ```sql
   -- Все контакты агента
   SELECT * FROM tg_contacts WHERE agent_id = 'agent-name';

   -- Все отправленные реактивации
   SELECT * FROM tg_reengagement WHERE agent_id = 'agent-name';

   -- Контакты, готовые для реактивации (пример: 3 дня)
   SELECT * FROM tg_contacts
   WHERE agent_id = 'agent-name'
   AND datetime(last_client_msg_at) < datetime('now', '-3 days');
   ```

3. **Проверить cron**:
   - Логи должны показывать `re-engagement cron started`
   - Проверка должна запускаться сразу при старте
   - Затем каждые 30 минут

4. **Проверить UI → Backend связь**:
   - Открыть DevTools → Network
   - Изменить настройку реактивации
   - Проверить запрос PATCH/PUT с настройками

5. **Проверить события**:
   ```typescript
   this.pushEvent("reengagement", {
     action: "sent",
     chatId: contact.chatId,
     day: dayLabel,
     mode: settings.reEngagementAiMode ?? "template",
     text: message,
   });
   ```

## Быстрый тест

1. Включить реактивацию
2. Установить интервал 1-2 дня
3. Добавить шаблон: "Тест {имя}"
4. Подождать 30 минут (или рестартовать агента)
5. Проверить логи на наличие `re-engagement sent`

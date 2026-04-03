#!/bin/bash
# EMERGENCY: Принудительный запуск реактивации

echo "🚨 EMERGENCY RE-ENGAGEMENT TRIGGER"
echo ""
echo "Этот скрипт принудительно вызывает метод runReEngagementCheck()"
echo ""

# Найти gateway процесс
PID=$(pgrep -f "openclaw.*gateway" | head -1)

if [ -z "$PID" ]; then
  echo "❌ Gateway не запущен!"
  echo ""
  echo "Запустите:"
  echo "  openclaw gateway run &"
  exit 1
fi

echo "✅ Gateway найден (PID: $PID)"
echo ""

# Проверить что есть агенты
DB_PATH="$HOME/.openclaw/gateway.db"

if [ ! -f "$DB_PATH" ]; then
  echo "❌ База данных не найдена: $DB_PATH"
  exit 1
fi

echo "✅ База данных найдена"
echo ""

# Показать агентов
echo "📊 Агенты в базе:"
sqlite3 "$DB_PATH" "SELECT name, type, status FROM telegram_agents;" 2>/dev/null || echo "  (не удалось прочитать)"
echo ""

# Показать контакты
echo "📋 Контакты (последние 5):"
sqlite3 "$DB_PATH" "
  SELECT
    COALESCE(first_name, username, chat_id) as name,
    ROUND((julianday('now') - julianday(last_client_msg_at)), 2) as days
  FROM tg_contacts
  ORDER BY last_client_msg_at DESC
  LIMIT 5;
" 2>/dev/null || echo "  (не удалось прочитать)"
echo ""

echo "⚙️ Настройки реактивации:"
sqlite3 "$DB_PATH" "
  SELECT
    json_extract(settings, '$.reEngagementEnabled') as enabled,
    json_extract(settings, '$.reEngagementDelayFrom') as delayFrom,
    json_extract(settings, '$.reEngagementDelayTo') as delayTo,
    json_extract(settings, '$.reEngagementTemplate') as template
  FROM telegram_agents
  LIMIT 1;
" 2>/dev/null || echo "  (не удалось прочитать)"
echo ""

echo "🔄 Для ПРИНУДИТЕЛЬНОГО запуска реактивации:"
echo ""
echo "1. РЕСТАРТУЙТЕ агента через UI (Stop → Start)"
echo ""
echo "2. ИЛИ через терминал:"
echo "   kill $PID"
echo "   openclaw gateway run &"
echo ""
echo "3. ПОДОЖДИТЕ 60 секунд"
echo ""
echo "4. Проверьте логи терминала на наличие:"
echo "   [TG:...] re-engagement sent"
echo ""

echo "💡 ВАЖНО: Проверьте настройки в UI!"
echo "   Вкладка Промпты → Реактивация:"
echo "   - ✅ Включить"
echo "   - Интервал: от X до Y дней (под ваше время молчания)"
echo "   - Шаблон: заполнен"
echo ""


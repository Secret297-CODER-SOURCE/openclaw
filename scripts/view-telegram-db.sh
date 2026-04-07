#!/usr/bin/env bash
# Скрипт для просмотра базы данных Telegram-менеджера

set -euo pipefail

DB_PATH="${HOME}/.openclaw/telegram/telegram.db"

# Проверяем наличие sqlite3
if ! command -v sqlite3 &> /dev/null; then
  echo "❌ sqlite3 не установлен. Установите его:"
  echo "   brew install sqlite3   # macOS"
  echo "   apt install sqlite3    # Ubuntu/Debian"
  exit 1
fi

# Проверяем существование БД
if [ ! -f "$DB_PATH" ]; then
  echo "❌ База данных не найдена: $DB_PATH"
  echo ""
  echo "💡 База создается автоматически при первом запуске gateway с telegram-manager."
  echo "   Запустите gateway и она появится."
  exit 1
fi

echo "📊 База данных Telegram-менеджера"
echo "📁 Путь: $DB_PATH"
echo ""

# Проверяем размер БД
DB_SIZE=$(du -h "$DB_PATH" | cut -f1)
echo "💾 Размер: $DB_SIZE"
echo ""

# Показываем список таблиц
echo "📋 Таблицы в базе данных:"
sqlite3 "$DB_PATH" ".tables"
echo ""

# Если передан аргумент - выполняем запрос
if [ $# -gt 0 ]; then
  echo "🔍 Выполняем запрос: $*"
  echo ""
  sqlite3 -header -column "$DB_PATH" "$@"
  exit 0
fi

# Интерактивное меню
echo "Выберите действие:"
echo "  1) Показать всех агентов"
echo "  2) Показать статистику агентов"
echo "  3) Показать последние события (50 шт)"
echo "  4) Показать историю ре-ангажемента"
echo "  5) Показать AI traces"
echo "  6) Показать структуру таблиц"
echo "  7) Открыть интерактивную sqlite3 консоль"
echo ""
read -p "Введите номер (1-7): " choice

case $choice in
  1)
    echo ""
    echo "👥 Все агенты:"
    sqlite3 -header -column "$DB_PATH" "SELECT id, name, type, status, created_at FROM tg_agents;"
    ;;
  2)
    echo ""
    echo "📊 Статистика агентов:"
    sqlite3 -header -column "$DB_PATH" "
      SELECT
        id,
        name,
        type,
        status,
        stats,
        last_error
      FROM tg_agents;
    "
    ;;
  3)
    echo ""
    echo "📰 Последние 50 событий:"
    sqlite3 -header -column "$DB_PATH" "
      SELECT
        id,
        agent_name,
        type,
        substr(payload, 1, 50) as payload_preview,
        ts
      FROM tg_events
      ORDER BY id DESC
      LIMIT 50;
    "
    ;;
  4)
    echo ""
    echo "🔁 История ре-ангажемента:"
    sqlite3 -header -column "$DB_PATH" "
      SELECT
        agent_id,
        chat_id,
        first_name,
        username,
        delay_days,
        substr(message_text, 1, 60) as message_preview,
        sent_at
      FROM tg_reengagement_history
      ORDER BY sent_at DESC
      LIMIT 50;
    "
    ;;
  5)
    echo ""
    echo "🔍 AI Traces (последние 10):"
    sqlite3 -header -column "$DB_PATH" "
      SELECT
        agent_id,
        trace_type,
        substr(input_data, 1, 40) as input_preview,
        substr(output_data, 1, 40) as output_preview,
        created_at
      FROM tg_ai_traces
      ORDER BY created_at DESC
      LIMIT 10;
    "
    ;;
  6)
    echo ""
    echo "🏗️  Структура таблиц:"
    for table in $(sqlite3 "$DB_PATH" ".tables"); do
      echo ""
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo "Таблица: $table"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      sqlite3 "$DB_PATH" ".schema $table"
    done
    ;;
  7)
    echo ""
    echo "🎮 Открываем интерактивную консоль sqlite3..."
    echo "💡 Используйте команды:"
    echo "   .tables           - показать таблицы"
    echo "   .schema <table>   - структура таблицы"
    echo "   .quit             - выход"
    echo ""
    sqlite3 -header -column "$DB_PATH"
    ;;
  *)
    echo "❌ Неверный выбор"
    exit 1
    ;;
esac


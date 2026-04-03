#!/usr/bin/env node
/**
 * EMERGENCY: Принудительная отправка реактивации
 * Этот скрипт НАПРЯМУЮ вызывает отправку, минуя cron
 */

import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Найти DB путь
const DB_PATH = join(process.env.HOME || "/tmp", ".openclaw", "gateway.db");

console.log("🔍 Проверка базы данных:", DB_PATH);

try {
  const db = new Database(DB_PATH, { readonly: true });
  
  // Получить всех агентов
  const agents = db.prepare(`
    SELECT id, name, type, status FROM telegram_agents
  `).all();
  
  console.log("\n📊 Найдено агентов:", agents.length);
  agents.forEach(a => {
    console.log(`  - ${a.name} (${a.type}) [${a.status}]`);
  });
  
  if (agents.length === 0) {
    console.log("\n❌ Нет агентов в БД!");
    process.exit(1);
  }
  
  // Берем первого running агента
  const agent = agents.find(a => a.status === "running") || agents[0];
  console.log(`\n✅ Выбран агент: ${agent.name} (ID: ${agent.id})`);
  
  // Получить контакты этого агента
  const contacts = db.prepare(`
    SELECT 
      chat_id,
      first_name,
      last_name,
      username,
      last_client_msg_at,
      ROUND((julianday('now') - julianday(last_client_msg_at)), 2) as silence_days
    FROM tg_contacts 
    WHERE agent_id = ?
    ORDER BY last_client_msg_at DESC
    LIMIT 10
  `).all(agent.id);
  
  console.log(`\n📋 Контакты агента (последние 10):`);
  if (contacts.length === 0) {
    console.log("  ❌ Нет контактов!");
  } else {
    contacts.forEach(c => {
      const name = c.first_name || c.username || c.chat_id;
      console.log(`  - ${name}: молчит ${c.silence_days} дней (last: ${c.last_client_msg_at})`);
    });
  }
  
  // Получить настройки реактивации
  const settings = db.prepare(`
    SELECT settings FROM telegram_agents WHERE id = ?
  `).get(agent.id);
  
  let config = {};
  try {
    config = JSON.parse(settings?.settings || "{}");
  } catch (e) {
    console.log("\n⚠️ Не удалось прочитать настройки");
  }
  
  console.log(`\n⚙️ Настройки реактивации:`);
  console.log(`  Enabled: ${config.reEngagementEnabled ?? "не задано"}`);
  console.log(`  Интервал: от ${config.reEngagementDelayFrom ?? "?"} до ${config.reEngagementDelayTo ?? "?"} дней`);
  console.log(`  И более: ${config.reEngagementDelayMore ?? false}`);
  console.log(`  Шаблон: ${config.reEngagementTemplate ? `"${config.reEngagementTemplate.slice(0, 50)}..."` : "не задан"}`);
  
  // Проверить уже отправленные
  const sent = db.prepare(`
    SELECT 
      chat_id,
      delay_days,
      sent_at
    FROM tg_reengagement 
    WHERE agent_id = ?
    ORDER BY sent_at DESC
    LIMIT 5
  `).all(agent.id);
  
  console.log(`\n📤 Последние отправки реактивации:`);
  if (sent.length === 0) {
    console.log("  ❌ Нет записей об отправках!");
  } else {
    sent.forEach(s => {
      console.log(`  - Chat ${s.chat_id}: день ${s.delay_days}, отправлено ${s.sent_at}`);
    });
  }
  
  db.close();
  
  console.log(`\n\n🚀 СЛЕДУЮЩИЕ ШАГИ:`);
  console.log(`\n1. ПРОВЕРЬТЕ настройки в UI:`);
  console.log(`   - reEngagementEnabled должен быть true`);
  console.log(`   - reEngagementTemplate должен быть заполнен`);
  console.log(`   - Интервал должен соответствовать времени молчания контактов`);
  
  console.log(`\n2. РЕСТАРТУЙТЕ агента:`);
  console.log(`   - Вкладка "Обзор" → Stop → Start`);
  console.log(`   - Или: pkill -f "openclaw.*gateway" && openclaw gateway run &`);
  
  console.log(`\n3. ПОДОЖДИТЕ 60 секунд и проверьте логи`);
  
  console.log(`\n💡 Если контакты молчат 2-3 дня:`);
  console.log(`   Установите: delayFrom=2, delayTo=4, delayMore=true`);
  
} catch (err) {
  console.error("\n❌ ОШИБКА:", err.message);
  console.log("\n💡 Убедитесь что:");
  console.log("  1. Gateway запущен");
  console.log("  2. База данных существует:", DB_PATH);
  console.log("  3. У вас есть права на чтение БД");
  process.exit(1);
}


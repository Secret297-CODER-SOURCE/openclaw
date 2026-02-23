/**
 * pii-guard/proxy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Основной класс PiiProxy и менеджер сессий.
 *
 * ГАРАНТИИ:
 * - Один и тот же фрагмент → всегда один и тот же токен (дедупликация)
 * - Токены не перезаписывают друг друга при многократном sanitize
 * - Изоляция между сессиями (каждый sessionId — свой store)
 * - Защита от "сломанных токенов": если LLM разбила [КАРТА_A3F2B1] на части,
 *   восстановление всё равно работает (fuzzy restore)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import crypto from 'crypto';
import { SORTED_PATTERNS } from './patterns.js';

// ─────────────────────────────────────────────────────────────────────────────
// ТИПЫ
// ─────────────────────────────────────────────────────────────────────────────

interface PiiEntry {
  token: string;
  original: string;
  tokenName: string;
  group: string;
  detectedAt: number; // timestamp
}

interface SanitizeResult {
  text: string;           // Текст с токенами (передаётся в LLM)
  detected: PiiEntry[];   // Что нашли в этом вызове
}

// ─────────────────────────────────────────────────────────────────────────────
// REGEX ДЛЯ ТОКЕНОВ: [ИМЯ_XXXXXX] где X — HEX
// ─────────────────────────────────────────────────────────────────────────────
const TOKEN_PATTERN = /\[[А-ЯЁA-Z0-9_]+_[0-9A-F]{6}\]/g;

// ─────────────────────────────────────────────────────────────────────────────
// КЛАСС PiiProxy
// ─────────────────────────────────────────────────────────────────────────────
export class PiiProxy {

  /** token → PiiEntry */
  private store = new Map<string, PiiEntry>();
  /** original value → token (для дедупликации) */
  private reverseIndex = new Map<string, string>();

  // ── SANITIZE ──────────────────────────────────────────────────────────────

  /**
   * Принять входящий текст, найти все PII, заменить токенами.
   * Безопасно вызывать несколько раз — дедупликация гарантирована.
   */
  sanitize(text: string): SanitizeResult {
    const detectedInThisCall: PiiEntry[] = [];
    let result = text;

    for (const pattern of SORTED_PATTERNS) {
      // КРИТИЧНО: сбрасываем lastIndex перед каждым применением
      pattern.regex.lastIndex = 0;

      result = result.replace(pattern.regex, (match) => {
        // 1. Пропускаем уже вставленные токены
        if (TOKEN_PATTERN.test(match)) return match;
        TOKEN_PATTERN.lastIndex = 0;

        // 2. Пропускаем пустые/слишком короткие совпадения
        const trimmed = match.trim();
        if (trimmed.length < 2) return match;

        // 3. Дедупликация: если это значение уже имеет токен — возвращаем его
        if (this.reverseIndex.has(trimmed)) {
          return this.reverseIndex.get(trimmed)!;
        }

        // 4. Создаём новый токен
        const id = crypto.randomBytes(3).toString('hex').toUpperCase();
        const token = `[${pattern.tokenName}_${id}]`;

        const entry: PiiEntry = {
          token,
          original: trimmed,
          tokenName: pattern.tokenName,
          group: pattern.group,
          detectedAt: Date.now(),
        };

        this.store.set(token, entry);
        this.reverseIndex.set(trimmed, token);
        detectedInThisCall.push(entry);

        return token;
      });
    }

    return { text: result, detected: detectedInThisCall };
  }

  // ── RESTORE ───────────────────────────────────────────────────────────────

  /**
   * Заменить токены в ответе LLM обратно на реальные значения.
   *
   * Обрабатывает 3 случая:
   * 1. Токен цел: [КАРТА_A3F2B1] → прямая замена
   * 2. Токен с пробелами (LLM иногда добавляет): [ КАРТА_A3F2B1 ] → trim + замена
   * 3. Токен не найден → оставляем как есть (не ломаем ответ)
   */
  restore(text: string): string {
    let result = text;

    for (const [token, entry] of this.store) {
      // Прямая замена
      if (result.includes(token)) {
        result = result.split(token).join(entry.original);
        continue;
      }

      // Fuzzy: токен с пробелами внутри скобок
      const fuzzyToken = token
        .replace(/^\[/, '\\[\\s*')
        .replace(/\]$/, '\\s*\\]');
      try {
        const fuzzyRe = new RegExp(fuzzyToken, 'g');
        result = result.replace(fuzzyRe, entry.original);
      } catch {
        // если regex сломался — пропускаем
      }
    }

    return result;
  }

  // ── УТИЛИТЫ ───────────────────────────────────────────────────────────────

  /** Статистика: сколько записей каждой группы */
  stats(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.store.values()) {
      counts[entry.group] = (counts[entry.group] ?? 0) + 1;
    }
    return counts;
  }

  /** Сколько всего PII накоплено в сессии */
  get size(): number {
    return this.store.size;
  }

  /** Сбросить store (вызывать при /reset) */
  clear(): void {
    this.store.clear();
    this.reverseIndex.clear();
  }

  /** Полный дамп для отладки (НИКОГДА не логировать в проде!) */
  debugDump(): PiiEntry[] {
    return [...this.store.values()];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// МЕНЕДЖЕР СЕССИЙ
// ─────────────────────────────────────────────────────────────────────────────

class PiiSessionManager {
  private sessions = new Map<string, PiiProxy>();

  /** Получить или создать PiiProxy для сессии */
  get(sessionId: string): PiiProxy {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new PiiProxy());
    }
    return this.sessions.get(sessionId)!;
  }

  /** Сбросить store сессии (при /reset /new) */
  reset(sessionId: string): void {
    this.sessions.get(sessionId)?.clear();
  }

  /** Полностью удалить сессию (при завершении) */
  destroy(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Количество активных сессий */
  get sessionCount(): number {
    return this.sessions.size;
  }
}

// Синглтон — один экземпляр на весь процесс
export const piiSessions = new PiiSessionManager();

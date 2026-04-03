import EventEmitter from "events";
// plugins/telegram/src/agents/BaseAgent.ts
import fs from "fs";
import path from "path";
import {
  aiReply,
  analyzeOnceDirect,
  invalidateHistoryCache,
  updateLastAssistantReply,
} from "../behaviors/AiReplyEngine.js";
import { TelegramStorage } from "../storage/TelegramStorage";
import { createWorkspaceTools } from "../tools/TelegramTools.js";
import {
  AgentRecord,
  AgentSettings,
  BehaviorConfig,
  DiagramEdge,
  DiagramNode,
  FlowDiagram,
  TelegramEvent,
  AgentStatus,
  AutoReplyBehavior,
  TaskSession,
  TaskSessionBehavior,
  ILogger,
} from "../types";

export abstract class BaseAgent extends EventEmitter {
  readonly id: string;
  readonly name: string;
  protected record: AgentRecord;
  protected storage: TelegramStorage;
  protected logger: ILogger;
  // TTL cache for KB and coaching tips — avoids DB reads on every AI reply.
  private _kbCache: { key: string; data: unknown; ts: number } | null = null;
  private _coachCache: { key: string; data: unknown; ts: number } | null = null;
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
  // cronJobs is declared here only for TypeScript — the actual value is set as
  // non-enumerable in the constructor so that structuredClone (called by the
  // pi-agent framework in emitContext) never traverses into cron.ScheduledTask
  // objects, which contain internal timers/Promises that cannot be cloned.
  protected cronJobs!: Map<string, any>;

  constructor(record: AgentRecord, storage: TelegramStorage, logger: ILogger) {
    super();
    this.id = record.id;
    this.name = record.name;
    this.record = { ...record };
    this.storage = storage;
    this.logger = logger;
    // IMPORTANT: define cronJobs as non-enumerable so structuredClone skips it.
    // cron.ScheduledTask holds internal Node.js timers that are not cloneable.
    // A plain `this.cronJobs = new Map()` would create an enumerable own property
    // that structuredClone traverses, causing DataCloneError when the pi-agent
    // framework calls emitContext during delayed/scheduled operations.
    Object.defineProperty(this, "cronJobs", {
      value: new Map<string, any>(),
      writable: true,
      configurable: true,
      enumerable: false, // non-enumerable → skipped by structuredClone
    });
    // followupTimers: non-enumerable for the same reason as cronJobs.
    Object.defineProperty(this, "followupTimers", {
      value: new Map<string, ReturnType<typeof setTimeout>>(),
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** Map of pending follow-up timers: followup id → timeout handle. Non-enumerable. */
  protected followupTimers!: Map<string, ReturnType<typeof setTimeout>>;

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  /**
   * Gracefully disconnect the agent WITHOUT changing its persisted "running"
   * status. Called by AgentManager.shutdown() so that agents that were
   * running remain marked "running" in the DB and are auto-restarted when
   * the gateway comes back up.
   *
   * Subclasses should override to disconnect connections without calling
   * setStatus("stopped"). Default falls back to stop() (safe but loses
   * auto-restart for agents that don't override).
   */
  async gracefulShutdown(): Promise<void> {
    await this.stop();
  }

  /** Call a named tool imperatively (e.g. from WS tool.call) */
  abstract callTool(tool: string, args: Record<string, unknown>): Promise<unknown>;

  getRecord(): AgentRecord {
    return { ...this.record };
  }
  getStatus(): AgentStatus {
    return this.record.status;
  }

  protected setStatus(status: AgentStatus, error?: string) {
    this.record.status = status;
    this.storage.updateStatus(this.id, status, error);
    this.pushEvent("status_change", { status, error });
    this.logger.info(`[TG:${this.name}] → ${status}`, { error });
  }

  async updateBehaviors(behaviors: BehaviorConfig[]): Promise<void> {
    this.record.behaviors = behaviors;
    this.storage.updateBehaviors(this.id, behaviors);
    await this.onBehaviorsChanged(behaviors);
    this.logger.info(`[TG:${this.name}] behaviors updated`, { count: behaviors.length });
  }

  protected abstract onBehaviorsChanged(b: BehaviorConfig[]): Promise<void>;

  getBehavior<T extends BehaviorConfig>(type: T["type"]): T | undefined {
    return this.record.behaviors.find((b) => b.type === type) as T | undefined;
  }

  /**
   * Load the persisted agent settings (work mode, schedule, active diagram).
   * Returns defaults when no settings have been saved yet.
   */
  protected getAgentSettings(): AgentSettings {
    return this.storage.getAgentSettings(this.id);
  }

  /**
   * Returns true if the agent is allowed to reply right now according to its
   * work-mode settings.  Always returns true for modes other than "schedule".
   */
  protected isWithinSchedule(settings: AgentSettings): boolean {
    // Master AI kill-switch: false = agent is completely silent.
    if (settings.aiEnabled === false) return false;
    if (settings.scheduleMode !== "schedule") return true;
    const from = settings.scheduleFrom;
    const to = settings.scheduleTo;
    if (!from || !to) return true;

    const now = new Date();
    const hhmm =
      String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");

    // Compare as strings — works for same-day windows (e.g. "09:00" – "18:00").
    // For overnight windows (e.g. "22:00" – "06:00") use OR logic.
    if (from <= to) {
      return hhmm >= from && hhmm <= to;
    } else {
      return hhmm >= from || hhmm <= to;
    }
  }

  // ─── Offline lead-processing mode ─────────────────────────────────────────

  /**
   * Returns true when the agent should handle this message in offline mode
   * (outside schedule, but with AI lead-processing enabled).
   */
  protected isOfflineLeadMode(settings: AgentSettings): boolean {
    return (
      settings.offlineReplyEnabled === true &&
      settings.scheduleMode === "schedule" &&
      !this.isWithinSchedule(settings)
    );
  }

  /**
   * Returns true when the agent is in "silent" offline mode (offlineReplyEnabled
   * is false / not set) BUT re-engagement is active AND this specific chat
   * recently received a re-engagement message from us.
   *
   * In this case we should reply to keep the conversation alive — the whole
   * point of re-engagement is to get a response and then handle it.
   */
  protected isReEngagementReply(chatId: string, settings: AgentSettings): boolean {
    if (!settings.reEngagementEnabled) return false;
    // Feature gate: when reEngagementAiContinue is explicitly false, AI stays silent.
    if (settings.reEngagementAiContinue === false) return false;
    // Already handled by offline lead mode — no need to double-handle.
    if (settings.offlineReplyEnabled) return false;
    // Look back max delay + 7-day buffer so slow replies still get handled.
    const delays = settings.reEngagementDelays ?? [1, 2, 3, 5];
    const maxDays = Math.max(...delays) + 7;
    return this.storage.wasRecentlyReEngaged(this.id, chatId, maxDays);
  }

  /**
   * Returns true when a re-engagement message was recently sent to this chat
   * AND reEngagementAiContinue is explicitly false.
   *
   * Use this to gate the within-schedule auto-reply path: even if the agent
   * is "online" and auto-reply is ON, it should stay silent after a re-engagement
   * send so a human manager can take the conversation.
   */
  protected isReEngagementSilenced(chatId: string, settings: AgentSettings): boolean {
    if (!settings.reEngagementEnabled) return false;
    if (settings.reEngagementAiContinue !== false) return false; // only silence when explicitly OFF
    const delays = settings.reEngagementDelays ?? [1, 2, 3, 5];
    const maxDays = Math.max(...delays) + 7;
    return this.storage.wasRecentlyReEngaged(this.id, chatId, maxDays);
  }

  /**
   * Check whether a built-in guard is enabled for the given settings.
   * Falls back to `defaultActive` when no user override exists.
   */
  protected isBuiltinGuardEnabled(
    guardId: string,
    settings: AgentSettings,
    defaultActive = true,
  ): boolean {
    const overrides = settings.builtinGuardsOverrides;
    if (overrides && guardId in overrides) return !!overrides[guardId];
    return defaultActive;
  }

  /**
   * Hard post-processing guard: if the generated reply contains ANY time that
   * falls outside the configured working window, replace it with a firm redirect.
   *
   * This runs AFTER AI generation so no prompt trick can bypass it.
   * Returns the original reply unchanged when no working hours are configured
   * or when all mentioned times are within the window.
   */
  protected enforceWorkingHours(reply: string, settings: AgentSettings): string {
    // Respect user override for this built-in guard
    if (!this.isBuiltinGuardEnabled("enforceWorkingHours", settings, true)) return reply;
    const from = settings.managerWorkFrom ?? settings.scheduleFrom ?? "?";
    const to = settings.managerWorkTo ?? settings.scheduleTo ?? "?";
    if (from === "?" || to === "?") return reply;

    const toMinutes = (t: string) => {
      const [h, m] = t.split(":").map(Number);
      return (h ?? 0) * 60 + (m ?? 0);
    };
    const fromMin = toMinutes(from);
    const toMin = toMinutes(to);

    // Check if the AI's reply mentions any time outside the working window,
    // OR makes an open-ended "any time" offer that bypasses the hours constraint
    // (e.g. "подстроюсь под любое", "в любое время", "когда удобно тебе").
    const openEndedRe =
      /подстро(?:юсь|имся)\s+под\s+(?:любое|любой|любую)|в\s+любое\s+врем|когда\s+(?:тебе|вам)\s+(?:удобно|комфортнее?)\s*[.,]?\s*$/i;

    const timeRe =
      /(?:после|в|к|около|после\s+\d{1,2}|\b)(\d{1,2})[:\.]\d{2}|(?:после|в|к|около)\s+(\d{1,2})(?!\d)/gi;

    let m: RegExpExecArray | null;
    let outsideFound = false;
    let offendingTime = ""; // the specific out-of-hours time the AI mentioned
    const isOpenEnded = openEndedRe.test(reply);

    while ((m = timeRe.exec(reply)) !== null) {
      const rawHour = parseInt(m[1] ?? m[2] ?? "-1", 10);
      if (rawHour < 0) continue;
      const mentionedMin = rawHour * 60;
      if (mentionedMin >= toMin || mentionedMin < fromMin) {
        outsideFound = true;
        // Capture the matched fragment for a natural rejection message
        offendingTime = m[0].trim();
        break;
      }
    }

    // Open-ended offers ("any time today") are equivalent to agreeing to out-of-hours
    // times — replace them with a concrete in-hours slot too.
    if (!outsideFound && !isOpenEnded) return reply;
    if (!outsideFound && isOpenEnded) offendingTime = "";

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const within = nowMin >= fromMin && nowMin < toMin;

    // Propose the nearest future 30-min slot when online; opening time tomorrow when offline.
    let proposalTime = from;
    let whenLabel = "завтра";
    if (within) {
      const slot = Math.ceil((nowMin + 15) / 30) * 30;
      const slotH = Math.floor(slot / 60);
      const slotM = slot % 60;
      if (slot < toMin) {
        proposalTime = `${String(slotH).padStart(2, "0")}:${String(slotM).padStart(2, "0")}`;
        whenLabel = "сегодня";
      }
      // else: no slots left today — fall through to "tomorrow at from"
    }

    this.logger.warn(
      `[TG:${this.name}] enforceWorkingHours: blocked out-of-hours time (${offendingTime}), redirecting to ${proposalTime} ${whenLabel}`,
    );

    // Natural message — mentions specific bad time if known, or just anchors to a concrete slot.
    if (offendingTime) {
      // Specific out-of-hours time detected
      return within
        ? `Кстати, ${offendingTime} — это уже за рамками рабочего дня, я работаю до ${to}. ` +
            `Давай ${whenLabel} в ${proposalTime}? Удобно?`
        : `Рабочий день уже завершился — работаю с ${from} до ${to}. ` +
            `Предлагаю завтра в ${proposalTime} — удобно?`;
    }
    // Open-ended offer ("любое время") — anchor to a concrete slot without sounding defensive.
    return within
      ? `Я работаю до ${to}, так что давай ${whenLabel} в ${proposalTime} — удобно?`
      : `Я буду доступен завтра с ${from}. Давай в ${proposalTime} — удобно?`;
  }

  /**
   * Hard post-processing guard: remove unverified assumptions about the client.
   *
   * Example to block: "Ты говоришь, что из айти сферы..." when the client
   * never mentioned IT. This keeps manager replies factual and confident.
   */
  /**
   * Post-processing guard: replace first-person plural ("мы/можем") with singular ("я/могу").
   * Re-engagement messages must always sound like the individual manager, not a company.
   * Covers Russian, Turkish (biz/sunabiliriz → ben/sunabilirim) and English (we → I).
   */
  protected enforceFirstPerson(text: string, settings?: AgentSettings): string {
    // Respect user override for this built-in guard
    if (settings && !this.isBuiltinGuardEnabled("enforceFirstPerson", settings, true)) {
      return text;
    }
    return (
      text
        // Russian: мы → я, нам → мне, нас → меня, наш/нашей/нашу → мой/мне
        .replace(/\bмы\b/gi, "я")
        .replace(/\bнам\b/gi, "мне")
        .replace(/\bнас\b/gi, "меня")
        .replace(/\bнашег[оа]\b/gi, "моего")
        .replace(/\bнашей\b/gi, "моей")
        .replace(/\bнашу\b/gi, "мою")
        .replace(/\bнаш[иеа]?\b/gi, "мой")
        // Russian verbs: -им/-ем/-аем/-яем (plural 1st) → -ю/-ю (singular) — common sales verbs
        .replace(/\bможем\b/gi, "могу")
        .replace(/\bпредлагаем\b/gi, "предлагаю")
        .replace(/\bпомогаем\b/gi, "помогаю")
        .replace(/\bзвоним\b/gi, "звоню")
        .replace(/\bработаем\b/gi, "работаю")
        .replace(/\bдаём\b/gi, "даю")
        .replace(/\bдаем\b/gi, "даю")
        .replace(/\bделаем\b/gi, "делаю")
        // Turkish: biz → ben, bizim → benim, -riz/-rız/-riz/-ruz (plural) → -rim/-rım/-rim/-rum (singular)
        .replace(/\bbiz\b/gi, "ben")
        .replace(/\bbizim\b/gi, "benim")
        .replace(/\bsunabiliriz\b/gi, "sunabilirim")
        .replace(/\byapabiliriz\b/gi, "yapabilirim")
        .replace(/\bverebiliriz\b/gi, "verebilirim")
        .replace(/\byardımcı\s+olabiliriz\b/gi, "yardımcı olabilirim")
        // English: we → I, our → my, we can → I can
        .replace(/\bwe\b/g, "I")
        .replace(/\bour\b/g, "my")
        .replace(/\bwe can\b/gi, "I can")
        .replace(/\bwe offer\b/gi, "I offer")
        .replace(/\s{2,}/g, " ")
        .trim()
    );
  }

  protected enforceNoAssumptiveClaims(
    reply: string,
    history: Array<{ role: string; content: string }>,
    latestUserText?: string,
    settings?: AgentSettings,
  ): string {
    // Respect user override for this built-in guard
    if (settings && !this.isBuiltinGuardEnabled("enforceNoAssumptiveClaims", settings, true)) {
      return reply;
    }
    // Rewrite direct "you said/say" and "you want/seek" narration into manager-led style.
    // Covers past tense (говорил, писал, упоминал), present tense (говоришь, что),
    // and client-intent narration (ты хочешь, ты ищешь, ты пытаешься).
    const toneRewritten = reply
      .replace(
        /\b(ты|вы)\s+(?:говорил(?:а|и)?|говоришь|писал(?:а|и)?|упоминал(?:а|и)?)(?:,?\s+что)?\b/gi,
        (_m, pronoun: string) =>
          pronoun.toLowerCase() === "вы"
            ? "я думаю вам будет интересно"
            : "я думаю тебе будет интересно",
      )
      // Narrating client's intent ("ты хочешь найти время...") — replace with manager-led action.
      .replace(
        /\b(ты|вы)\s+(?:хочешь|хотите|ищешь|ищете|пытаешься|пытаетесь|стараешься|стараетесь)\s+(?:\w+\s+){0,4}/gi,
        "",
      )
      .replace(/\bпомнишь,?\s+мы\s+говорили\b/gi, "я думаю тебе будет интересно")
      .replace(/\bкак\s+ты\s+говорил(?:а|и)?\b/gi, "я думаю тебе будет интересно")
      .replace(/\bкак\s+вы\s+говорили\b/gi, "я думаю вам будет интересно")
      .replace(/\s{2,}/g, " ")
      .trim();

    const clientContext = history
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ")
      .concat(" ", latestUserText ?? "")
      .toLowerCase();

    const hasItCue = /(^|\W)(айти|it)(\W|$)/i.test(clientContext);
    const hasDomainCue = /сфер|ниша|отрасл|индустр/i.test(clientContext);

    const sentences = toneRewritten.split(/(?<=[.!?])\s+/);
    const cleaned = sentences
      .filter((sentence) => {
        const s = sentence.trim();
        if (!s) return false;
        if (/ты\s+говоришь,?\s+что/i.test(s)) return false;
        if (!hasItCue && /(из|в)\s+(?:айти|it)\s+сфер/i.test(s)) return false;
        if (!hasDomainCue && /(в|для)\s+(?:твоей|вашей)\s+сфер/i.test(s)) return false;
        return true;
      })
      .join(" ")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (cleaned) return cleaned;

    // Last-resort cleanup to avoid returning an empty message.
    return (
      toneRewritten
        .replace(/ты\s+говоришь,?\s+что\s*/gi, "")
        .replace(/(из|в)\s+(?:айти|it)\s+сфер[аы]?[\w-]*/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim() || toneRewritten
    );
  }

  /**
   * Post-processing guard: strip any phrases listed in settings.customForbiddenPhrases.
   * Uses case-insensitive substring matching and removes the matched segment plus
   * surrounding whitespace.  Returns the text unchanged when no list is configured.
   */
  protected enforceCustomForbiddenPhrases(text: string, settings: AgentSettings): string {
    // Collect all forbidden phrases: flat list + built-in categories + custom categories
    const allPhrases: string[] = [...(settings.customForbiddenPhrases ?? [])];
    for (const cat of settings.builtinForbiddenCategories ?? []) {
      allPhrases.push(...cat.phrases);
    }
    for (const cat of settings.customForbiddenCategories ?? []) {
      allPhrases.push(...cat.phrases);
    }
    if (allPhrases.length === 0) return text;
    let result = text;
    for (const phrase of allPhrases) {
      const trimmed = phrase.trim();
      if (!trimmed) continue;
      // Escape regex special chars and match case-insensitively
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result
        .replace(new RegExp(escaped, "gi"), "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
    return result;
  }

  /**
   * AI-driven offline mode: the manager is unavailable, but the AI continues
   * chatting, qualifies the lead, and collects a convenient callback time.
   *
   * Behaves like runFreeMode but with an offline-aware system prompt:
   *  - AI knows manager's working hours
   *  - Goal: keep the lead warm, collect callback preferences
   *  - Never claims the manager is online
   */
  protected async runOfflineLeadMode(
    chatId: string,
    userText: string,
    chatKey: string,
    settings: AgentSettings,
    diagram?: FlowDiagram,
  ): Promise<string | null> {
    const conversationHistory = this.storage.loadConversationHistory(chatKey);
    // Use full history (up to 50) for rich context analysis
    const recentHistory = conversationHistory.slice(-50);

    const rawDisplayName = this.name.replace(/\s*\(.*?\)\s*/g, "").trim();
    const agentDisplayName =
      rawDisplayName.charAt(0).toUpperCase() + rawDisplayName.slice(1) || rawDisplayName;

    // Full dialogue history for the prompt
    const historyLines = recentHistory
      .map((m) => `${m.role === "user" ? "Клиент" : "Менеджер"}: ${m.content.slice(0, 300)}`)
      .join("\n");

    // All client messages for language detection + signal analysis
    const allClientMessages = recentHistory.filter((m) => m.role === "user").map((m) => m.content);
    const allClientText = [...allClientMessages, userText].join(" ");

    // Manager working hours: explicit fields take priority, fallback to schedule times.
    const from = settings.managerWorkFrom ?? settings.scheduleFrom ?? "?";
    const to = settings.managerWorkTo ?? settings.scheduleTo ?? "?";

    // Check if right now falls within manager working hours so the AI can offer
    // a call today vs. "завтра" (tomorrow only when outside hours).
    const toMinutes = (hhmm: string): number => {
      const [h, m] = hhmm.split(":").map(Number);
      return (h ?? 0) * 60 + (m ?? 0);
    };
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const isWithinManagerHours =
      from !== "?" && to !== "?" ? nowMin >= toMinutes(from) && nowMin < toMinutes(to) : false;

    // When within hours: propose the nearest 30-min slot from now.
    // When outside hours: propose 30 min after opening (not the very edge of the window).
    const proposalTimeWithin = (() => {
      const slot = Math.ceil((nowMin + 15) / 30) * 30; // round up to next 30-min
      const h = Math.floor(slot / 60);
      const m = slot % 60;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    })();
    const proposalTimeOutside = (() => {
      if (from === "?") return "10:00";
      const [h] = from.split(":").map(Number);
      const mid = (h ?? 10) + 1;
      return `${String(mid).padStart(2, "0")}:00`;
    })();

    // Custom task instructions from settings (optional), placeholders replaced.
    const customTask = settings.offlineReplyTemplate
      ? settings.offlineReplyTemplate.replace(/\{от\}/g, from).replace(/\{до\}/g, to)
      : "";

    // Product/service context from the active diagram
    const topicContext = diagram
      ? diagram.nodes
          .filter((n: DiagramNode) => n.type !== "start" && n.type !== "end")
          .map((n: DiagramNode) => `• ${n.text.slice(0, 100)}`)
          .join("\n")
      : "";

    // ── Client signal analysis ───────────────────────────────────────────────
    const turnCount = recentHistory.filter((m) => m.role === "user").length;

    // Buying signals: client shows genuine interest
    const buyingSignals = allClientMessages.filter((t) =>
      /цена|стоимость|сколько|условия|как работ|расскаж|интересно|хочу|могу|попробовать|записат|подход|покупа|заказ|интересует|узнать больше/i.test(
        t,
      ),
    );

    // Objections detected in client messages
    const objections = allClientMessages.filter((t) =>
      /дорого|не нужно|не интересно|подумаю|потом|позже|занят|нет времени|не сейчас|наверное нет|пока не|сомнева/i.test(
        t,
      ),
    );

    // Interest level: high if buying signals > objections, and 2+ exchanges
    const interestLevel: "high" | "medium" | "low" =
      buyingSignals.length > objections.length && turnCount >= 2
        ? "high"
        : objections.length > buyingSignals.length
          ? "low"
          : "medium";

    // ── Callback-time negotiation state ─────────────────────────────────────
    // Matches explicit times (14:30, 14.30) OR bare hour with preposition (после 20, в 9, к 10, около 18)
    const timeRegex =
      /\d{1,2}[:\.]\d{2}|\d{1,2}\s*(?:утра|вечера|дня|ночи|am|pm)|(?:после|в|к|около)\s+(\d{1,2})(?!\d)/i;

    const lastAgentWithTime = [...recentHistory]
      .reverse()
      .find((m) => m.role === "assistant" && timeRegex.test(m.content));
    const timeProposed = !!lastAgentWithTime;

    const positiveReply =
      /\bда\b|ок\b|окей|хорош|подход|отлич|договор|супер|yes\b|ok\b|sure\b|good\b|tamam\b|olur\b|ладно|давай|согласен|норм/i;
    const timeAgreed =
      timeProposed &&
      (() => {
        const idx = recentHistory.lastIndexOf(lastAgentWithTime!);
        return recentHistory
          .slice(idx + 1)
          .some((m) => m.role === "user" && positiveReply.test(m.content));
      })();

    const clientTimeMessages = recentHistory.filter(
      (m) => m.role === "user" && timeRegex.test(m.content),
    );
    const clientMentionedTime = clientTimeMessages.length > 0;

    // Detect if the client's proposed time falls outside the working window.
    // Used to give a much stronger rejection instruction instead of "accept or correct".
    let clientTimeOutsideWindow = false;
    if (clientMentionedTime && from !== "?" && to !== "?") {
      const fromMin = toMinutes(from);
      const toMin = toMinutes(to);
      // Extract the best-guess hour from the client message.
      const hourExtractRe =
        /(?:после|в|к|около)\s+(\d{1,2})(?!\d)|(\d{1,2})[:\.]\d{2}|(\d{1,2})\s*(?:вечера|ночи)/i;
      for (const msg of clientTimeMessages) {
        const m = msg.content.match(hourExtractRe);
        if (m) {
          const rawHour = parseInt(m[1] ?? m[2] ?? m[3] ?? "0", 10);
          const clientMinutes = rawHour * 60; // treat as HH:00 — good enough for window check
          if (clientMinutes < fromMin || clientMinutes >= toMin) {
            clientTimeOutsideWindow = true;
            break;
          }
        }
      }
    }

    // Alias: use within-hours slot if manager is available now, otherwise next-day slot.
    const proposalTime = isWithinManagerHours ? proposalTimeWithin : proposalTimeOutside;

    // Last few agent replies to prevent repeating the same phrasing
    const lastAgentReplies = recentHistory
      .filter((m) => m.role === "assistant")
      .slice(-3)
      .map((m) => m.content.slice(0, 120))
      .join(" | ");

    // ── Determine what to do about scheduling ────────────────────────────────
    // "Tomorrow" phrasing depends on whether manager is working right now.
    // Within hours → call can happen today; outside → strictly tomorrow within window.
    const callWhen = isWithinManagerHours
      ? `сегодня (рабочее время до ${to})`
      : `завтра с ${from} до ${to}`;
    const callWhenShort = isWithinManagerHours
      ? `сегодня в ${proposalTime}`
      : `завтра в ${proposalTime}`;

    // All instructions use first person — the agent IS the manager on the same account.
    let callbackInstruction: string;
    if (timeAgreed) {
      const agreedTime = lastAgentWithTime!.content.match(timeRegex)?.[0] ?? proposalTime;
      const whenLabel = isWithinManagerHours ? "сегодня" : "завтра";
      callbackInstruction =
        `ВРЕМЯ ДОГОВОРЕНО (${agreedTime}). Подтверди одной фразой от первого лица: ` +
        `«Договорились, позвоню тебе ${whenLabel} в ${agreedTime} 👍» — и тепло заверши разговор. ` +
        `Больше не возвращайся к теме звонка. НЕ говори "менеджер".`;
    } else if (clientMentionedTime && !timeProposed) {
      if (clientTimeOutsideWindow && from !== "?" && to !== "?") {
        // Client named a time OUTSIDE the working window — must reject, not just "correct".
        const whenLabel = isWithinManagerHours ? "сегодня" : "завтра";
        callbackInstruction =
          `🚫 КЛИЕНТ ПРЕДЛОЖИЛ ВРЕМЯ ВНЕ РАБОЧЕГО ОКНА (${from}–${to}). ` +
          `ЗАПРЕЩЕНО соглашаться или писать «могу после X» — ни намёком. ` +
          `Ответь твёрдо, но дружелюбно от первого лица: ` +
          `«Эх, в это время я уже не работаю — мой рабочий день до ${to}. ` +
          `Давай лучше созвонимся ${whenLabel} в ${proposalTime}? Удобно?»`;
      } else {
        // Client named a time that IS within the working window — accept it.
        const strictWindow =
          from !== "?" && to !== "?"
            ? `Моё доступное время для звонка: строго с ${from} до ${to}${isWithinManagerHours ? " сегодня" : " завтра"}. `
            : "";
        callbackInstruction =
          `Клиент назвал время, которое входит в рабочее окно. ${strictWindow}` +
          `Подтверди от первого лица: «Отлично, записал! Позвоню в [время]». НЕ говори "менеджер".`;
      }
    } else if (timeProposed) {
      callbackInstruction =
        `Время уже предложено (${callWhenShort}), ответа нет. Не навязывай — сначала ответь по существу, ` +
        `затем мягко: «Кстати, то время тебе ещё актуально, или скорректируем?»`;
    } else if (isWithinManagerHours && (interestLevel === "high" || turnCount >= 3)) {
      callbackInstruction =
        `🟢 Сейчас рабочее время (до ${to}). Интерес клиента высокий — предложи созвон СЕГОДНЯ от первого лица: ` +
        `«Кстати, я сейчас свободен — давай созвонимся в ${proposalTime}? Обсудим детали, ` +
        `минут 10 займёт. Удобно?» НЕ говори "завтра", НЕ упоминай "менеджер".`;
    } else if (!isWithinManagerHours && (interestLevel === "high" || turnCount >= 3)) {
      callbackInstruction =
        `🔴 Сейчас нерабочее время. Предложи созвон ЗАВТРА строго в окне ${from}–${to} от первого лица: ` +
        `«Давай созвонимся завтра в ${proposalTime}? Обсудим детали — минут 10. Удобно?» ` +
        `НЕЛЬЗЯ предлагать время вне диапазона ${from}–${to}. НЕЛЬЗЯ говорить "сейчас". НЕ говори "менеджер".`;
    } else {
      const whenHint = isWithinManagerHours
        ? `Если разговор идёт хорошо, можно упомянуть что ты доступен сегодня до ${to}.`
        : `Если разговор идёт хорошо, можно упомянуть созвон завтра (строго с ${from} до ${to}).`;
      callbackInstruction =
        `Диалог только начался (${turnCount} реплик). Главная задача — заинтересовать. ` +
        `НЕ предлагай созвон прямо сейчас — сначала покажи ценность. ${whenHint}`;
    }

    // Safety reminder injected into the prompt to enforce schedule and first-person voice.
    const hoursGuard =
      from !== "?" && to !== "?"
        ? `СТРОГО: я доступен для звонков только ${callWhen}. ` +
          `Никогда не предлагай и не принимай время вне диапазона ${from}–${to} — ` +
          `даже если клиент сам просит «после 20», «в 21» и т.п. ` +
          `Если клиент назвал время вне окна — ОТКАЗАТЬ и немедленно предложить ${proposalTime} ${isWithinManagerHours ? "сегодня" : "завтра"}. ` +
          `Всегда говори от первого лица ("я", "позвоню", "созвонимся") — никогда "менеджер". ` +
          (isWithinManagerHours
            ? `Я работаю СЕЙЧАС — не говори "завтра" если клиент готов созвониться сегодня.`
            : `Сейчас нерабочее время — не говори что я доступен прямо сейчас.`)
        : "";

    // ── Objection-handling context ────────────────────────────────────────────
    const objectionContext =
      objections.length > 0
        ? `## Возражения клиента:\n${objections.map((o) => `• "${o.slice(0, 100)}"`).join("\n")}\n` +
          `→ Не игнорируй — признай и переформулируй как преимущество. Не спорь.\n\n`
        : "";

    // ── Buying signal context ─────────────────────────────────────────────────
    const signalContext =
      buyingSignals.length > 0
        ? `## Сигналы интереса клиента:\n${buyingSignals.map((s) => `• "${s.slice(0, 100)}"`).join("\n")}\n` +
          `→ Клиент заинтересован — развивай тему, конкретизируй выгоды.\n\n`
        : "";

    // Check if this is a re-engagement reply so we can force a greeting.
    const isReEngagedOffline = this.isReEngagementReply(chatId, settings);

    // Detect dialog stage before building the prompt so we can inject tactical instructions.
    const offlineStage = this.detectDialogStage(recentHistory, { isReEngaged: isReEngagedOffline });

    // The agent IS the manager — same account, first-person throughout.
    const workStatusLine = isWithinManagerHours
      ? `🟢 Сейчас рабочее время (${from}–${to}). Ты доступен — можешь выйти на звонок сегодня.`
      : `🔴 Сейчас нерабочее время. Ты доступен для звонков завтра с ${from} до ${to}.`;

    let systemPrompt =
      `Ты — ${agentDisplayName}, менеджер по продажам. Это ТВОЙ личный аккаунт Telegram — ты и есть тот человек, с кем клиент общается. НЕ бот, НЕ ИИ.\n` +
      `${workStatusLine}\n` +
      `Говори от первого лица: "я позвоню", "я свободен", "давай созвонимся" — НЕ "менеджер позвонит", НЕ "менеджер свяжется".\n\n` +
      // Re-engagement: client replied to our outreach — must greet first.
      (isReEngagedOffline
        ? `## РЕАКТИВАЦИЯ — КЛИЕНТ ОТВЕТИЛ:\n` +
          `Клиент откликнулся на твоё сообщение после паузы. ОБЯЗАТЕЛЬНО поздоровайся в начале ответа — ` +
          `одна тёплая и короткая фраза ("Привет!" / "Рад, что ответил!") — и сразу к делу.\n\n`
        : "") +
      (topicContext ? `## Продукт / услуга (темы для разговора):\n${topicContext}\n\n` : "") +
      objectionContext +
      signalContext +
      (historyLines ? `## Полная история диалога:\n${historyLines}\n\n` : "") +
      `## Текущее сообщение клиента: "${userText.slice(0, 400)}"\n\n` +
      `## КАК ВЕСТИ ДИАЛОГ (обязательно):\n` +
      `• Читай контекст — анализируй что клиент уже спрашивал, что его зацепило, что смущает.\n` +
      `• Отвечай точно на вопрос — не уходи в сторону, не перегружай информацией.\n` +
      `• Показывай ЦЕННОСТЬ, а не характеристики: что клиент получит, какую проблему решит.\n` +
      `• Используй конкретику и цифры где возможно — «в 2 раза быстрее», «за 3 дня», «уже 500 клиентов».\n` +
      `• Будь уверен, дружелюбен, без навязчивости. Задавай максимум ОДИН вопрос за раз.\n` +
      `• Уровень интереса клиента сейчас: ${interestLevel === "high" ? "🔥 высокий" : interestLevel === "medium" ? "🟡 средний" : "❄️ низкий"}.\n\n` +
      `## СЛЕДУЮЩИЙ ШАГ (звонок):\n${callbackInstruction}\n` +
      (hoursGuard ? `\n## РАСПИСАНИЕ (строго соблюдать):\n${hoursGuard}\n` : "") +
      (customTask ? `\n## Доп. инструкции от компании:\n${customTask}\n` : "") +
      `\n## ТАКТИКА НА ЭТОМ ЭТАПЕ (${offlineStage.stageLabel}):\n${offlineStage.stageInstruction}\n\n` +
      `\n## СТРОГО ЗАПРЕЩЕНО:\n` +
      (isWithinManagerHours
        ? `• Говорить что ты недоступен или предлагать только завтра — ты работаешь СЕЙЧАС\n`
        : `• Говорить что ты сейчас онлайн или можешь позвонить прямо сейчас\n`) +
      `• Использовать слово "менеджер" в третьем лице — ты и есть менеджер, говори "я"\n` +
      `• Давать телефонные номера клиенту\n` +
      `• Раскрывать что ты ИИ или бот\n` +
      `• Повторять фразы из последних ответов: "${lastAgentReplies.slice(0, 150)}"\n` +
      `• Отправлять одиночный "?" как сообщение\n` +
      `• Использовать шаблонные фразы: «могу помочь?», «чем могу быть полезен?», «если есть вопросы»\n` +
      `• Упоминать сомнения клиента: "ты сомневался", "ты не был уверен", "колебался" — не сей сомнение\n` +
      `• Предполагать сферу деятельности (IT, айти, бизнес и т.д.) без явного упоминания клиента\n` +
      `• Предлагать дешевле, аналоги или «другие варианты» при ценовом возражении — ты уверен в своём предложении, держись его\n` +
      `• Писать формулировки вида «ты говорил/ты писал/ты упоминал/ты говоришь, что/ты хочешь найти» — вместо этого говори от себя: «давай созвонимся…»\n` +
      `• Предлагать «подстроиться под любое время» или «в любое время» — всегда называй конкретное время в рамках рабочего дня\n\n` +
      `## СОЦИАЛЬНОЕ ДОКАЗАТЕЛЬСТВО (если нужно):\n` +
      `Используй обобщённые формулировки: "многие наши клиенты / люди в похожей ситуации / ваши коллеги уже..." — ` +
      `без привязки к конкретной сфере, если клиент её не называл.\n\n` +
      `## Язык ответа: определи по тексту клиента («${allClientText.slice(0, 150)}») и отвечай СТРОГО на нём.\n\n` +
      `Стиль: профессиональный, живой, уверенный. 2–4 предложения. Без пустых строк.`;

    // Apply full system prompt override if configured (replaces auto-generated static rules)
    if (settings.systemPromptOverride?.trim()) {
      systemPrompt = settings.systemPromptOverride.trim();
    }

    // Inject custom instructions from settings (runOfflineLeadMode)
    if (settings.systemPromptAppend?.trim()) {
      systemPrompt += `\n\n## ДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ:\n${settings.systemPromptAppend.trim()}`;
    }
    if (settings.contextInstructions?.trim()) {
      systemPrompt += `\n\n## КОНТЕКСТ:\n${settings.contextInstructions.trim()}`;
    }
    if (settings.antiHallucinationRules?.trim()) {
      systemPrompt += `\n\n## АНТИ-ГАЛЛЮЦИНАЦИИ (СТРОГО):\n${settings.antiHallucinationRules.trim()}`;
    }

    const workspaceTools = createWorkspaceTools(this.storage.getAgentWorkspaceDir(this.id));
    try {
      const raw = await aiReply(userText, chatKey, systemPrompt, this.storage, workspaceTools);
      // Strip phone numbers unless the guard is disabled by user
      const stripped = this.isBuiltinGuardEnabled("stripPhoneNumbers", settings, true)
        ? raw
            .replace(/(?<!\d)(\+?\d[\d\s\-().]{5,}\d)(?!\d)/g, "")
            .replace(/\s{2,}/g, " ")
            .trim()
        : raw;
      const assumptionSafeReply = this.enforceNoAssumptiveClaims(
        stripped,
        recentHistory,
        userText,
        settings,
      );
      const customSafeReply = this.enforceCustomForbiddenPhrases(assumptionSafeReply, settings);
      // Apply working hours guard before logging so the logged text matches what was sent.
      const finalReply = this.enforceWorkingHours(customSafeReply, settings) || null;

      const offlineSignal = this.getSignalId(recentHistory);
      const replySource = isReEngagedOffline ? "reengagement-reply" : "offline-lead";
      this.logger.info(
        `[TG:${this.name}] offline-lead | chat=${chatId} source=${replySource} ` +
          `stage=${offlineStage.stage} node="${offlineStage.node}" ` +
          `interest=${interestLevel} turns=${turnCount} ` +
          `reEngaged=${isReEngagedOffline} msg="${userText.slice(0, 80)}"`,
      );
      // Emit full ai_reply event so replies appear in "🤖 Лог ответов ИИ".
      this.pushEvent("ai_reply", {
        action: "offline_lead_reply",
        chatId,
        source: replySource,
        node: offlineStage.node,
        stage: offlineStage.stage,
        stageLabel: offlineStage.stageLabel,
        text: finalReply ?? assumptionSafeReply,
        clientText: userText.slice(0, 200),
        signal: offlineSignal,
        signalLabel: this.getSignalLabel(offlineSignal),
        clientMessages: this.getTriggerMessages(recentHistory),
        reEngaged: isReEngagedOffline,
      });
      // Capture lead on phone detection or when time is confirmed
      if (/(?:\+?[\d][\d\s\-()]{6,}\d)/.test(userText) || timeAgreed) {
        void this.extractAndSaveLead(chatId, chatKey);
      }
      return finalReply;
    } catch (e) {
      this.logger.warn(`[TG:${this.name}] offline-lead mode failed: ${String(e)}`);
      return null;
    }
  }

  // ─── Task session management ───────────────────────────────────────────────

  /** Find an active task session for the given chat, if any. */
  protected getTaskSession(chatId: string): TaskSession | undefined {
    const b = this.getBehavior<TaskSessionBehavior>("task_session");
    return b?.sessions.find((s) => s.chatId === chatId && s.status === "active");
  }

  /** Return all task sessions (all statuses). */
  listTaskSessions(): TaskSession[] {
    const b = this.getBehavior<TaskSessionBehavior>("task_session");
    return b?.sessions ?? [];
  }

  /**
   * Insert or update a task session directly in the behaviors array and
   * persist to storage — intentionally does NOT call onBehaviorsChanged so
   * that running bot/userbot connections are not disrupted.
   */
  upsertTaskSession(session: TaskSession): void {
    const b = this.getBehavior<TaskSessionBehavior>("task_session");
    if (b) {
      const idx = b.sessions.findIndex((s) => s.id === session.id);
      if (idx >= 0) {
        b.sessions[idx] = session;
      } else {
        b.sessions.push(session);
      }
    } else {
      const newBehavior: TaskSessionBehavior = {
        type: "task_session",
        enabled: true,
        sessions: [session],
      };
      this.record.behaviors = [...this.record.behaviors, newBehavior];
    }
    this.storage.updateBehaviors(this.id, this.record.behaviors);
  }

  /** Mark a task session as completed and persist. */
  completeTaskSession(sessionId: string): void {
    const b = this.getBehavior<TaskSessionBehavior>("task_session");
    if (!b) return;
    const session = b.sessions.find((s) => s.id === sessionId);
    if (session) {
      session.status = "completed";
      session.completedAt = new Date().toISOString();
      this.storage.updateBehaviors(this.id, this.record.behaviors);
    }
  }

  /**
   * Build a rich system prompt for this agent by loading its workspace files
   * (SOUL.md, AGENTS.md, IDENTITY.md, USER.md, MEMORY.md). Falls back to a
   * minimal default when no workspace files exist.
   *
   * @param task  Optional task description appended as a "## Task" section.
   */
  /**
   * Ensure default workspace files exist for this agent.
   * Called on agent start so the agent has a personality from the first message
   * even before the operator manually edits the files through the UI.
   * Existing files are never overwritten.
   */
  async ensureWorkspaceFiles(): Promise<void> {
    const workspaceDir = this.storage.getAgentWorkspaceDir(this.id);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const defaults: Record<string, string> = {
      "IDENTITY.md": `# Identity\n\nName: ${this.name}\n\nDescribe who ${this.name} is here — their personality, background, and role.`,
      "SOUL.md": `# Persona\n\nDescribe ${this.name}'s personality, values, and communication style here.`,
      "AGENTS.md": `# Instructions\n\n- Speak naturally and conversationally, as a real person would.\n- Remember what the user has told you earlier in the conversation and refer back to it.\n- Ask clarifying questions when something is unclear.\n- Keep responses concise unless the user needs a detailed explanation.\n- Never say you are an AI or a bot unless directly asked.\n- Adapt your tone to match the user — casual with casual people, more structured with technical ones.`,
      "USER.md": `# User Notes\n\n(Update this file with what you learn about the people you regularly talk with — their preferences, context, and ongoing topics.)`,
      "MEMORY.md": `# Memory\n\n(Use this file to store important facts, recurring topics, and key context that you want to remember across sessions.)`,
      // Placeholder files kept empty so they don't show as MISSING in the Files UI.
      // They are not read by buildRichSystemPrompt but are listed in TelegramPlugin.CORE_FILE_NAMES.
      "TOOLS.md": `# Tools\n\n(List any tool instructions here if needed.)`,
      "HEARTBEAT.md": `# Heartbeat\n\n(Use this file for periodic reminders or scheduled behavior instructions.)`,
      "BOOTSTRAP.md": `# Bootstrap\n\n(One-time initialization notes go here.)`,
    };

    for (const [filename, content] of Object.entries(defaults)) {
      const filePath = path.join(workspaceDir, filename);
      try {
        await fs.promises.access(filePath);
        // File already exists — do not overwrite operator's edits.
      } catch {
        await fs.promises.writeFile(filePath, content, "utf-8");
        this.logger.info(`[TG:${this.name}] created default workspace file: ${filename}`);
      }
    }
  }

  /**
   * Build a rich system prompt for this agent by loading its workspace files
   * (SOUL.md, AGENTS.md, IDENTITY.md, USER.md, MEMORY.md). Falls back to a
   * minimal default when no workspace files exist.
   *
   * @param task         Optional task description appended as a "## Task" section.
   * @param chatKey      Optional per-user chat key; when provided, injects the
   *                     last N turns of that user's conversation history so the
   *                     agent can reference prior exchanges in its replies.
   * @param extraContext Optional extra section to append (e.g. writing-style
   *                     examples fetched from real Telegram message history).
   */
  protected async buildRichSystemPrompt(
    task?: string,
    chatKey?: string,
    extraContext?: string,
  ): Promise<string> {
    const workspaceDir = this.storage.getAgentWorkspaceDir(this.id);
    const sections: string[] = [];

    const identity = await this.readWorkspaceFile(workspaceDir, "IDENTITY.md");
    if (identity) sections.push(`## Identity\n${identity}`);

    const soul = await this.readWorkspaceFile(workspaceDir, "SOUL.md");
    if (soul) sections.push(`## Persona\n${soul}`);

    const agents = await this.readWorkspaceFile(workspaceDir, "AGENTS.md");
    if (agents) sections.push(`## Instructions\n${agents}`);

    const user = await this.readWorkspaceFile(workspaceDir, "USER.md");
    if (user) sections.push(`## User\n${user}`);

    const memory = await this.readWorkspaceFile(workspaceDir, "MEMORY.md");
    if (memory) sections.push(`## Memory\n${memory}`);

    // Inject a brief summary of the most recent exchanges with this user so the
    // agent can reference them naturally (e.g. "as I mentioned earlier…").
    // We include only the last 6 turns to keep the prompt compact.
    if (chatKey) {
      const history = this.storage.loadConversationHistory(chatKey);
      if (history.length > 0) {
        const recent = history.slice(-6);
        const lines = recent.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.content}`);
        sections.push(`## Recent conversation with this user\n${lines.join("\n")}`);
      }
    }

    // Inject extra context supplied by the caller (e.g. partner's writing style).
    if (extraContext) {
      sections.push(extraContext);
    }

    if (task) {
      sections.push(
        `## Task\n${task}\n\n` +
          `Conduct a helpful, focused conversation to complete this task. ` +
          `Once the task is complete, clearly inform the user.`,
      );
    }

    // Inject diagram flow + knowledge base so the agent strictly follows the
    // sales/conversation script and uses grounded training examples in replies.
    const kbSection = await this.buildKnowledgeBaseSection();
    if (kbSection) sections.push(kbSection);

    if (sections.length === 0) {
      // No workspace files configured — use sensible fallbacks.
      return task
        ? `You are a Telegram assistant. You have been assigned the following task:\n\n${task}\n\n` +
            `Conduct a helpful, focused conversation to complete this task. ` +
            `Once the task is complete, clearly inform the user.`
        : "You are a helpful Telegram assistant. Be concise and friendly.";
    }

    return (
      `Ты — опытный менеджер (живой человек). Говори уверенно и по делу.\n` +
      `ЯЗЫК: Всегда отвечай на том языке, на котором пишет клиент — определяй по его последнему сообщению.\n` +
      `НИКОГДА не повторяй слова клиента в ответе. НИКОГДА не дублируй свои предыдущие сообщения.\n\n` +
      sections.join("\n\n")
    );
  }

  /**
   * Build a system-prompt section that injects the diagram flow and its
   * knowledge base (training examples per node) into the conversation context.
   *
   * Priority: personal KB first; falls back to shared KB when personal is empty.
   * Returns an empty string when no diagram or knowledge base is configured.
   */
  private async buildKnowledgeBaseSection(): Promise<string> {
    // When the operator has pinned a specific diagram via agent settings, load
    // that diagram directly instead of scanning by scope.
    const agentSettings = this.getAgentSettings();
    if (agentSettings.activeDiagramId) {
      const pinned = this.storage.getDiagramById(agentSettings.activeDiagramId);
      if (pinned && pinned.nodes.length > 0) {
        return this._buildKBFromDiagram(pinned);
      }
    }

    // Try personal scope first, then shared
    for (const scope of ["personal", "shared"] as const) {
      const diagram = this.storage.getDiagram(this.id, scope);
      if (!diagram || diagram.nodes.length === 0) continue;
      const section = this._buildKBFromDiagram(diagram);
      if (section) return section;
    }
    return "";
  }

  /**
   * Convert a FlowDiagram + its associated knowledge base into a system-prompt
   * section string. Returns "" when the KB is empty or missing.
   */
  private _buildKBFromDiagram(diagram: FlowDiagram): string {
    const kbKey = `${diagram.agentId}:${diagram.scope}`;
    const now = Date.now();
    let raw: Record<string, unknown> | null;
    if (
      this._kbCache &&
      this._kbCache.key === kbKey &&
      now - this._kbCache.ts < BaseAgent.CACHE_TTL_MS
    ) {
      raw = this._kbCache.data as Record<string, unknown> | null;
    } else {
      raw = this.storage.getKnowledgeBase(diagram.agentId, diagram.scope as "personal" | "shared");
      this._kbCache = { key: kbKey, data: raw, ts: now };
    }
    if (!raw) return "";

    const entries = raw.entries as
      | Array<{
          nodeId: string;
          nodeText: string;
          pairs: Array<{ input: string; response: string; score: number; label?: string }>;
        }>
      | undefined;
    if (!entries || entries.length === 0) return "";

    const scoreLabel = (s: number) => (s === 3 ? "★★★" : s === 2 ? "★★" : "★");
    const nodeLines: string[] = [];
    for (const node of diagram.nodes) {
      nodeLines.push(`• [${node.type.toUpperCase()}] ${node.text}`);
    }
    const edgeLines = diagram.edges
      .map((e: DiagramEdge) => {
        const src = diagram.nodes.find((n: DiagramNode) => n.id === e.sourceId)?.text ?? e.sourceId;
        const tgt = diagram.nodes.find((n: DiagramNode) => n.id === e.targetId)?.text ?? e.targetId;
        return `  ${src} → ${tgt}${e.label ? ` (${e.label})` : ""}`;
      })
      .join("\n");

    const kbParts: string[] = [];
    for (const entry of entries) {
      if (!entry.pairs || entry.pairs.length === 0) continue;
      // Show only the RESPONSE (the offer/script) — not the input question.
      // The agent must use these as ready-made offer scripts to adapt and send,
      // NOT as question templates to interrogate the client.
      const pairLines = entry.pairs
        .slice(0, 5)
        .map((pr) => `  ${scoreLabel(pr.score)} СКРИПТ (отправить клиенту): ${pr.response}`)
        .join("\n");
      kbParts.push(`### ${entry.nodeText}\n${pairLines}`);
    }
    if (kbParts.length === 0) return "";

    const scopeLabel = diagram.scope === "shared" ? "Shared" : "Personal";

    // Load coaching tips for this scope (cached 5 min to reduce DB load).
    const coachKey = `${diagram.agentId}:${diagram.scope}`;
    let coachingTips: Record<string, { content: string; generatedAt: string }>;
    if (
      this._coachCache &&
      this._coachCache.key === coachKey &&
      now - this._coachCache.ts < BaseAgent.CACHE_TTL_MS
    ) {
      coachingTips = this._coachCache.data as typeof coachingTips;
    } else {
      coachingTips = this.storage.getCoachingTips(
        diagram.agentId,
        diagram.scope as "personal" | "shared",
      );
      this._coachCache = { key: coachKey, data: coachingTips, ts: now };
    }
    const tipValues = Object.values(coachingTips)
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
      .slice(0, 5);
    const coachingSection =
      tipValues.length > 0
        ? `\n\n## Уроки из прошлых диалогов (советы тренера)\n` +
          `Учти эти наблюдения из разбора реальных переписок:\n\n` +
          tipValues.map((t, i) => `### Диалог ${i + 1}\n${t.content}`).join("\n\n")
        : "";

    return (
      `## Схема разговора (${scopeLabel})\n` +
      `Следуй этой схеме строго в ходе беседы:\n` +
      nodeLines.join("\n") +
      (edgeLines ? `\nПереходы:\n${edgeLines}` : "") +
      `\n\n## База скриптов топ-менеджеров по шагам\n` +
      `ВАЖНО: Это ГОТОВЫЕ ОФФЕРЫ которые нужно ОТПРАВИТЬ клиенту — это НЕ вопросы к клиенту.\n` +
      `Возьми скрипт из нужного шага, переведи на язык клиента, адаптируй и отправь.\n` +
      `Чем выше ★ — тем лучше результат. ЗАПРЕЩЕНО превращать скрипт в вопрос.\n\n` +
      kbParts.join("\n\n") +
      coachingSection
    );
  }

  /**
   * Generate and persist a structured memory note for this client after a
   * schema session completes. Runs in the background (fire-and-forget).
   *
   * Uses the last 20 messages from the conversation to produce a concise
   * structured note (name, interests, outcome, next action). Notes from
   * multiple sessions accumulate (newest first, capped at 600 chars) so
   * the agent has a growing picture of who the client is over time.
   */
  protected async saveSessionMemory(
    chatId: string,
    chatKey: string,
    previousMemory: { memoryText: string; sessionsCount: number } | null,
  ): Promise<void> {
    const history = this.storage.loadConversationHistory(chatKey);
    if (history.length < 2) return; // too short to be worth summarising

    const messages = history
      .slice(-20)
      .map((m) => `${m.role === "user" ? "Клиент" : "Менеджер"}: ${m.content.slice(0, 200)}`)
      .join("\n");

    // Buyer mode: capture sales-specific signals alongside standard facts.
    const isBuyerMode = this.getAgentSettings().schemaDeliveryStyle === "buyer";
    const buyerExtra = isBuyerMode
      ? `• Ценовая чувствительность: упоминал ли цену / бюджет / «дорого»?\n` +
        `• Готовность к сделке: насколько близко к закрытию (холодный / тёплый / горячий)?\n` +
        `• Доминирующее возражение: цена / сомнения / откладывает / нужно согласовать / конкурент?\n` +
        `• ROI-интерес: спрашивал ли о результатах, цифрах, сроках окупаемости?\n`
      : "";

    const prompt =
      `Ниже — диалог менеджера с клиентом. Составь краткую структурированную заметку (4-6 пунктов) о клиенте для памяти агента.\n` +
      `Включи: имя/контакт (если упоминалось), что интересовало клиента, ключевые возражения или вопросы, итог разговора, рекомендуемое следующее действие.\n` +
      buyerExtra +
      `Пиши коротко и конкретно. Максимум 250 символов. Только факты.\n\n` +
      `${messages}`;

    try {
      const summary = await analyzeOnceDirect(prompt);
      const sessionsCount = (previousMemory?.sessionsCount ?? 0) + 1;

      // Prepend new summary; keep last 2 session notes (newest first).
      const prevText = previousMemory?.memoryText ?? "";
      const separator = prevText ? "\n---\n" : "";
      const combined = `[Сессия ${sessionsCount}] ${summary.slice(0, 250)}${separator}${prevText}`;

      this.storage.saveChatMemory(this.id, chatId, combined.slice(0, 600), sessionsCount);
      this.logger.info(
        `[TG:${this.name}] saved chat memory for ${chatId} (session ${sessionsCount})`,
      );
    } catch (e) {
      this.logger.warn(`[TG:${this.name}] failed to save chat memory: ${String(e)}`);
    }
  }

  /** Read a file from the agent workspace directory, returning "" when absent. */
  private async readWorkspaceFile(workspaceDir: string, name: string): Promise<string> {
    try {
      const content = await fs.promises.readFile(path.join(workspaceDir, name), "utf-8");
      return content.trim();
    } catch (err: unknown) {
      // Silently skip missing files; log anything unexpected.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn(`[TG:${this.name}] could not read workspace file ${name}`, {
          e: err instanceof Error ? err.message : String(err),
        });
      }
      return "";
    }
  }

  protected pushEvent(type: TelegramEvent["type"], payload: Record<string, unknown>) {
    const event: TelegramEvent = {
      agentId: this.id,
      agentName: this.name,
      type,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.storage.saveEvent(event);
    this.emit("event", event);
  }

  protected trackMessage(direction: "in" | "out", text: string, chat?: string) {
    this.storage.incrementStat(this.id, direction === "in" ? "received" : "sent");
    this.pushEvent(direction === "in" ? "message_in" : "message_out", {
      text, // full text, no truncation
      chatId: chat,
    });
    // Hook for subclasses — called on every outgoing message with a known chatId.
    if (direction === "out" && chat) {
      this.onOutgoingMessage(chat);
    }
  }

  /**
   * Called whenever the agent sends a message to a chat.
   * Subclasses can override to perform side effects (e.g. folder management).
   */
  protected onOutgoingMessage(_chatId: string): void {
    // no-op in base class
  }

  protected shouldAutoReply(cfg: AutoReplyBehavior, text: string, chatId?: string): boolean {
    if (!cfg.enabled) return false;
    if (cfg.onlyInChats?.length && chatId && !cfg.onlyInChats.includes(chatId)) return false;
    if (cfg.triggerKeywords?.length) {
      const low = text.toLowerCase();
      return cfg.triggerKeywords.some((k) => low.includes(k.toLowerCase()));
    }
    return true;
  }

  protected delay(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Returns true if the agent should engage with this chat based on the
   * replyTo setting:
   *   "all"   → always true
   *   "tasks" → only when the chat has an active task session assigned
   */
  protected isAllowedChat(chatId: string, settings: AgentSettings): boolean {
    if (settings.replyTo !== "tasks") return true;
    return !!this.getTaskSession(chatId);
  }

  // ─── Schema work-mode: strict script execution ───────────────────────────

  /**
   * Extract KB response pairs for a specific node from the diagram's knowledge
   * base, sorted best-score first (3 = ★★★ > 2 = ★★ > 1 = ★).
   * Returns [] when no KB data exists for this node.
   */
  private getNodeKbPairs(
    diagram: FlowDiagram,
    nodeId: string,
  ): Array<{ input: string; response: string; score: number }> {
    const raw = this.storage.getKnowledgeBase(
      diagram.agentId,
      diagram.scope as "personal" | "shared",
    );
    if (!raw) return [];
    const entries = raw.entries as
      | Array<{
          nodeId: string;
          pairs: Array<{ input: string; response: string; score: number }>;
        }>
      | undefined;
    if (!entries) return [];
    const entry = entries.find((e) => e.nodeId === nodeId);
    if (!entry?.pairs?.length) return [];
    return [...entry.pairs].sort((a, b) => b.score - a.score);
  }

  /**
   * Rule-based reply validation for strict schema mode — no AI call, runs fast.
   * Returns an array of violation descriptions; empty = valid.
   */
  private validateStrictReply(reply: string, nodeType: string): string[] {
    const v: string[] = [];
    if (!reply.trim()) {
      v.push("пустой ответ");
      return v;
    }
    // AI self-identification is forbidden in a sales/support script
    if (
      /я\s+(языков\w+\s+модел|ии\b|ai\b|бот\b)/i.test(reply) ||
      /как\s+(языков\w+\s+модел|ии|ai)/i.test(reply)
    ) {
      v.push("содержит идентификацию ИИ (запрещено по скрипту)");
    }
    // Apologies / refusals are off-script
    if (/к\s*сожалению,?\s+я|я\s+не\s+могу|невозможно|не\s+в\s+силах/i.test(reply)) {
      v.push("содержит извинение или отказ, не предусмотренный скриптом");
    }
    // Excessive length — non-end nodes should stay under 6 sentences
    if (nodeType !== "end") {
      const sentences = reply.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 3);
      if (sentences.length > 6) {
        v.push(`слишком длинный ответ: ${sentences.length} предл. (лимит 6)`);
      }
    }
    return v;
  }

  /**
   * Execute the current step of the active conversation script (schema mode).
   *
   * Called on every incoming message when useSchema is true.  Looks up (or
   * initialises) the per-chat position in the active diagram, builds a strict
   * step-execution prompt — injecting top-scored KB templates when available —
   * generates the AI reply, validates it (in strict mode), rebuilds when
   * violations are found, then advances the state machine to the next node.
   *
   * Logs the active node, reply source (template / generated / rebuilt), and
   * validation result to make the agent's behaviour fully observable.
   *
   * Returns the reply string, or null when schema mode is inactive / no
   * diagram is configured.
   */
  protected async runScriptStep(
    chatId: string,
    userText: string,
    chatKey: string,
  ): Promise<string | null> {
    const settings = this.getAgentSettings();
    if (!settings.useSchema) {
      this.logger.debug?.(`[TG:${this.name}] runScriptStep: useSchema=false, skipping`);
      return null;
    }
    if (!settings.activeDiagramId) {
      this.logger.warn(`[TG:${this.name}] runScriptStep: schema mode on but no activeDiagramId`);
      return null;
    }

    // Detect re-engagement reply once — used throughout this function to force a
    // greeting and adjust prompt rules.
    const isReEngaged = this.isReEngagementReply(chatId, settings);

    // Working-hours gate: if the manager has configured work hours and the current
    // time is outside that window, stay silent.  The human manager will reply when
    // available.  (If offlineReplyEnabled is set, the caller routes to
    // runOfflineLeadMode instead, so we never reach here in that case.)
    if (settings.managerWorkFrom && settings.managerWorkTo) {
      const parseMin = (t: string) => {
        const [h, m] = t.split(":").map(Number);
        return (h ?? 0) * 60 + (m ?? 0);
      };
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const wfMin = parseMin(settings.managerWorkFrom);
      const wtMin = parseMin(settings.managerWorkTo);
      const withinHours = nowMin >= wfMin && nowMin < wtMin;
      if (!withinHours) {
        this.logger.info(
          `[TG:${this.name}] runScriptStep: outside working hours ` +
            `(${settings.managerWorkFrom}–${settings.managerWorkTo}), skipping | ` +
            `chat=${chatId} msg="${userText.slice(0, 80)}"`,
        );
        return null;
      }
    }

    // Working-hours context — injected into adaptScript prompt so KB replies
    // also refuse times outside the configured window.
    const schemaWorkFrom = settings.managerWorkFrom ?? "?";
    const schemaWorkTo = settings.managerWorkTo ?? "?";
    const schemaHoursGuard = (() => {
      if (schemaWorkFrom === "?" || schemaWorkTo === "?") return "";
      const toMin = (t: string) => {
        const [h, m] = t.split(":").map(Number);
        return (h ?? 0) * 60 + (m ?? 0);
      };
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const within = nowMin >= toMin(schemaWorkFrom) && nowMin < toMin(schemaWorkTo);
      const whenLabel = within ? "сегодня" : "завтра";
      return (
        `\n## РАБОЧИЕ ЧАСЫ (СТРОГО):\n` +
        `Я доступен для звонков только с ${schemaWorkFrom} до ${schemaWorkTo} ${whenLabel}. ` +
        `ЗАПРЕЩЕНО соглашаться на любое время вне этого окна — даже если клиент сам называет его. ` +
        `Если клиент предлагает время вне окна (например, «после 20», «в 21», «в 22»), ` +
        `немедленно вежливо откажи и предложи время внутри окна ${schemaWorkFrom}–${schemaWorkTo}. ` +
        `Никогда не пиши «могу после X» если X > ${schemaWorkTo}.\n`
      );
    })();

    const diagram = this.storage.getDiagramById(settings.activeDiagramId);
    if (!diagram) {
      this.logger.warn(
        `[TG:${this.name}] runScriptStep: diagram ${settings.activeDiagramId} not found`,
      );
      return null;
    }
    if (diagram.nodes.length === 0) {
      this.logger.warn(`[TG:${this.name}] runScriptStep: diagram has no nodes`);
      return null;
    }

    // Strict mode: validates + rebuilds replies that violate script rules.
    const strict = settings.schemaStrictMode ?? false;

    // Entry point: prefer "start" node; fall back to first node so that
    // diagrams without an explicit start marker still work.
    const startNode =
      diagram.nodes.find((n: DiagramNode) => n.type === "start") ?? diagram.nodes[0];
    if (!startNode) return null;

    // Resolve current position in the schema.
    // "__done__" = schema completed, run in free continuation mode (no node).
    const savedNodeId = this.storage.getConversationNodeId(this.id, chatId);
    const schemaCompleted = savedNodeId === "__done__";

    // ── FREE CONTINUATION after schema completion ──────────────────────────
    // When all schema nodes are done but client keeps writing, continue the
    // conversation naturally using the full script as background knowledge.
    if (schemaCompleted) {
      return this.runFreeMode(chatId, userText, chatKey, diagram);
    }

    let resolvedNode: DiagramNode =
      (savedNodeId ? diagram.nodes.find((n: DiagramNode) => n.id === savedNodeId) : null) ??
      startNode;

    // ── Conversation history + time context ───────────────────────────────
    const conversationHistory = this.storage.loadConversationHistory(chatKey);

    // Detect dialog stage once — used in all pushEvent calls for observability.
    const dialogStage = this.detectDialogStage(conversationHistory, { isReEngaged });

    // Compute time elapsed since the last message — injected into prompts so
    // the agent can say "после нашего разговора вчера..." naturally.
    const lastAt = this.storage.getConversationLastAt(chatKey);
    let timeSinceLastMsg = "";
    if (lastAt && conversationHistory.length > 0) {
      const diffMs = Date.now() - new Date(lastAt).getTime();
      const diffMin = Math.floor(diffMs / 60_000);
      if (diffMin < 2) {
        timeSinceLastMsg = "только что";
      } else if (diffMin < 60) {
        timeSinceLastMsg = `${diffMin} минут назад`;
      } else if (diffMin < 1440) {
        const h = Math.floor(diffMin / 60);
        timeSinceLastMsg = `${h} ${h === 1 ? "час" : h < 5 ? "часа" : "часов"} назад`;
      } else {
        const d = Math.floor(diffMin / 1440);
        timeSinceLastMsg = `${d} ${d === 1 ? "день" : d < 5 ? "дня" : "дней"} назад`;
      }
    }

    // ── Off-schema question detection ────────────────────────────────────
    // When client asks the AGENT something personal (name, who are you, etc.),
    // answer it directly from identity context — don't ignore it and push script.
    const offSchemaPatterns =
      /\b(как.*тебя.*зовут|твоё?.*имя|кто.*ты|who are you|what.*your name|как тебя звать|ты кто)\b/i;
    const isOffSchemaQuestion = offSchemaPatterns.test(userText);

    // ── Flexible routing: jump to a better-matching node when the client's
    // message is far more relevant to another node's KB than the current one.
    // Only in non-strict mode; strict mode always follows the linear path.
    let currentNode = resolvedNode;
    if (!strict && !isOffSchemaQuestion) {
      const flexNode = this.flexibleNodeRoute(userText, diagram, resolvedNode);
      if (flexNode.id !== resolvedNode.id) {
        this.logger.info(
          `[TG:${this.name}] flex-route | chat=${chatId} ` +
            `${resolvedNode.id}→${flexNode.id} "${flexNode.text.slice(0, 50)}"`,
        );
        this.storage.setConversationNodeId(this.id, chatId, flexNode.id);
        currentNode = flexNode;
      }
    }

    const isDecision = currentNode.type === "decision";
    const isEnd = currentNode.type === "end";

    this.logger.info(
      `[TG:${this.name}] schema | chat=${chatId} node=[${currentNode.type}] "${currentNode.text.slice(0, 60)}" strict=${strict}`,
    );

    // ── KB top-response lookup ─────────────────────────────────────────────
    // All KB pairs for this node, sorted best-score first.
    // ANY score (1–3) is now eligible for verbatim use — the user wants strict KB.
    const kbPairs = this.getNodeKbPairs(diagram, currentNode.id);
    const topPairs = kbPairs.filter((p) => p.score >= 2).slice(0, 4);
    const hasTemplates = topPairs.length > 0;
    const scriptTemplate = topPairs.find((p) => p.score === 3);

    // ── Per-client long-term memory (survives restarts) ────────────────────
    const chatMemory = this.storage.getChatMemory(this.id, chatId);

    // ── Outgoing edges (BRANCH routing + next-step context) ───────────────
    const outEdges = diagram.edges.filter((e: DiagramEdge) => e.sourceId === currentNode.id);
    const nextNodes = outEdges
      .map((e: DiagramEdge) => ({
        edge: e,
        node: diagram.nodes.find((n: DiagramNode) => n.id === e.targetId),
      }))
      .filter(
        (x: {
          edge: DiagramEdge;
          node: DiagramNode | undefined;
        }): x is { edge: DiagramEdge; node: DiagramNode } => x.node !== undefined,
      );

    // ── Template selection — randomise among equally top-scored entries ──────
    // Always using topPairs[0] makes every reply identical. Rotate among best
    // options so the agent sounds natural across multiple turns.
    const pickTemplate = (pool: typeof topPairs): (typeof topPairs)[0] | undefined => {
      if (pool.length === 0) return undefined;
      const topScore = pool[0].score;
      const topTier = pool.filter((p) => p.score === topScore);
      return topTier[Math.floor(Math.random() * topTier.length)];
    };
    const bestTemplate = pickTemplate(topPairs) ?? kbPairs[0];

    // ── Extract known client facts from all their messages ────────────────
    // Used to prevent re-asking for info already given (age, name, phone, etc.)
    const extractClientFacts = (): string => {
      const allMsgs = conversationHistory
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .concat(userText)
        .join(" ");

      const facts: string[] = [];

      // Name: "я Дима", "меня зовут Алексей", "my name is ...", "я — Иван"
      const nameMatch = allMsgs.match(
        /(?:я\s+[—-]?\s*|меня зовут\s+|my name is\s+|ben\s+)([А-ЯЁA-Z][а-яёa-z]{1,20})/i,
      );
      if (nameMatch) facts.push(`Имя: ${nameMatch[1]}`);

      // Age: "мне 21", "мне 21 год", "21 лет", "21 yaş", "i'm 30"
      const ageMatch =
        allMsgs.match(
          /(?:мне\s+|i(?:'m| am)\s+|age\s*[=:]\s*|yaş[ım]*\s*)(\d{1,3})(?:\s*(?:лет|год|года|years?|yaş))?/i,
        ) ?? allMsgs.match(/\b(\d{1,3})\s*(?:лет|года?|years?)\b/i);
      if (ageMatch) facts.push(`Возраст: ${ageMatch[1]}`);

      // Phone: sequences of 7+ digits (with optional +, -, spaces)
      const phoneMatch = allMsgs.match(/(?:\+?\d[\d\s\-()]{6,}\d)/);
      if (phoneMatch) facts.push(`Телефон: ${phoneMatch[0].trim()}`);

      // Profession/sphere: "я из айти", "работаю в IT", "занимаюсь"
      const profMatch = allMsgs.match(
        /(?:я из\s+|работаю\s+(?:в|на)\s+|занимаюсь\s+|сфера\s*[—:\-]\s*)([А-ЯЁA-Za-zа-яё\s]{2,25})/i,
      );
      if (profMatch) facts.push(`Сфера: ${profMatch[1].trim()}`);

      return facts.join(" | ");
    };

    /**
     * Adapt a KB script to the live conversation context.
     *
     * Core rules:
     *  - Use the KB template as the main message body — do NOT invent content
     *  - Add one bridge sentence reacting to client's last message
     *  - Never re-ask for facts the client already provided
     *  - Never hallucinate phone numbers, names, addresses
     *  - Output two paragraphs separated by \n\n (splitMessage handles the split)
     */
    /**
     * Strip phone-number-like sequences from a manager reply.
     * Managers must never share phone numbers in their messages.
     */
    const stripPhoneNumbers = (text: string): string => {
      // Respect user override for phone-stripping guard
      if (!this.isBuiltinGuardEnabled("stripPhoneNumbers", settings, true)) return text;
      return text
        .replace(/(?<!\d)(\+?\d[\d\s\-().]{5,}\d)(?!\d)/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    };

    const adaptScript = async (template: string): Promise<string> => {
      // Last 50 messages — preserve as much context as possible.
      const recentHistory = conversationHistory.slice(-50);

      // All client text for language detection (history + current)
      const allClientText = recentHistory
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join(" ")
        .concat(" ", userText)
        .slice(0, 600);

      // Full history lines for context (last 20 turns)
      const historyLines = recentHistory
        .map((m) => `${m.role === "user" ? "Клиент" : "Менеджер"}: ${m.content.slice(0, 250)}`)
        .join("\n");

      // What was the LAST topic the manager raised? (for "не разбираюсь в этом" type replies)
      const lastManagerMsg =
        [...recentHistory]
          .reverse()
          .find((m) => m.role === "assistant")
          ?.content.slice(0, 150) ?? "";

      const greetingDone = recentHistory.some(
        (m) =>
          m.role === "assistant" && /привет|здравств|рад|добрый|merhaba|hello/i.test(m.content),
      );

      const prevPhrases = recentHistory
        .filter((m) => m.role === "assistant")
        .map((m) => m.content.slice(0, 100))
        .join(" | ");

      const knownFacts = extractClientFacts();

      const endNode =
        diagram.nodes.find((n: DiagramNode) => n.type === "end") ??
        diagram.nodes[diagram.nodes.length - 1];
      const goalText = endNode && endNode.id !== currentNode.id ? endNode.text : "";

      // ── Off-schema: client asked the AGENT a personal question ────────────
      if (isOffSchemaQuestion) {
        const identityPrompt =
          `Ты — менеджер по продажам (живой человек, не бот).\n` +
          `Клиент спросил тебя: "${userText}"\n\n` +
          `Язык клиента (определи по всем сообщениям): "${allClientText}"\n\n` +
          (historyLines ? `История:\n${historyLines}\n\n` : "") +
          `Абзац 1: Ответь на вопрос клиента — представься реалистичным именем менеджера.\n` +
          `Абзац 2: Продолжи по теме шага: "${currentNode.text}".\n\n` +
          `СТРОГО ЗАПРЕЩЕНО: придумывать телефоны, адреса, паспортные данные.\n` +
          `Пиши на языке клиента. Два абзаца через пустую строку. Без заголовков.`;
        try {
          return (await analyzeOnceDirect(identityPrompt)).trim() || template;
        } catch {
          return template;
        }
      }

      // Detect already-confirmed arrangements (call times, dates) in the
      // last 10 turns so we never re-verify what's been agreed.
      const confirmedAgreements = (() => {
        const agreed: string[] = [];
        const agreedPattern =
          /(?:созвон|звонок|позвоним|созваниваемся|договорились|ок,?\s+до|хорошо,?\s+до|отлично,?\s+до|жду звонка|буду ждать)[^.!?\n]{0,80}/gi;
        const timeWithConfirmation =
          /(?:в\s+\d{1,2}[:\.]\d{2}|в\s+\d{1,2}\s*(?:утра|вечера|дня|ночи))[^.!?\n]{0,40}(?:договорились|ок|хорошо|отлично|принял)/gi;
        for (const m of recentHistory) {
          const m1 = m.content.match(agreedPattern);
          if (m1) agreed.push(...m1.map((s) => s.trim().slice(0, 80)));
          const m2 = m.content.match(timeWithConfirmation);
          if (m2) agreed.push(...m2.map((s) => s.trim().slice(0, 80)));
        }
        return [...new Set(agreed)].slice(0, 3).join("; ");
      })();

      // Detect client language script for post-processing safety check.
      // True = client uses Cyrillic (Russian/Ukrainian/etc); false = Latin/other.
      const clientUsesCyrillic = /[а-яёА-ЯЁ]{3,}/.test(allClientText);

      // Turkish-specific characters that must never appear in a Russian response.
      // ç ş ğ ı İ Ğ Ş Ç are exclusive to Turkish/Azerbaijani — not in Russian alphabet.
      const hasTurkishChars = (s: string) => /[çşğıİĞŞÇ]/.test(s);

      // Known Turkish/foreign words that must never appear in a Russian response.
      const foreignWordPattern =
        /\b(?:değilim|değil|benim|senim|için|ama|fakat|şimdi|hayırsever|adım|yaşım|numaram|yatırım|deneyim|hakkında|nasıl|neden|teşekkür|müsaitim|müsait|uygun|tamam|tabii|efendim|buyurun|merhaba(?!\s+(?:arkadaş|dostum)))\b/i;

      /**
       * Ensure the response is in the client's language.
       * Handles three cases:
       *  A) Contains Turkish-exclusive chars (ç ş ğ ı) → full translate
       *  B) Fully foreign text (no Cyrillic) → full translate
       *  C) Mixed — strip sentences/lines that contain foreign words or Turkish chars
       */
      const ensureClientLanguage = async (text: string): Promise<string> => {
        if (!clientUsesCyrillic) return text; // client not Cyrillic → pass through

        const hasForeign = foreignWordPattern.test(text) || hasTurkishChars(text);
        const cyrillicRatio = (text.match(/[а-яёА-ЯЁ]/g)?.length ?? 0) / Math.max(text.length, 1);

        // Case A/B: Turkish chars present OR almost no Cyrillic → full translate
        if (hasTurkishChars(text) || (cyrillicRatio < 0.3 && /[a-zA-Z]{4,}/.test(text))) {
          try {
            const translated = await analyzeOnceDirect(
              `Переведи на русский язык, убери любые турецкие слова. Верни ТОЛЬКО перевод:\n\n${text}`,
            );
            return translated.trim() || text;
          } catch {
            return text;
          }
        }

        // Case C: mixed — strip sentences/lines that contain foreign words or Turkish chars
        if (hasForeign) {
          const cleaned = text
            .split(/\n/)
            .map((line) => {
              if (hasTurkishChars(line) || foreignWordPattern.test(line)) return "";
              return line
                .split(/(?<=[.!?])\s+/)
                .filter((s) => !foreignWordPattern.test(s) && !hasTurkishChars(s))
                .join(" ");
            })
            .filter(Boolean)
            .join("\n")
            .trim();
          return cleaned || text;
        }

        return text;
      };

      // ── Normal path: KB script + bridge sentence ───────────────────────────
      // Check greeting over the FULL conversation history (not just recent slice)
      // so "Рад снова вас видеть" is never repeated even in long conversations.
      // Exception: re-engagement replies always start with a greeting even if one
      // was sent before — the silence period creates a fresh conversational context.
      const greetingInFullHistory = isReEngaged
        ? false
        : conversationHistory.some(
            (m) =>
              m.role === "assistant" &&
              /привет|здравств|рад|добрый|merhaba|hello|hola|bonjour/i.test(m.content),
          );

      // Cliché phrases that professional managers avoid.
      const clicheBlacklist = [
        "Рад снова тебя слышать",
        "Рад снова вас слышать",
        "Рад снова вас видеть",
        "Рад снова тебя видеть",
        "Как дела",
        "Чем могу помочь",
        "Чем займёмся",
        "Что сегодня обсудим",
        "расскажите о себе",
        "расскажи о себе",
      ].join(", ");

      // Detect if client just shared a phone number — use targeted acknowledgment
      const clientSharedPhone = /(?:\+?\d[\d\s\-()]{6,}\d)/.test(userText);
      const clientSharedName =
        /^[А-ЯЁA-Z][а-яёa-z]{1,20}$/.test(userText.trim()) ||
        /(?:я\s+[—-]?\s*|меня зовут\s+)([А-ЯЁA-Z][а-яёa-z]{1,20})/i.test(userText);
      const clientGaveShortAnswer = userText.trim().split(/\s+/).length <= 3;

      // ── Repeated-question detection ────────────────────────────────────────
      // If the client asks essentially the same question ≥2 times in the last
      // 8 turns, the previous answers didn't satisfy them. Signal this clearly
      // so the AI changes approach instead of looping the same reply.
      const repeatCount = (() => {
        const currWords = userText
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 2);
        if (currWords.length === 0) return 0;
        return recentHistory
          .filter((m) => m.role === "user")
          .slice(-20)
          .filter((m) => {
            const qWords = m.content
              .toLowerCase()
              .split(/\W+/)
              .filter((w) => w.length > 2);
            const overlap = qWords.filter((w) => currWords.includes(w)).length;
            return overlap / currWords.length > 0.5;
          }).length;
      })();
      const isLoopQuestion = repeatCount >= 2;

      // ── Last 5 agent replies listed individually (NOT truncated) ──────────
      // Used for the hard "already said — DO NOT repeat" block in the prompt.
      const lastAgentReplies = recentHistory
        .filter((m) => m.role === "assistant")
        .slice(-5)
        .map((m, i) => `  ${i + 1}. "${m.content}"`)
        .join("\n");

      // ── Repeated trailing phrase detection ────────────────────────────────
      // E.g. agent ending 3 messages in a row with "Будем на связи в 8 вечера!"
      // Extract the last sentence of each recent reply; if ≥2 are the same, ban it.
      const trailingPhrases = recentHistory
        .filter((m) => m.role === "assistant")
        .slice(-8)
        .map((m) => {
          const sentences = m.content.split(/(?<=[.!?])\s+/);
          return sentences[sentences.length - 1]?.trim() ?? "";
        })
        .filter(Boolean);
      const bannedTrailing = (() => {
        const counts = new Map<string, number>();
        for (const p of trailingPhrases) counts.set(p, (counts.get(p) ?? 0) + 1);
        return [...counts.entries()]
          .filter(([, c]) => c >= 2)
          .map(([p]) => `"${p}"`)
          .join(", ");
      })();

      // Very first response ever for this client (no history at all).
      // Always introduce by name regardless of what the client wrote.
      const isFirstGreeting = conversationHistory.length === 0;

      // Agent display name — strip tech suffixes like "(userbot)", capitalize first letter.
      const rawDisplayName = this.name.replace(/\s*\(.*?\)\s*/g, "").trim();
      const agentDisplayName =
        rawDisplayName.charAt(0).toUpperCase() + rawDisplayName.slice(1) || rawDisplayName;

      // Long-term memory from previous sessions — know the client over time.
      const sessionMemoryText = chatMemory?.memoryText ?? "";
      const sessionCount = chatMemory?.sessionsCount ?? 0;

      // Is this a returning client (we've had sessions before)?
      const isReturningClient = sessionCount > 0;

      const prompt =
        `Ты — живой менеджер по продажам, тебя зовут ${agentDisplayName}. НЕ бот, НЕ ИИ.\n` +
        `Пишешь в Telegram — коротко, по-человечески, как настоящий человек.\n` +
        (goalText ? `Твоя цель: ${goalText}\n` : "") +
        (timeSinceLastMsg ? `Пауза в разговоре: ${timeSinceLastMsg}.\n` : "") +
        `\n` +
        (sessionMemoryText
          ? `## ПАМЯТЬ О КЛИЕНТЕ (прошлые ${sessionCount} сессий — используй это!):\n${sessionMemoryText}\n` +
            `Если уместно — ссылайся на прошлые разговоры нейтрально и без «ты говорил». ` +
            `Предпочтительно: «я думаю тебе будет интересно…».\n\n`
          : "") +
        (historyLines
          ? `## Текущий диалог (последние ${recentHistory.length} сообщений):\n${historyLines}\n\n`
          : "") +
        `## Клиент написал: "${userText.slice(0, 300)}"\n` +
        (lastManagerMsg ? `(Ты только что писал: "${lastManagerMsg}")\n` : "") +
        `\n` +
        (knownFacts
          ? `## Факты о клиенте из этого диалога (не переспрашивать): ${knownFacts}\n\n`
          : "") +
        `## Язык: ориентируйся на сообщения клиента: "${allClientText.slice(0, 150)}".\n` +
        `Отвечай СТРОГО на том же языке — ни слова на другом.\n\n` +
        `## Основа ответа (ПРИМЕР из базы — используй смысл, НЕ копируй имена/данные из примера):\n` +
        `"${template}"\n\n` +
        (isFirstGreeting
          ? `## ПЕРВОЕ СООБЩЕНИЕ:\n` +
            `Поздоровайся + представься: "Привет! Меня зовут ${agentDisplayName}." + 1 фраза о чём можешь помочь. Всё одной мыслью, без вопросов.\n\n`
          : isReEngaged
            ? `## РЕАКТИВАЦИЯ — КЛИЕНТ ОТВЕТИЛ:\n` +
              `Клиент откликнулся на твоё сообщение после паузы. ОБЯЗАТЕЛЬНО поздоровайся — ` +
              `одна тёплая и короткая фраза ("Привет!" / "Рад, что ответил!") — и сразу переходи к делу. ` +
              `Не затягивай с приветствием, не делай его многословным.\n\n`
            : isReturningClient
              ? `## ВОЗВРАЩАЮЩИЙСЯ КЛИЕНТ — используй память:\n` +
                `Упомяни что-то из прошлых разговоров если это к месту. Продолжай как будто давно знакомы.\n\n`
              : clientSharedPhone
                ? `Клиент прислал номер — подтверди кратко и назови следующий шаг.\n\n`
                : clientSharedName
                  ? `Клиент назвал имя — обратись по имени + двигай к сути.\n\n`
                  : clientGaveShortAnswer
                    ? `Короткий ответ → 1–2 предложения: среагируй + двигай.\n\n`
                    : `Развёрнутый ответ → 2–3 предложения по делу.\n\n`) +
        (isLoopQuestion
          ? `## ⚠️ ПЕТЛЯ ДИАЛОГА — ДЕЙСТВУЙ ИНАЧЕ:\n` +
            `Клиент спрашивает одно и то же уже ${repeatCount + 1}-й раз подряд.\n` +
            `Значит прошлые ответы его НЕ устраивают. КАРДИНАЛЬНО измени подход:\n` +
            `— Спроси напрямую: "Что именно вас беспокоит?" или "Могу уточнить детали"\n` +
            `— НЕ давай тот же ответ снова. Ни в каком виде.\n\n`
          : "") +
        `## ЗАПРЕЩЕНО (ЖЁСТКО):\n` +
        (lastAgentReplies
          ? `- Эти фразы уже были сказаны — НЕЛЬЗЯ ПОВТОРЯТЬ ни дословно, ни близко по смыслу:\n${lastAgentReplies}\n`
          : "") +
        (bannedTrailing
          ? `- Особо запрещённые концовки (встречались 2+ раза подряд): ${bannedTrailing}\n`
          : "") +
        (greetingInFullHistory ? `- НЕ здоровайся снова\n` : "") +
        `- НЕ пиши: ${clicheBlacklist}\n` +
        (knownFacts ? `- НЕ спрашивай уже известное: ${knownFacts}\n` : "") +
        (confirmedAgreements
          ? `- УЖЕ ДОГОВОРИЛИСЬ: "${confirmedAgreements}" — это зафиксировано, не возвращайся к этому\n`
          : "") +
        `- НЕ отправлять "?" как отдельное сообщение\n` +
        `- НЕ писать "я могу подстраиваться" — предложи 2–3 конкретных варианта\n` +
        `- НИКАКИХ НОМЕРОВ ТЕЛЕФОНОВ\n` +
        `- НЕ использовать имена/данные из KB-примера как реальные данные клиента\n` +
        `- НЕ задавать два вопроса подряд\n` +
        `- НЕ раскрывать что ты ИИ\n` +
        `- НОЛЬ турецких/иностранных слов\n` +
        `- ЗАПРЕЩЕНО упоминать сомнения клиента: "ты сомневался", "ты не был уверен", "колебался", "был сомнения в старте" — не сей сомнение своими словами\n` +
        `- ЗАПРЕЩЕНО предполагать сферу деятельности (IT, айти, бизнес и т.д.) без явного упоминания клиента\n\n` +
        `- ЗАПРЕЩЕНО писать «ты говорил/ты писал/ты упоминал». Используй стиль: «я думаю тебе будет интересно…»\n\n` +
        `## СОЦИАЛЬНОЕ ДОКАЗАТЕЛЬСТВО (если нужно):\n` +
        `Используй обобщённые формулировки: "многие наши клиенты / люди в похожей ситуации / ваши коллеги уже..." — ` +
        `без привязки к конкретной сфере, если клиент её не называл.\n\n` +
        `## ТОН:\n` +
        `Деловой партнёр — уверенный, конкретный. НЕ "подстраивающийся".\n` +
        `Одна чёткая мысль на сообщение. Без расплывчатых фраз.\n\n` +
        `Пиши как живой человек в мессенджере. Без пустых строк. Без заголовков.` +
        schemaHoursGuard;

      try {
        const adapted = await analyzeOnceDirect(prompt);
        // Strip phone numbers, clean [MSG] markers, ensure correct language
        const noPhones = stripPhoneNumbers(adapted.trim());
        let cleaned = noPhones.replace(/\[MSG\]/gi, " ").replace(/\n{2,}/g, "\n");

        // Post-process: if the reply ends with a banned trailing phrase, cut it.
        if (bannedTrailing) {
          const bannedList = trailingPhrases.filter(
            (p, _, arr) => arr.filter((x) => x === p).length >= 2,
          );
          for (const banned of bannedList) {
            if (cleaned.endsWith(banned)) {
              cleaned = cleaned.slice(0, cleaned.length - banned.length).trim();
            }
          }
        }

        return (await ensureClientLanguage(cleaned)) || template;
      } catch {
        return ensureClientLanguage(stripPhoneNumbers(template));
      }
    };

    /**
     * Advance the state machine to the next node after sending a reply.
     *
     * Rules:
     *  - 0 exits or end node  → delete state (conversation finished)
     *  - 1 exit               → trivially advance
     *  - 2+ exits on decision → AI picks branch by analysing client's message
     *  - 2+ exits on process  → AI picks the most contextually fitting path
     *
     * Logs the chosen transition for full observability.
     */
    const advanceNode = async (nodeType: string): Promise<void> => {
      if (nextNodes.length === 0 || isEnd) {
        // Mark as "__done__" instead of deleting — next client message will
        // enter free continuation mode rather than restarting from the start node.
        this.storage.setConversationNodeId(this.id, chatId, "__done__");
        void this.saveSessionMemory(chatId, chatKey, chatMemory);
        void this.extractAndSaveLead(chatId, chatKey); // auto-capture lead on schema completion
        if (!isEnd) {
          this.logger.warn(
            `[TG:${this.name}] schema DEAD-END | chat=${chatId} node="${currentNode.text.slice(0, 40)}" type=${nodeType} — switching to free mode. Fix the diagram.`,
          );
        } else {
          this.logger.info(
            `[TG:${this.name}] schema END | chat=${chatId} — switching to free mode`,
          );
        }
        return;
      }

      if (nextNodes.length === 1) {
        this.storage.setConversationNodeId(this.id, chatId, nextNodes[0].node.id);
        this.logger.info(
          `[TG:${this.name}] schema advance | chat=${chatId} [${nodeType}] "${currentNode.text.slice(0, 30)}" → "${nextNodes[0].node.text.slice(0, 40)}"`,
        );
        this.pushEvent("behavior", {
          action: "schema_advance",
          chatId,
          from: currentNode.text.slice(0, 60),
          to: nextNodes[0].node.text.slice(0, 60),
        });
        return;
      }

      // Multiple exits — use AI to choose the best path.
      // Build a compact history snippet (last 4 turns) for context.
      const histSnippet = conversationHistory
        .slice(-4)
        .map((m) => `${m.role === "user" ? "К" : "М"}: ${m.content.slice(0, 150)}`)
        .join("\n");

      const exitList = nextNodes
        .map(
          (x: { edge: DiagramEdge; node: DiagramNode }, i: number) =>
            `${i + 1}. ${x.edge.label ? `[${x.edge.label}] ` : ""}${x.node.text}`,
        )
        .join("\n");

      const routePrompt =
        `Ты — система маршрутизации диалога.\n\n` +
        `Текущий шаг: [${nodeType.toUpperCase()}] "${currentNode.text}"\n` +
        `Последнее сообщение клиента: "${userText.slice(0, 300)}"\n\n` +
        (histSnippet ? `Контекст диалога:\n${histSnippet}\n\n` : "") +
        `Возможные следующие шаги:\n${exitList}\n\n` +
        `Выбери НАИБОЛЕЕ подходящий следующий шаг исходя из слов клиента и контекста.\n` +
        `Ответь ТОЛЬКО числом (1, 2, 3...) — номером шага из списка выше. Без объяснений.`;

      let chosenIdx = 0; // default: first exit
      try {
        const raw = await analyzeOnceDirect(routePrompt);
        const num = parseInt(raw.trim(), 10);
        if (!isNaN(num) && num >= 1 && num <= nextNodes.length) {
          chosenIdx = num - 1;
        }
      } catch {
        // swallow — fallback to index 0
      }

      const chosen = nextNodes[chosenIdx];
      this.storage.setConversationNodeId(this.id, chatId, chosen.node.id);
      this.logger.info(
        `[TG:${this.name}] schema advance | chat=${chatId} [${nodeType}] "${currentNode.text.slice(0, 30)}" → [${chosenIdx + 1}/${nextNodes.length}] "${chosen.node.text.slice(0, 40)}"`,
      );
      this.pushEvent("behavior", {
        action: "schema_advance",
        chatId,
        from: currentNode.text.slice(0, 60),
        to: chosen.node.text.slice(0, 60),
      });
    };

    /**
     * Persist the exchange to conversation history so the next message
     * has full context.  adaptScript paths use analyzeOnceDirect which
     * does NOT touch history — we must save manually.
     * The aiReply fallback path saves via AiReplyEngine automatically.
     */
    const persistHistory = (userMsg: string, agentReply: string): void => {
      const hist = this.storage.loadConversationHistory(chatKey);
      hist.push({ role: "user", content: userMsg });
      hist.push({ role: "assistant", content: agentReply });
      // Keep last 200 entries (~100 turns) — long dialogues need full context.
      const trimmed = hist.slice(-200);
      this.storage.saveConversationHistory(chatKey, trimmed);

      // Invalidate the aiReply in-memory cache so the next turn's AI call
      // reloads this freshly written history from storage instead of using
      // a stale in-memory snapshot. Critical when KB path and fallback AI
      // path are interleaved across nodes.
      invalidateHistoryCache(chatKey);

      // Periodically compress old exchanges into long-term memory so future
      // sessions can say "как мы говорили раньше".
      // Trigger every 10 turns (20 entries) once we have enough data.
      if (trimmed.length > 0 && trimmed.length % 20 === 0) {
        void this.saveSessionMemory(chatId, chatKey, chatMemory);
      }
    };

    if (!isDecision && bestTemplate) {
      // Run reply generation and node advancement in parallel where possible:
      // adaptScript is I/O-bound (AI call), advanceNode may also need AI for
      // multi-exit process nodes — start both simultaneously.
      const [reply] = await Promise.all([
        adaptScript(bestTemplate.response),
        advanceNode(currentNode.type),
      ]);
      const _sig1 = this.getSignalId(conversationHistory);
      this.logger.info(
        `[TG:${this.name}] schema reply | chat=${chatId} source=kb-adapted ` +
          `node="${currentNode.text.slice(0, 40)}" trigger="${bestTemplate.input.slice(0, 60)}" ` +
          `signal=${_sig1}(${this.getSignalLabel(_sig1)}) ` +
          `reEngaged=${isReEngaged} msg="${userText.slice(0, 100)}"`,
      );
      this.pushEvent("ai_reply", {
        action: "schema_reply",
        chatId,
        source: "kb-adapted",
        node: currentNode.text.slice(0, 60),
        stage: dialogStage.stage,
        stageLabel: dialogStage.stageLabel,
        text: reply,
        clientText: userText.slice(0, 200),
        signal: _sig1,
        signalLabel: this.getSignalLabel(_sig1),
        clientMessages: this.getTriggerMessages(conversationHistory),
      });
      // Also strip assumptive claims (IT sphere etc.) from adapted KB templates.
      const safeReply = this.enforceNoAssumptiveClaims(
        this.enforceWorkingHours(stripPhoneNumbers(reply), settings),
        conversationHistory,
        userText,
        settings,
      );
      persistHistory(userText, safeReply);
      return safeReply;
    }

    // fixes the bug where single-exit decision nodes fell to system prompt path.
    if (isDecision && bestTemplate) {
      // Run reply adaptation and branch routing in parallel.
      const [reply] = await Promise.all([
        adaptScript(bestTemplate.response),
        advanceNode(currentNode.type),
      ]);
      const _sig2 = this.getSignalId(conversationHistory);
      this.logger.info(
        `[TG:${this.name}] schema reply | chat=${chatId} source=kb-decision-adapted ` +
          `node="${currentNode.text.slice(0, 40)}" trigger="${bestTemplate.input.slice(0, 60)}" ` +
          `signal=${_sig2}(${this.getSignalLabel(_sig2)}) ` +
          `reEngaged=${isReEngaged} msg="${userText.slice(0, 100)}"`,
      );
      this.pushEvent("ai_reply", {
        action: "schema_reply",
        chatId,
        source: "kb-decision-adapted",
        node: currentNode.text.slice(0, 60),
        stage: dialogStage.stage,
        stageLabel: dialogStage.stageLabel,
        text: reply,
        clientText: userText.slice(0, 200),
        signal: _sig2,
        signalLabel: this.getSignalLabel(_sig2),
        clientMessages: this.getTriggerMessages(conversationHistory),
      });
      // Also strip assumptive claims (IT sphere etc.) from adapted KB templates.
      const safeDecisionReply = this.enforceNoAssumptiveClaims(
        this.enforceWorkingHours(stripPhoneNumbers(reply), settings),
        conversationHistory,
        userText,
        settings,
      );
      persistHistory(userText, safeDecisionReply);
      return safeDecisionReply;
    }

    // ── System prompt ──────────────────────────────────────────────────────
    // Reached only when: decision node with no KB, OR end node with no KB.
    // Collect language evidence from all client messages (more reliable than last msg alone).
    const allClientMsgsFallback = conversationHistory
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ")
      .concat(" ", userText)
      .slice(0, 400);
    // Re-engagement: force greeting even if we've greeted before (fresh conversational context).
    const greetingWasSentFallback = isReEngaged
      ? false
      : conversationHistory.some(
          (m) =>
            m.role === "assistant" && /привет|здравств|рад|добрый|merhaba|hello/i.test(m.content),
        );

    // Known facts for system prompt path
    const knownFactsFallback = (() => {
      const allMsgs = conversationHistory
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .concat(userText)
        .join(" ");
      const facts: string[] = [];
      const nameMatch = allMsgs.match(
        /(?:я\s+[—-]?\s*|меня зовут\s+|my name is\s+)([А-ЯЁA-Z][а-яёa-z]{1,20})/i,
      );
      if (nameMatch) facts.push(`Имя: ${nameMatch[1]}`);
      const ageMatch =
        allMsgs.match(/(?:мне\s+|i(?:'m| am)\s+)(\d{1,3})(?:\s*(?:лет|год|года|years?))?/i) ??
        allMsgs.match(/\b(\d{1,3})\s*(?:лет|года?|years?)\b/i);
      if (ageMatch) facts.push(`Возраст: ${ageMatch[1]}`);
      const profMatch = allMsgs.match(
        /(?:я из\s+|работаю\s+(?:в|на)\s+|занимаюсь\s+)([А-ЯЁA-Za-zа-яё\s]{2,25})/i,
      );
      if (profMatch) facts.push(`Сфера: ${profMatch[1].trim()}`);
      return facts.join(" | ");
    })();

    // Professional cliché phrases that a top manager never says
    const clichesFallback =
      "Рад снова тебя слышать, Рад снова вас видеть, Как дела, Чем могу помочь, " +
      "Что сегодня обсудим, Чем займёмся, расскажите о себе";

    let systemPrompt =
      `Ты — опытный менеджер по продажам (живой человек, НЕ бот).\n` +
      `Стиль: уверенный, конкретный, нацеленный на сделку. Ты ПРЕДЛАГАЕШЬ — не расспрашиваешь.\n` +
      (timeSinceLastMsg ? `Пауза в диалоге: ${timeSinceLastMsg}.\n` : "") +
      `\n## ПРАВИЛА\n` +
      `• ЯЗЫК: "${allClientMsgsFallback.slice(0, 150)}" — отвечай СТРОГО на этом языке.\n` +
      `• Ответ: 1–3 предложения, без воды. Никаких "надеюсь", "рад помочь", "отличный вопрос".\n` +
      `• СНАЧАЛА выгода или боль. Вопрос — один, в конце, если нужен для перехода к следующему шагу.\n` +
      `• НЕ задавай 2+ вопроса. НЕ повторяй свои прошлые фразы дословно.\n` +
      (greetingWasSentFallback ? `• Не здоровайся повторно.\n` : "") +
      `• ЗАПРЕЩЕНЫ клише: ${clichesFallback}\n` +
      (knownFactsFallback ? `• Уже знаешь: ${knownFactsFallback} — не переспрашивай.\n` : "") +
      (isOffSchemaQuestion
        ? `• Клиент задал вопрос не по теме — ответь коротко, вернись к скрипту.\n`
        : "") +
      `• Никогда не раскрывай, что ты ИИ.\n` +
      `• ЗАПРЕЩЕНО упоминать сомнения клиента: "ты сомневался", "ты не был уверен", "колебался" — не напоминай о сомнениях.\n` +
      `• ЗАПРЕЩЕНО предполагать сферу деятельности (IT, айти и т.д.) без явного упоминания клиента.\n` +
      `• ЗАПРЕЩЕНО писать «ты говорил/ты писал/ты упоминал/ты говоришь, что/ты хочешь». Говори от себя: «давай созвонимся / я предлагаю...».\n` +
      `• ЗАПРЕЩЕНО «подстроюсь под любое время» / «когда тебе удобно» без конкретики — всегда называй конкретный слот.\n` +
      `• Социальное доказательство — без привязки к сфере: "многие наши клиенты / люди в похожей ситуации уже...".\n` +
      (settings.managerWorkFrom && settings.managerWorkTo
        ? `• Предлагай время звонка/встречи ТОЛЬКО в рабочие часы: ${settings.managerWorkFrom}–${settings.managerWorkTo}.\n`
        : "") +
      `• ${strict ? "СТРОГО используй скрипты из базы как основу ответа." : "Скрипты из базы — адаптируй под контекст."}\n\n` +
      (isReEngaged
        ? `## РЕАКТИВАЦИЯ — КЛИЕНТ ОТВЕТИЛ:\n` +
          `Клиент откликнулся на твоё сообщение после паузы. ` +
          `ОБЯЗАТЕЛЬНО поздоровайся в начале ответа — одна тёплая и короткая фраза ` +
          `("Привет!" / "Рад, что ответил!") — и сразу к делу.\n\n`
        : "");

    if (chatMemory?.memoryText) {
      systemPrompt +=
        `## ДОЛГОСРОЧНАЯ ПАМЯТЬ О КЛИЕНТЕ (из ${chatMemory.sessionsCount} прошлых сессий):\n` +
        `${chatMemory.memoryText}\n` +
        `Используй эту память активно, но без формулировок «ты говорил». ` +
        `Предпочтительно: «я думаю тебе будет интересно…».\n\n`;
    }

    // Derive the overall goal from the END node (or last node) text — gives the AI
    // a clear objective so it LEADS the conversation rather than asking "what to discuss".
    const endNode =
      diagram.nodes.find((n: DiagramNode) => n.type === "end") ??
      diagram.nodes[diagram.nodes.length - 1];
    if (endNode && endNode.id !== currentNode.id) {
      systemPrompt += `## ЦЕЛЬ РАЗГОВОРА\n"${endNode.text}"\nВсё, что ты говоришь, должно вести к этой цели.\n\n`;
    }

    // Funnel progress — shows agent where it is in the funnel visually
    const funnelSection = this.buildFunnelProgressSection(diagram, currentNode.id);
    if (funnelSection) systemPrompt += funnelSection + "\n";

    // Client signal analysis — tells agent how to react RIGHT NOW
    const signalSection = this.detectClientSignals(conversationHistory);
    if (signalSection) systemPrompt += signalSection + "\n";

    // Stage-specific tactical instruction — tells AI exactly how to behave at this stage.
    systemPrompt += `## ТАКТИКА НА ЭТОМ ЭТАПЕ (${dialogStage.stageLabel}):\n${dialogStage.stageInstruction}\n\n`;

    systemPrompt +=
      `## ТЕКУЩИЙ ШАГ\n` + `[${currentNode.type.toUpperCase()}] "${currentNode.text}"\n\n`;

    if (isEnd) {
      systemPrompt += `Инструкция: Последний шаг — закрой сделку/разговор согласно скрипту. Не спрашивай "что обсудим".\n`;
    } else if (currentNode.type === "start") {
      // START: greet + immediately present the value proposition / offer — never ask open-ended questions.
      const firstNext = nextNodes[0]?.node.text ?? "";
      systemPrompt +=
        `Инструкция: Поприветствуй и СРАЗУ озвучь конкретное предложение/выгоду (что ты предлагаешь).\n` +
        `Следующий шаг по скрипту: "${firstNext}" — плавно выведи к нему.\n` +
        `ЗАПРЕЩЕНО: "что обсудим?", "чем могу помочь?", "расскажите о себе?" — ты инициатор, у тебя есть конкретное предложение.\n`;
    } else if (isDecision) {
      // Smart validation: detect what data is being validated from node text
      // and inject explicit format rules so the AI validates correctly.
      const nodeTextLow = currentNode.text.toLowerCase();
      const isAgeValidation = nodeTextLow.includes("возраст") || nodeTextLow.includes("age");
      const isPhoneValidation =
        nodeTextLow.includes("телефон") ||
        nodeTextLow.includes("phone") ||
        nodeTextLow.includes("номер");

      if (isAgeValidation) {
        systemPrompt +=
          `Инструкция: Валидация возраста.\n` +
          `Проверь последнее сообщение клиента: содержит ли оно корректный возраст (целое число от 1 до 120).\n` +
          `Если ДА → выбери ветку "valid" (данные верные).\n` +
          `Если НЕТ → выбери ветку "invalid" и вежливо попроси уточнить возраст.\n`;
      } else if (isPhoneValidation) {
        systemPrompt +=
          `Инструкция: Валидация номера телефона.\n` +
          `Проверь последнее сообщение клиента: содержит ли оно номер телефона (цифры, +, скобки, дефис — минимум 7 цифр).\n` +
          `Если ДА → выбери ветку "valid" (данные верные).\n` +
          `Если НЕТ → выбери ветку "invalid" и вежливо попроси уточнить номер телефона.\n`;
      } else {
        systemPrompt +=
          `Инструкция: Это точка выбора. Проанализируй ответ клиента ` +
          `и выбери подходящую ветку для продолжения разговора.\n`;
      }
    } else {
      // Process node: present the offer / value, then guide to next step — one question max.
      const firstNext = nextNodes[0]?.node.text ?? "";
      systemPrompt +=
        `Инструкция: Выполни шаг — "${currentNode.text}".\n` +
        `Озвучь конкретную выгоду/предложение. Не расспрашивай клиента — ПРЕДЛАГАЙ.\n` +
        (firstNext ? `Затем одним предложением выведи к: "${firstNext}".\n` : "") +
        `Максимум один вопрос в конце, если это необходимо для перехода к следующему шагу.\n`;
    }

    if (nextNodes.length > 0) {
      systemPrompt += `\n## СЛЕДУЮЩИЕ ШАГИ\n`;
      for (const x of nextNodes) {
        systemPrompt += `- ${x.edge.label ? `[${x.edge.label}] ` : ""}${x.node.text}\n`;
      }
    }

    // KB template injection.
    // When scripts exist: inject them with buyer-style delivery instructions.
    // When no scripts: neutral fallback.
    if (hasTemplates) {
      const scoreLabel = (s: number) => (s === 3 ? "★★★" : s === 2 ? "★★" : "★");
      systemPrompt +=
        `\n## СКРИПТЫ ИЗ БАЗЫ — ТВОЯ ОСНОВА\n` +
        `Реальные рабочие офферы от лучших менеджеров. Возьми один и доставь клиенту.\n\n`;
      for (const p of topPairs) {
        systemPrompt += `[${scoreLabel(p.score)}] ${p.response}\n`;
      }
      const isBuyerStyle = settings.schemaDeliveryStyle === "buyer";
      if (isBuyerStyle) {
        // Dynamic instructions based on the three buyer sub-settings.
        const aggression = settings.buyerAggressionLevel ?? "balanced";
        const closeStyle = settings.buyerCloseStyle ?? "alternative";
        const productCtx = settings.buyerProductContext?.trim();
        if (productCtx) {
          systemPrompt += `\n## ПРОДУКТ / КОНТЕКСТ:\n${productCtx}\n`;
        }

        // Lead-capture instruction: goal is to get contact info / book a call, not close a sale.
        const closeInstruction =
          closeStyle === "direct"
            ? `• Захвати лид напрямую от имени менеджера: "Скинь номер — я сам напишу сегодня" / "Оставь контакт — я свяжусь и всё расскажу". Чётко, без лишних вопросов.\n`
            : closeStyle === "micro-step"
              ? `• Называй следующий шаг уверенно от имени менеджера: "Запишу тебя на звонок — в четверг удобно?" / "Скинь номер — я сам перезвоню сегодня". Никакого "просто посмотри" или "без обязательств".\n`
              : /* alternative (default) */
                `• Закрывай на контакт альтернативным выбором: "Удобнее позвонить или написать в WhatsApp?" — никогда открытым "ну что скажете?".\n`;

        const aggressionInstruction =
          aggression === "soft"
            ? `• Стиль: мягкий — больше вопросов, нет давления, фокус на понимании потребности.\n`
            : aggression === "hard"
              ? `• Стиль: жёсткий — прямые предложения, минимум вопросов, двигай к оставлению контакта здесь и сейчас.\n`
              : /* balanced (default) */
                `• Стиль: сбалансированный — покажи ценность, затем одним вопросом выведи на контакт/созвон.\n`;

        systemPrompt +=
          `\n## КАК АДАПТИРОВАТЬ (стиль баера — цель: лид):\n` +
          `• ЦЕЛЬ ДИАЛОГА — получить контакт или записать на созвон. Не продать, а захватить лида.\n` +
          `• Переведи на язык клиента, сохрани суть и конкретику\n` +
          `• НЕ превращай оффер в вопрос — это ПРЕДЛОЖЕНИЕ которое ты делаешь\n` +
          `• Добавь деталь из текущего разговора чтобы звучало лично\n` +
          `• Говори результатами: цифры, сроки, выгода — не "хорошие условия"\n` +
          `• Не используй формулировки «ты говорил/вы говорили». Предпочтительно: «я думаю тебе будет интересно…» / «я думаю вам будет интересно…».\n` +
          `• Один скрипт — одно сообщение. Без списков, без заголовков.\n` +
          closeInstruction +
          aggressionInstruction +
          `\n`;
      } else {
        systemPrompt += `\nАДАПТИРУЙ под язык и контекст клиента — сохрани суть и конкретику оффера.\n\n`;
      }
    } else {
      systemPrompt += `\n(Скриптов для этого шага нет — действуй как опытный менеджер, говори конкретикой.)\n\n`;
    }

    // BRANCH tag for multi-exit decision nodes (stripped from the reply before sending)
    if (nextNodes.length > 1) {
      const labels = nextNodes
        .map((x: { edge: DiagramEdge; node: DiagramNode }) => x.edge.label ?? x.node.text)
        .join(" | ");
      systemPrompt +=
        `\nПосле своего ответа добавь ОТДЕЛЬНОЙ новой строкой: BRANCH:<вариант>\n` +
        `Где <вариант> — ТОЧНО одно из: ${labels}\n` +
        `(Эта строка будет удалена перед отправкой пользователю.)\n`;
    }

    systemPrompt += `\n${this.buildScriptContext(diagram)}\n\n`;

    // Reuse already-loaded conversationHistory (last 8 turns) for context.
    const recentFallbackHistory = conversationHistory.slice(-8);
    if (recentFallbackHistory.length > 0) {
      const lines = recentFallbackHistory.map(
        (m) => `${m.role === "user" ? "Клиент" : "Менеджер"}: ${m.content.slice(0, 300)}`,
      );
      systemPrompt += `## ИСТОРИЯ ДИАЛОГА — помни всё, НЕ повторяй свои фразы:\n${lines.join("\n")}\n\n`;
    }

    // Language detection from full client message history — reliable even for short words.
    const allClientMsgs = recentFallbackHistory
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ")
      .concat(" ", userText)
      .slice(0, 400);
    systemPrompt +=
      `## Язык клиента — определи по ВСЕМ его сообщениям:\n"${allClientMsgs}"\n` +
      `Отвечай СТРОГО на этом языке (даже если скрипты написаны на другом).\n\n`;

    systemPrompt +=
      `ВАЖНО: Отвечай ТОЛЬКО по текущему шагу. Пиши как живой человек в Telegram — коротко и по делу.\n` +
      `ЗАПРЕЩЕНО: повторять свои прошлые фразы, задавать 2+ вопроса, писать номера телефонов, игнорировать слова клиента.\n\n` +
      `## Формат ответа\n` +
      `2–3 естественных предложения. Без пустых строк между ними. Без заголовков и маркеров.\n` +
      `Сначала — реакция на слова клиента (1 предложение), затем — конкретный оффер или следующий шаг.\n` +
      `НЕ начинай с вопроса.`;

    // Apply full system prompt override if configured (runScriptStep)
    if (settings.systemPromptOverride?.trim()) {
      systemPrompt = settings.systemPromptOverride.trim();
    }

    // Inject custom instructions from settings (runScriptStep)
    if (settings.systemPromptAppend?.trim()) {
      systemPrompt += `\n\n## ДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ:\n${settings.systemPromptAppend.trim()}`;
    }
    if (settings.contextInstructions?.trim()) {
      systemPrompt += `\n\n## КОНТЕКСТ:\n${settings.contextInstructions.trim()}`;
    }
    if (settings.antiHallucinationRules?.trim()) {
      systemPrompt += `\n\n## АНТИ-ГАЛЛЮЦИНАЦИИ (СТРОГО):\n${settings.antiHallucinationRules.trim()}`;
    }

    // ── Generate reply ────────────────────────────────────────────────────
    const workspaceTools = createWorkspaceTools(this.storage.getAgentWorkspaceDir(this.id));
    const rawReply = await aiReply(userText, chatKey, systemPrompt, this.storage, workspaceTools);

    // ── Strip BRANCH: routing tag ─────────────────────────────────────────
    let reply = rawReply;
    let chosenNextNodeId: string | undefined;

    if (nextNodes.length > 1) {
      const branchMatch = rawReply.match(/\nBRANCH:\s*(.+)$/im);
      if (branchMatch) {
        reply = rawReply.replace(/\nBRANCH:\s*.+$/im, "").trim();
        const chosenLabel = branchMatch[1].trim().toLowerCase();
        // Case-insensitive partial match on edge label or target node text.
        // Guard: skip empty edge labels — `str.includes("")` is always true
        // and would cause the first unlabelled edge to win every time.
        const matched = nextNodes.find((x: { edge: DiagramEdge; node: DiagramNode }) => {
          const eLabel = x.edge.label?.toLowerCase() ?? "";
          const nText = x.node.text.toLowerCase();
          return (
            (eLabel && (eLabel.includes(chosenLabel) || chosenLabel.includes(eLabel))) ||
            (nText.length <= 60 && (nText.includes(chosenLabel) || chosenLabel.includes(nText)))
          );
        });
        chosenNextNodeId = matched?.node.id ?? nextNodes[0].node.id;
      } else {
        // AI didn't include a tag — fall back to the first branch
        chosenNextNodeId = nextNodes[0].node.id;
      }
    }

    // ── Strict-mode validation + auto-rebuild ─────────────────────────────
    // Track reply source for observability logging.
    let replySource = hasTemplates ? "template" : "generated";

    if (strict) {
      const violations = this.validateStrictReply(reply, currentNode.type);
      if (violations.length > 0) {
        this.logger.warn(
          `[TG:${this.name}] strict validation FAIL chat=${chatId}: ${violations.join("; ")} — rebuilding`,
        );
        this.pushEvent("validation", {
          action: "strict_fail",
          chatId,
          violations: violations.join("; "),
        });
        const templateHint =
          topPairs.length > 0
            ? `\nЭталонные ответы для данного шага:\n${topPairs.map((p) => `- ${p.response}`).join("\n")}\n`
            : "";
        const rebuildPrompt =
          `Перепиши ответ менеджера, устранив нарушения скрипта.\n\n` +
          `НАРУШЕНИЯ: ${violations.join("; ")}\n\n` +
          `ТЕКУЩИЙ ШАГ: [${currentNode.type.toUpperCase()}] "${currentNode.text}"\n` +
          templateHint +
          `\nОРИГИНАЛЬНЫЙ ОТВЕТ:\n${reply}\n\n` +
          `ТРЕБОВАНИЯ:\n` +
          `• Строго в рамках текущего шага.\n` +
          `• Без идентификации ИИ.\n` +
          `• Без извинений и отказов.\n` +
          `• Не более 4–6 предложений.\n` +
          `• Верни только готовый ответ, без заголовков и пояснений.`;
        try {
          const rebuilt = await analyzeOnceDirect(rebuildPrompt);
          if (rebuilt.trim()) {
            reply = rebuilt.trim();
            replySource = "rebuilt";
          }
        } catch (e) {
          this.logger.warn(`[TG:${this.name}] strict rebuild failed: ${String(e)}`);
        }
      } else {
        this.logger.info(`[TG:${this.name}] strict validation OK chat=${chatId}`);
        this.pushEvent("validation", {
          action: "strict_ok",
          chatId,
        });
      }
    }

    const _sig3 = this.getSignalId(conversationHistory);
    this.logger.info(
      `[TG:${this.name}] schema reply | chat=${chatId} source=${replySource} ` +
        `node="${currentNode.text.slice(0, 40)}" ` +
        `reason=${hasTemplates ? "kb-fallback-sysprompt" : "no-kb-sysprompt"} ` +
        `signal=${_sig3}(${this.getSignalLabel(_sig3)}) ` +
        `reEngaged=${isReEngaged} msg="${userText.slice(0, 100)}"`,
    );
    this.pushEvent("ai_reply", {
      action: "schema_reply",
      chatId,
      source: replySource,
      node: currentNode.text.slice(0, 60),
      stage: dialogStage.stage,
      stageLabel: dialogStage.stageLabel,
      text: reply,
      clientText: userText.slice(0, 200),
      signal: _sig3,
      signalLabel: this.getSignalLabel(_sig3),
      clientMessages: this.getTriggerMessages(conversationHistory),
    });

    // ── Auto-save validated data to chat memory ───────────────────────────
    // When a validation decision node routes to "valid", persist the user's
    // last answer (age, phone, etc.) into long-term chat memory so it can
    // be referenced in future sessions and the session memory summary.
    if (isDecision && chosenNextNodeId) {
      const chosenNode = nextNodes.find((x) => x.node.id === chosenNextNodeId);
      const chosenlabel = (chosenNode?.edge.label ?? chosenNode?.node.text ?? "").toLowerCase();
      if (
        chosenlabel.includes("valid") ||
        chosenlabel.includes("верн") ||
        chosenlabel.includes("ок")
      ) {
        const nodeTextLow = currentNode.text.toLowerCase();
        let dataKey = "";
        if (nodeTextLow.includes("возраст") || nodeTextLow.includes("age")) dataKey = "Возраст";
        else if (
          nodeTextLow.includes("телефон") ||
          nodeTextLow.includes("phone") ||
          nodeTextLow.includes("номер")
        )
          dataKey = "Телефон";

        if (dataKey) {
          const hist = this.storage.loadConversationHistory(chatKey);
          const lastUser = [...hist].reverse().find((m) => m.role === "user");
          if (lastUser) {
            const existing = this.storage.getChatMemory(this.id, chatId);
            const updated =
              (existing?.memoryText ? existing.memoryText + "\n" : "") +
              `${dataKey}: ${lastUser.content.trim()}`;
            this.storage.saveChatMemory(this.id, chatId, updated, existing?.sessionsCount ?? 0);
            this.logger.info(
              `[TG:${this.name}] saved validated data: ${dataKey} for chat ${chatId}`,
            );
          }
        }
      }
    }

    // ── Advance the state machine (fallback AI path) ─────────────────────
    // BRANCH tag routing applies to BOTH decision and process multi-exit nodes.
    // Using advanceNode() for multi-exit nodes would make a duplicate AI routing
    // call and discard the BRANCH tag result that was already embedded in the reply.
    if (chosenNextNodeId) {
      const chosenNode = nextNodes.find((x) => x.node.id === chosenNextNodeId);
      this.storage.setConversationNodeId(this.id, chatId, chosenNextNodeId);
      this.logger.info(
        `[TG:${this.name}] schema advance | chat=${chatId} [${currentNode.type}] "${currentNode.text.slice(0, 30)}" → "${chosenNode?.node.text.slice(0, 40) ?? chosenNextNodeId}"`,
      );
      this.pushEvent("behavior", {
        action: "schema_advance",
        chatId,
        from: currentNode.text.slice(0, 60),
        to: chosenNode?.node.text.slice(0, 60) ?? chosenNextNodeId,
      });
    } else {
      // Single-exit or end node — advanceNode handles trivially or marks __done__.
      await advanceNode(currentNode.type);
    }

    // Final safety: never send phone numbers; block out-of-hours times; strip custom phrases.
    const sanitizedReply = this.enforceNoAssumptiveClaims(
      stripPhoneNumbers(reply),
      conversationHistory,
      userText,
      settings,
    );
    const customSafe = this.enforceCustomForbiddenPhrases(sanitizedReply, settings);
    const finalReply = this.enforceWorkingHours(customSafe, settings) || null;

    // Patch history to reflect the actual sent reply, not rawReply which may
    // contain the BRANCH tag and/or the pre-rebuild strict-violation text.
    if (finalReply && finalReply !== rawReply) {
      updateLastAssistantReply(chatKey, finalReply, this.storage);
    }

    return finalReply;
  }

  /**
   * Free continuation mode — called after all schema nodes are done.
   *
   * The agent keeps talking naturally as a knowledgeable sales manager,
   * using the schema topics as background and the full conversation history
   * as context. It doesn't restart the script from scratch.
   */
  private async runFreeMode(
    chatId: string,
    userText: string,
    chatKey: string,
    diagram: FlowDiagram,
  ): Promise<string | null> {
    const agentSettings = this.getAgentSettings();
    const strict = agentSettings.schemaStrictMode ?? false;
    const chatMemory = this.storage.getChatMemory(this.id, chatId);
    const conversationHistory = this.storage.loadConversationHistory(chatKey);

    const rawDisplayName = this.name.replace(/\s*\(.*?\)\s*/g, "").trim();
    const agentDisplayName =
      rawDisplayName.charAt(0).toUpperCase() + rawDisplayName.slice(1) || rawDisplayName;

    // Last 50 turns for context — preserve full conversation.
    const recentHistory = conversationHistory.slice(-50);
    const historyLines = recentHistory
      .map((m) => `${m.role === "user" ? "Клиент" : "Менеджер"}: ${m.content.slice(0, 250)}`)
      .join("\n");

    const allClientText = recentHistory
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ")
      .concat(" ", userText)
      .slice(0, 500);

    // Full list of last 5 agent replies (not truncated) — hard ban on repeating.
    const lastAgentRepliesFree = recentHistory
      .filter((m) => m.role === "assistant")
      .slice(-5)
      .map((m, i) => `  ${i + 1}. "${m.content}"`)
      .join("\n");

    // Detect banned trailing phrases (repeated endings).
    const trailingPhrasesFree = recentHistory
      .filter((m) => m.role === "assistant")
      .slice(-4)
      .map((m) => {
        const s = m.content.split(/(?<=[.!?])\s+/);
        return s[s.length - 1]?.trim() ?? "";
      })
      .filter(Boolean);
    const bannedTrailingFree = (() => {
      const counts = new Map<string, number>();
      for (const p of trailingPhrasesFree) counts.set(p, (counts.get(p) ?? 0) + 1);
      return [...counts.entries()]
        .filter(([, c]) => c >= 2)
        .map(([p]) => `"${p}"`)
        .join(", ");
    })();

    // Repeated-question detection.
    const repeatCountFree = (() => {
      const currWords = userText
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 2);
      if (!currWords.length) return 0;
      return recentHistory
        .filter((m) => m.role === "user")
        .slice(-8)
        .filter((m) => {
          const qWords = m.content
            .toLowerCase()
            .split(/\W+/)
            .filter((w) => w.length > 2);
          const overlap = qWords.filter((w) => currWords.includes(w)).length;
          return overlap / currWords.length > 0.5;
        }).length;
    })();
    const isLoopFree = repeatCountFree >= 2;

    const lastManagerMsg =
      [...recentHistory]
        .reverse()
        .find((m) => m.role === "assistant")
        ?.content.slice(0, 150) ?? "";

    // Compact schema summary — just the node topics, not used as a "goal to push"
    const schemaSummary = diagram.nodes
      .filter((n: DiagramNode) => n.type !== "start")
      .map((n: DiagramNode) => `• ${n.text.slice(0, 80)}`)
      .join("\n");

    // Extract client facts for context
    const allMsgs = recentHistory
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .concat(userText)
      .join(" ");
    const nameMatch = allMsgs.match(/(?:я\s+[—-]?\s*|меня зовут\s+)([А-ЯЁA-Z][а-яёa-z]{1,20})/i);
    const ageMatch =
      allMsgs.match(/(?:мне\s+)(\d{1,3})(?:\s*(?:лет|год|года))?/i) ??
      allMsgs.match(/\b(\d{1,3})\s*(?:лет|года?)\b/i);
    const knownFacts = [
      nameMatch ? `Имя: ${nameMatch[1]}` : "",
      ageMatch ? `Возраст: ${ageMatch[1]}` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    // Confirmed arrangements (times, calls) — must not be re-verified.
    const confirmedAgreements = (() => {
      const agreed: string[] = [];
      const agreedPattern =
        /(?:созвон|звонок|позвоним|созваниваемся|договорились|ок,?\s+до|хорошо,?\s+до|отлично,?\s+до|жду звонка|буду ждать)[^.!?\n]{0,80}/gi;
      for (const m of recentHistory) {
        const match = m.content.match(agreedPattern);
        if (match) agreed.push(...match.map((s) => s.trim().slice(0, 80)));
      }
      return [...new Set(agreed)].slice(0, 3).join("; ");
    })();

    // Detect client signals in free mode — same heuristic as schema mode.
    const freeModeSignal = this.detectClientSignals(conversationHistory);
    const isBuyerStyleFree = agentSettings.schemaDeliveryStyle === "buyer";

    // Stage detection for system-prompt injection (same as schema mode).
    const _stage4 = this.detectDialogStage(conversationHistory);

    // Buyer sub-settings (only relevant when isBuyerStyleFree).
    const buyerAggression = agentSettings.buyerAggressionLevel ?? "balanced";
    const buyerClose = agentSettings.buyerCloseStyle ?? "alternative";
    // AI infers product/niche from conversation history — no manual buyerProductCtx.

    // Lead-capture framing for free mode (same goal: get contact / book a call).
    const buyerCloseLineFree =
      buyerClose === "direct"
        ? `► Захвати лид напрямую от имени менеджера: "Скинь номер — я сам напишу сегодня" / "Оставь контакт — я свяжусь". Без лишних вопросов.\n`
        : buyerClose === "micro-step"
          ? `► Называй следующий шаг уверенно от имени менеджера: "Запишу тебя на звонок — в четверг удобно?" / "Скинь номер — я сам перезвоню сегодня".\n`
          : `► Захвати лид альтернативным выбором от имени менеджера: "Удобнее позвонить или написать в WhatsApp?" — не "ну что думаете?".\n`;

    const buyerAggressionLineFree =
      buyerAggression === "soft"
        ? `► Стиль: мягкий — больше открытых вопросов, нет давления, фокус на понимании.\n`
        : buyerAggression === "hard"
          ? `► Стиль: жёсткий — прямые предложения, минимум вопросов, максимум давления к решению.\n`
          : `► Стиль: сбалансированный — ROI + умеренная срочность + один переходный вопрос.\n`;

    let systemPrompt =
      `Ты — ${agentDisplayName}, опытный менеджер по продажам. Живой человек, не ИИ.\n` +
      `Скрипт завершён. Теперь свободный диалог — отвечай как живой человек, по делу.\n\n` +
      (isLoopFree
        ? `## ⚠️ ПЕТЛЯ (${repeatCountFree + 1}-й раз одно и то же):\n` +
          `Прошлые ответы не сработали. Смени угол: вскрой реальное возражение — "Что конкретно стопорит?"\n\n`
        : "") +
      `## ТАКТИКА НА ЭТОМ ЭТАПЕ (${_stage4.stageLabel}):\n${_stage4.stageInstruction}\n\n` +
      (chatMemory?.memoryText
        ? `## ПАМЯТЬ О КЛИЕНТЕ (${chatMemory.sessionsCount} сессий):\n${chatMemory.memoryText}\n\n`
        : "") +
      `## Что уже обсудили:\n${schemaSummary}\n\n` +
      (historyLines ? `## История:\n${historyLines}\n\n` : "") +
      (freeModeSignal ? `${freeModeSignal}\n` : "") +
      `## Клиент написал: "${userText.slice(0, 300)}"\n` +
      (lastManagerMsg ? `## Твоё последнее: "${lastManagerMsg}"\n` : "") +
      (knownFacts ? `## Знаешь о клиенте: ${knownFacts}\n` : "") +
      (confirmedAgreements
        ? `## Договорились: "${confirmedAgreements}" — не пересматривай.\n`
        : "") +
      `\n## Язык: "${allClientText.slice(0, 100)}" — СТРОГО этот язык.\n\n` +
      (isBuyerStyleFree
        ? `## СТИЛЬ — БАЕР (цель: лид):\n` +
          `ЦЕЛЬ ДИАЛОГА — получить контакт или записать на созвон. Не продать, а захватить лида.\n` +
          `► Нишу и продукт определяй сам из истории переписки — не придумывай.\n` +
          `► Переводи всё в выгоду клиента: цифры, сроки, конкретный результат — не "хорошие условия".\n` +
          buyerCloseLineFree +
          `► Срочность только реальная — слот, дедлайн, изменение условий. Не выдумывай.\n` +
          buyerAggressionLineFree +
          `\n`
        : `## ЗАДАЧА:\nОтветь на "${userText.slice(0, 150)}" — конкретно, без воды.\n` +
          `Цель — получить контакт или договориться о следующем шаге. Говори выгодой, не обещаниями.\n\n`) +
      `## НЕЛЬЗЯ:\n` +
      (lastAgentRepliesFree ? `• НЕ повторять: ${lastAgentRepliesFree}\n` : "") +
      (bannedTrailingFree ? `• Запрещённые концовки: ${bannedTrailingFree}\n` : "") +
      `• Телефонные номера\n` +
      (knownFacts ? `• Спрашивать уже известное: ${knownFacts}\n` : "") +
      `• 2+ вопроса подряд\n` +
      `• Раскрывать что ты ИИ\n` +
      `• Пустые фразы: "рад помочь", "отличный вопрос", "конечно"\n` +
      `• Предлагать дешевле, аналоги или «другие варианты» при ценовом возражении — держись своей рекомендации\n` +
      `• Писать «ты говорил/ты писал/ты упоминал/ты говоришь/ты хочешь» — говори от себя: «давай созвонимся / я предлагаю...»\n` +
      `• «Подстроюсь под любое время» / «когда тебе удобно» без конкретики — всегда называй конкретный слот\n` +
      `• Предполагать сферу деятельности клиента (IT, айти, бизнес и т.д.) без явного упоминания\n` +
      (agentSettings.managerWorkFrom && agentSettings.managerWorkTo
        ? `• Предлагать время за пределами рабочего дня (${agentSettings.managerWorkFrom}–${agentSettings.managerWorkTo}) или говорить «в любое время» — называй конкретный слот в рамках рабочего окна\n`
        : "") +
      `• ${strict ? "Выходить за рамки скрипта." : "Зацикливаться на одном — двигайся дальше."}\n\n` +
      `2–3 предложения. Telegram-стиль. Без пустых строк.`;

    // Apply full system prompt override if configured (runFreeMode)
    if (agentSettings.systemPromptOverride?.trim()) {
      systemPrompt = agentSettings.systemPromptOverride.trim();
    }

    // Inject custom instructions from settings (runFreeMode)
    if (agentSettings.systemPromptAppend?.trim()) {
      systemPrompt += `\n\n## ДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ:\n${agentSettings.systemPromptAppend.trim()}`;
    }
    if (agentSettings.contextInstructions?.trim()) {
      systemPrompt += `\n\n## КОНТЕКСТ:\n${agentSettings.contextInstructions.trim()}`;
    }
    if (agentSettings.antiHallucinationRules?.trim()) {
      systemPrompt += `\n\n## АНТИ-ГАЛЛЮЦИНАЦИИ (СТРОГО):\n${agentSettings.antiHallucinationRules.trim()}`;
    }

    const workspaceTools = createWorkspaceTools(this.storage.getAgentWorkspaceDir(this.id));
    try {
      const rawReply = await aiReply(userText, chatKey, systemPrompt, this.storage, workspaceTools);
      // Strip phone numbers unless the guard is disabled by user
      const safeReply = this.isBuiltinGuardEnabled("stripPhoneNumbers", agentSettings, true)
        ? rawReply
            .replace(/(?<!\d)(\+?\d[\d\s\-().]{5,}\d)(?!\d)/g, "")
            .replace(/\s{2,}/g, " ")
            .trim()
        : rawReply;
      const assumptionSafeReply = this.enforceNoAssumptiveClaims(
        safeReply,
        conversationHistory,
        userText,
        agentSettings,
      );
      this.logger.info(
        `[TG:${this.name}] free-mode reply | chat=${chatId} ` +
          `stage=${_stage4.stage} node="${_stage4.node}"`,
      );
      this.pushEvent("ai_reply", {
        action: "free_mode_reply",
        chatId,
        source: "free-mode",
        node: _stage4.node,
        stage: _stage4.stage,
        stageLabel: _stage4.stageLabel,
        text: assumptionSafeReply,
        clientText: userText.slice(0, 200),
        signal: _sig4,
        signalLabel: this.getSignalLabel(_sig4),
        clientMessages: this.getTriggerMessages(conversationHistory),
      });
      // Auto-learn: persist this exchange to the most relevant KB node (fire-and-forget)
      if (assumptionSafeReply) {
        void this.learnFromFreeMode(userText, assumptionSafeReply, diagram);
      }
      // Auto-capture lead if client shared a phone number
      if (/(?:\+?[\d][\d\s\-()]{6,}\d)/.test(userText)) {
        void this.extractAndSaveLead(chatId, chatKey);
      }
      // Hard guard: block out-of-hours times; strip custom forbidden phrases.
      const customSafeFree = this.enforceCustomForbiddenPhrases(assumptionSafeReply, agentSettings);
      return this.enforceWorkingHours(customSafeFree, agentSettings) || null;
    } catch (e) {
      this.logger.warn(`[TG:${this.name}] free-mode failed: ${String(e)}`);
      return null;
    }
  }

  /**
   * Score how well a node's KB pairs match the user's message.
   * Returns the count of unique keywords shared between userText and
   * the node's KB content (node text + all pair inputs/responses).
   * Higher = better match.
   */
  private scoreNodeKbMatch(userText: string, diagram: FlowDiagram, nodeId: string): number {
    const node = diagram.nodes.find((n: DiagramNode) => n.id === nodeId);
    if (!node) return 0;

    // Tokenize to lowercase words (≥3 chars) from the user message
    const userWords = new Set(
      userText
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length >= 3),
    );
    if (userWords.size === 0) return 0;

    // Build a combined text blob from node label + all KB pairs
    const pairs = this.getNodeKbPairs(diagram, nodeId);
    const nodeContent = [node.text, ...pairs.flatMap((p) => [p.input, p.response])]
      .join(" ")
      .toLowerCase();

    let matches = 0;
    for (const word of userWords) {
      if (nodeContent.includes(word)) matches++;
    }
    return matches;
  }

  /**
   * Given the current resolved node and the user message, check whether another
   * node in the diagram is a significantly better semantic match.
   *
   * Rules:
   * - Only considers non-start, non-end nodes (they carry real KB content).
   * - The alternative node must score at least 2 keyword matches AND beat the
   *   current node by a margin of 2 to avoid noisy jumps.
   * - Returns the current node when no clear winner is found.
   */
  private flexibleNodeRoute(
    userText: string,
    diagram: FlowDiagram,
    currentNode: DiagramNode,
  ): DiagramNode {
    const currentScore = this.scoreNodeKbMatch(userText, diagram, currentNode.id);

    // Build the set of nodes reachable FORWARD from currentNode by following
    // edges (BFS). This prevents backward jumps that skip funnel steps or loop
    // the conversation back to already-completed stages.
    const forwardReachable = new Set<string>();
    const visited = new Set<string>();
    const queue: string[] = [currentNode.id];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const e of diagram.edges) {
        if (e.sourceId === id) {
          forwardReachable.add(e.targetId);
          queue.push(e.targetId);
        }
      }
    }

    let bestNode = currentNode;
    let bestScore = currentScore;

    for (const node of diagram.nodes) {
      if (node.id === currentNode.id) continue;
      if (node.type === "start" || node.type === "end") continue;
      // Only consider nodes reachable forward — never jump backwards
      if (!forwardReachable.has(node.id)) continue;

      const score = this.scoreNodeKbMatch(userText, diagram, node.id);
      // Must beat current by at least 2 to avoid random hops
      if (score >= 2 && score > bestScore + 1) {
        bestScore = score;
        bestNode = node;
      }
    }

    return bestNode;
  }

  /**
   * Auto-learn: after a successful free-mode reply, persist the Q&A pair to the
   * KB of the most relevant diagram node.
   *
   * - Finds the best-matching node (by keyword overlap).
   * - Skips if the pair is already present (dedup by input).
   * - Appends with score=1 (human-unverified, so it won't be used as a template
   *   until a manager bumps the score via the UI).
   */
  private async learnFromFreeMode(
    userText: string,
    agentReply: string,
    diagram: FlowDiagram,
  ): Promise<void> {
    try {
      // Find the most relevant non-start/end node
      let bestNode: DiagramNode | null = null;
      let bestScore = 0;

      for (const node of diagram.nodes) {
        if (node.type === "start" || node.type === "end") continue;
        const score = this.scoreNodeKbMatch(userText, diagram, node.id);
        if (score > bestScore) {
          bestScore = score;
          bestNode = node;
        }
      }

      // Fall back to the first regular node if nothing matched
      if (!bestNode) {
        bestNode =
          diagram.nodes.find((n: DiagramNode) => n.type !== "start" && n.type !== "end") ?? null;
      }
      if (!bestNode) return;

      const agentId = diagram.agentId;
      const scope = diagram.scope as "personal" | "shared";

      const raw = this.storage.getKnowledgeBase(agentId, scope) as {
        entries?: Array<{
          nodeId: string;
          nodeText: string;
          pairs: Array<{ input: string; response: string; score: number }>;
        }>;
      } | null;

      const kb = raw ?? { entries: [] };
      if (!kb.entries) kb.entries = [];

      // Find or create the entry for this node
      let entry = kb.entries.find((e) => e.nodeId === bestNode!.id);
      if (!entry) {
        entry = { nodeId: bestNode.id, nodeText: bestNode.text, pairs: [] };
        kb.entries.push(entry);
      }

      // Dedup: skip if we already have a very similar input (trimmed, lowercase)
      const normalised = userText.trim().toLowerCase().slice(0, 200);
      const alreadyExists = entry.pairs.some(
        (p) => p.input.trim().toLowerCase().slice(0, 200) === normalised,
      );
      if (alreadyExists) return;

      entry.pairs.push({ input: userText.trim(), response: agentReply.trim(), score: 1 });

      this.storage.saveKnowledgeBase(agentId, scope, kb);
      this.logger.info(
        `[TG:${this.name}] learn | saved pair to node "${bestNode.text.slice(0, 50)}" (score=1)`,
      );
    } catch (e) {
      // Non-fatal: learning failures must never break the reply flow
      this.logger.warn(`[TG:${this.name}] learnFromFreeMode failed: ${String(e)}`);
    }
  }

  /**
   * Extract structured lead data from the conversation and upsert it into
   * the tg_leads table.  Fire-and-forget — never throws to the caller.
   *
   * Triggered automatically when:
   *  - Schema marks `__done__` (conversation completed)
   *  - Client message contains a phone number
   */
  protected extractAndSaveLead(chatId: string, chatKey: string): void {
    try {
      const history = this.storage.loadConversationHistory(chatKey);
      if (history.length < 1) return;

      const allText = history.map((m) => m.content).join("\n");

      // Phone — require 7+ digit sequences
      const phoneMatch = allText.match(/(?:\+?[\d][\d\s\-()]{6,}\d)/);
      const phone = phoneMatch?.[0]?.replace(/\s+/g, "").trim();

      // Client name — look for self-introduction patterns
      const nameMatch = allText.match(
        /(?:меня зовут\s+|я\s+[—\-]?\s*|my name is\s+|ben\s+)([А-ЯЁA-Z][а-яёa-z]{1,20}(?:\s+[А-ЯЁA-Z][а-яёa-z]{1,20})?)/i,
      );
      const fullName = nameMatch?.[1]?.trim();
      const [firstName, lastName] = fullName?.split(/\s+/) ?? [];

      // Age
      const ageMatch = allText.match(/\b(\d{1,2})\s*(?:лет|год|года|years?)\b/i);
      const age = ageMatch ? parseInt(ageMatch[1], 10) : undefined;

      // Preferred callback time — prefer AI confirmation messages (contain "договорились",
      // "позвоним", "свяжемся", "запишу") as they reflect the actually agreed time;
      // fall back to time mentioned by the client.
      const now = new Date();
      const dd = String(now.getDate()).padStart(2, "0");
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const hh = String(now.getHours()).padStart(2, "0");
      const mi = String(now.getMinutes()).padStart(2, "0");
      const timeRegexLocal = /\d{1,2}[:\.]\d{2}|\d{1,2}\s*(?:вечера|утра|дня|ночи|am|pm)/i;

      // Look for AI confirmation of an agreed time first
      const agentConfirmation = [...history]
        .reverse()
        .find(
          (m) =>
            m.role === "assistant" &&
            /договор|запис|позвон|свяж|набер/i.test(m.content) &&
            timeRegexLocal.test(m.content),
        );
      const confirmedTimeMatch = agentConfirmation?.content.match(timeRegexLocal);

      // Fall back to any time mentioned by the client
      const clientTexts = history
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join(" ");
      const clientTimeMatch = clientTexts.match(
        /(?:в\s+)?(\d{1,2}[:\.]\d{2}|\d{1,2}\s*(?:вечера|утра|дня|ночи)|завтра|после\s+\d)/i,
      );
      const timeMatch = confirmedTimeMatch ?? clientTimeMatch;
      const preferredContactTime = timeMatch
        ? `${dd}.${mm} / ${timeMatch[0].trim()}`
        : `${dd}.${mm} / ${hh}:${mi}`;

      // Country heuristic
      const hasTurkish = /[çşğıİĞŞÇ]|(?:\btamam\b|\bevet\b|\bhayır\b|\bmerhaba\b)/i.test(allText);
      const country = hasTurkish ? "TR" : undefined;

      // Skip if nothing meaningful found
      if (!phone && !firstName) return;

      const rawName = this.name.replace(/\s*\(.*?\)\s*/g, "").trim();

      this.storage.upsertLeadFields(this.id, chatId, {
        firstName,
        lastName,
        phone,
        country,
        age: age && age > 0 && age < 120 ? age : undefined,
        preferredContactTime,
        contactMethod: phone ? "Tg/Tel" : "Tg",
        agentName: rawName,
      });

      this.logger.info(`[TG:${this.name}] lead upserted | chat=${chatId}`);

      // Push lead card to the configured group/channel if set
      const settings = this.getAgentSettings();
      const groupLink = settings.leadsGroupLink?.trim();
      if (groupLink) {
        void this.pushLeadToGroup(groupLink, {
          firstName,
          lastName,
          phone,
          country,
          age: age && age > 0 && age < 120 ? age : undefined,
          preferredContactTime,
          contactMethod: phone ? "Tg/Tel" : "Tg",
          agentName: rawName,
        });
      }
    } catch (e) {
      this.logger.warn(`[TG:${this.name}] extractAndSaveLead failed: ${String(e)}`);
    }
  }

  // ─── Contact tracking ─────────────────────────────────────────────────────

  /**
   * Save / update the contact's profile info on every inbound message.
   * Keeps first_name/last_name/username fresh and tracks last_client_msg_at.
   */
  protected saveContactInfo(
    chatId: string,
    info: { firstName?: string; lastName?: string; username?: string },
  ): void {
    if (!chatId) return;
    try {
      this.storage.upsertContact(this.id, chatId, info);
    } catch (e) {
      this.logger.warn(`[TG:${this.name}] saveContactInfo failed: ${String(e)}`);
    }
  }

  // ─── Re-engagement cron ───────────────────────────────────────────────────

  /**
   * Start (or restart) the re-engagement cron.
   * Runs every 30 minutes and checks whether any dormant contacts should
   * receive a proactive message based on the configured delay thresholds.
   */
  protected startReEngagementCron(): void {
    // Import cron lazily to avoid circular imports in tests
    import("node-cron")
      .then(({ default: cron }) => {
        const existing = this.cronJobs.get("re_engagement");
        if (existing) {
          existing.stop();
        }

        const task = cron.schedule("*/30 * * * *", () => {
          void this.runReEngagementCheck();
        });
        this.cronJobs.set("re_engagement", task);
        this.logger.info(`[TG:${this.name}] re-engagement cron started`);
        // Run once on startup so operators don't wait up to 30 minutes.
        void this.runReEngagementCheck();
      })
      .catch((e) => {
        this.logger.warn(`[TG:${this.name}] re-engagement cron init failed: ${String(e)}`);
      });
  }

  /**
   * Format a re-engagement template string, substituting {имя} / {фамилия} / {имя_полное}.
   * Falls back to `username` (without @) when `firstName` is null.
   */
  private formatReEngagementMessage(
    template: string,
    firstName: string | null,
    lastName: string | null,
    username?: string | null,
  ): string {
    // Use username as name fallback if firstName absent
    const first = firstName ?? (username ? username.replace(/^@/, "") : "");
    const last = lastName ?? "";
    const full = [first, last].filter(Boolean).join(" ");
    return template
      .replace(/\{имя\}/g, first)
      .replace(/\{фамилия\}/g, last)
      .replace(/\{имя_полное\}/g, full)
      .trim();
  }

  /**
   * Build the full system prompt for re-engagement AI calls.
   * Uses the custom override if set, otherwise the hardcoded base prompt
   * with context/anti-hallucination/append injected from re-engagement
   * settings (falling back to global manager settings).
   */
  private buildReEngagementSystemPrompt(
    basePrompt: string,
    settings: import("../types.js").AgentSettings,
  ): string {
    // Full override replaces everything
    if (settings.reEngagementSystemPrompt?.trim()) {
      return settings.reEngagementSystemPrompt.trim();
    }

    let prompt = basePrompt;

    // Inject context (re-engagement-specific or fallback to global)
    const ctx = settings.reEngagementContext?.trim() || settings.contextInstructions?.trim();
    if (ctx) {
      prompt += `\n\n## КОНТЕКСТ:\n${ctx}`;
    }

    // Inject anti-hallucination rules
    const ah =
      settings.reEngagementAntiHallucination?.trim() || settings.antiHallucinationRules?.trim();
    if (ah) {
      prompt += `\n\n## АНТИ-ГАЛЛЮЦИНАЦИИ (СТРОГО):\n${ah}`;
    }

    // Inject additional instructions
    const append = settings.reEngagementAppend?.trim() || settings.systemPromptAppend?.trim();
    if (append) {
      prompt += `\n\n## ДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ:\n${append}`;
    }

    return prompt;
  }

  /**
   * Apply post-processing guards to a re-engagement message.
   * Respects the reEngagementApplyGuards toggle (default: true).
   */
  private applyReEngagementGuards(
    text: string,
    settings: import("../types.js").AgentSettings,
  ): string {
    let result = this.enforceFirstPerson(text, settings);

    // Skip other guards if explicitly disabled
    if (settings.reEngagementApplyGuards === false) return result;

    result = this.enforceNoAssumptiveClaims(result, settings);
    result = this.enforceCustomForbiddenPhrases(result, settings);

    // Strip phone numbers if guard is enabled
    if (this.isBuiltinGuardEnabled("stripPhoneNumbers", settings)) {
      result = result.replace(/(?:\+?\d[\d\s\-()]{6,}\d)/g, "[номер скрыт]");
    }

    return result;
  }

  /**
   * Use AI to personalise and make a re-engagement message more compelling.
   * Takes the base template (already substituted) and recent conversation history,
   * and returns a short, human-feeling message.
   */
  private async enhanceReEngagementMessage(baseMessage: string, chatKey: string): Promise<string> {
    try {
      const { callAdapterOnce } = await import("../behaviors/AiReplyEngine.js");
      // Load full history — re-engagement needs the whole context to find
      // what genuinely interested the client and where the deal stopped.
      const allHistory = this.storage.loadConversationHistory(chatKey);
      const historyText =
        allHistory.length > 0
          ? allHistory
              .map((m) => `${m.role === "user" ? "Клиент" : "Агент"}: ${m.content}`)
              .join("\n")
          : "(история недоступна)";

      const erSettings = this.getAgentSettings();
      const erIsBuyer = erSettings.schemaDeliveryStyle === "buyer";
      // reEngagementTone is the dedicated control; fall back to buyerAggressionLevel
      // when in buyer mode and no explicit re-engagement tone is set.
      const erAggression =
        erSettings.reEngagementTone ??
        (erIsBuyer ? (erSettings.buyerAggressionLevel ?? "balanced") : "balanced");

      const aggressionLine =
        erAggression === "hard"
          ? "Тон прямой и уверенный — называй следующий шаг как само собой разумеющееся."
          : erAggression === "soft"
            ? "Тон мягкий — дай человеку самому захотеть продолжить, без давления."
            : "Тон уверенный, не давящий — ты помнишь его ситуацию, у тебя есть что сказать.";

      const baseSystemPrompt =
        "Ты — эксперт по реактивации «замёрзших» сделок.\n" +
        "Клиент давно молчит. Твоя задача: написать ОДНО сообщение которое вернёт его в разговор.\n\n" +
        "Алгоритм:\n" +
        "1. Прочитай историю и найди: что этому клиенту было реально интересно или важно — его слова, его задача, его боль.\n" +
        "2. Найди точку остановки: на чём именно диалог замер (возражение по цене, нужно подумать, ждал условий, отвлёкся, что-то смутило).\n" +
        "3. НЕ атакуй точку остановки напрямую — зайди с другого угла: дай новую конкретику, результат, или просто напомни о его же цели.\n" +
        "4. Шаблон используй как скелет — текст перепиши полностью под этого человека.\n\n" +
        "Правила:\n" +
        "• Без 'привет', 'как дела', 'давно не общались', 'не забыл о нас'\n" +
        "• Без общих фраз — только конкретика из этого чата\n" +
        "• Говори про ЕГО выгоду, ЕГО ситуацию — не про свой продукт\n" +
        `• ${aggressionLine}\n` +
        "• 1–2 предложения максимум\n" +
        "• Пиши на языке клиента (определи по истории)\n" +
        "• СТРОГО первое лицо ЕДИНСТВЕННОГО числа: 'я', 'могу', 'предлагаю', 'звоню' — ЗАПРЕЩЕНО 'мы', 'можем', 'предлагаем' на любом языке\n" +
        "• Только готовый текст сообщения — без кавычек, пояснений, заголовков";

      const systemPrompt = this.buildReEngagementSystemPrompt(baseSystemPrompt, erSettings);

      const userPrompt =
        `Шаблон-скелет: "${baseMessage}"\n\n` +
        `История диалога:\n${historyText}\n\n` +
        `Найди его главный интерес и точку остановки — и перепиши шаблон так, чтобы сообщение говорило именно о том, что важно ЕМУ. Призыв к действию сохрани.`;

      // In non-buyer mode the same template applies — professional re-engagement
      // is equally useful regardless of delivery style.
      void erIsBuyer; // already embedded in prompt logic above

      const enhanced = await callAdapterOnce(userPrompt, systemPrompt);
      const cleaned = enhanced.replace(/^["«»']+|["«»']+$/g, "").trim();
      return this.applyReEngagementGuards(cleaned, erSettings) || baseMessage;
    } catch {
      return baseMessage;
    }
  }

  /**
   * Fully AI-generated re-engagement: reads the FULL chat history and crafts
   * a personalised message from scratch — no template used.
   */
  private async generateAiReEngagement(
    contact: {
      chatId: string;
      firstName: string | null;
      lastName: string | null;
      username: string | null;
    },
    chatKey: string,
  ): Promise<string | null> {
    try {
      const { callAdapterOnce } = await import("../behaviors/AiReplyEngine.js");
      const allHistory = this.storage.loadConversationHistory(chatKey);
      if (allHistory.length === 0) {
        this.logger.info(
          `[TG:${this.name}] re-engagement AI skip (no history) | chat=${contact.chatId}`,
        );
        return null;
      }

      const historyText = allHistory
        .map((m) => `${m.role === "user" ? "Клиент" : "Агент"}: ${m.content}`)
        .join("\n");

      const name =
        contact.firstName ?? (contact.username ? contact.username.replace(/^@/, "") : null);
      const nameHint = name ? `Имя контакта: ${name}.` : "Имя неизвестно.";

      // Use buyer-aware prompt when buyer mode is active.
      const arSettings = this.getAgentSettings();
      const arIsBuyer = arSettings.schemaDeliveryStyle === "buyer";
      // reEngagementTone takes priority; fall back to buyerAggressionLevel in buyer mode.
      const arAggression =
        arSettings.reEngagementTone ??
        (arIsBuyer ? (arSettings.buyerAggressionLevel ?? "balanced") : "balanced");

      const aggressionHint =
        arAggression === "hard"
          ? "Тон прямой и уверенный — называй следующий шаг как само собой разумеющееся, без вопросительных интонаций."
          : arAggression === "soft"
            ? "Тон мягкий — создай повод ответить потому что ЕМУ интересно, не потому что его дожали."
            : "Тон уверенный, не давящий — ты помнишь его ситуацию и пишешь по делу.";

      // Single system prompt works for both buyer and non-buyer mode.
      void arIsBuyer;

      const baseSystemPrompt =
        "Ты — эксперт по реактивации «замёрзших» сделок.\n" +
        "Клиент давно молчит. Одно сообщение — вернуть его в разговор.\n\n" +
        "Шаги (не пиши их — только используй для формулировки):\n" +
        "① Найди главный интерес клиента из истории: его задачу, боль, цель — его же словами.\n" +
        "② Найди точку остановки: на чём конкретно замер диалог " +
        "(цена, нужно подумать, согласование, сомнение, просто отвлёкся).\n" +
        "③ Выбери угол возврата: НЕ атакуй точку остановки напрямую — " +
        "зайди через его интерес: новый аргумент в пользу его цели, " +
        "конкретный результат/кейс, напоминание о его же задаче.\n" +
        "④ Напиши сообщение которое говорит о ЕГО выгоде — не о продукте.\n\n" +
        "Правила:\n" +
        "• Без 'привет', 'как дела', 'давно не общались', 'напоминаю о себе'\n" +
        "• Ноль обобщений — только конкретика из этого чата\n" +
        "• Говори его языком (определи по истории)\n" +
        `• ${aggressionHint}\n` +
        "• 1–2 предложения максимум\n" +
        "• СТРОГО первое лицо ЕДИНСТВЕННОГО числа: 'я', 'могу', 'предлагаю' — ЗАПРЕЩЕНО 'мы', 'можем', 'предлагаем' на любом языке\n" +
        "• Только готовый текст — без кавычек, пояснений, заголовков";

      const systemPrompt = this.buildReEngagementSystemPrompt(baseSystemPrompt, arSettings);

      const userPrompt =
        `${nameHint}\n\n` +
        `Полная история диалога:\n${historyText}\n\n` +
        `Найди главный интерес этого человека и точку остановки сделки — ` +
        `напиши одно сообщение которое говорит о ЕГО цели и даёт повод ответить.`;

      const result = await callAdapterOnce(userPrompt, systemPrompt);
      const cleaned = result.replace(/^["«»']+|["«»']+$/g, "").trim();
      return this.applyReEngagementGuards(cleaned, arSettings) || null;
    } catch (e) {
      this.logger.warn(
        `[TG:${this.name}] re-engagement AI generation failed | chat=${contact.chatId}: ${String(e)}`,
      );
      return null;
    }
  }

  /** Check all delay thresholds and send re-engagement messages to qualifying contacts. */
  private async runReEngagementCheck(): Promise<void> {
    const settings = this.getAgentSettings();
    // Master AI kill-switch: skip entirely when AI is fully disabled.
    if (settings.aiEnabled === false) return;
    if (!settings.reEngagementEnabled) return;

    // NOTE: reEngagementAiContinue does NOT block the send — it only controls
    // whether the AI responds when the contact replies (see isReEngagementReply /
    // isReEngagementSilenced). Re-engagement messages are sent regardless.
    //
    // NOTE: schedule mode does NOT block the cron — outreach fires any time.
    // Gating by schedule would permanently miss contacts whose silence window
    // falls outside working hours (the ±4 h window passes before work begins).

    const template = settings.reEngagementTemplate?.trim();
    // Effective mode: default to "ai" when not explicitly set so that
    // users who just enable re-engagement without configuring a template
    // still get messages generated from chat history.
    const effectiveMode = settings.reEngagementAiMode ?? "ai";
    // In full-AI mode a template is optional; in template mode it's required.
    if (effectiveMode !== "ai" && !template) {
      this.logger.warn(
        `[TG:${this.name}] re-engagement: режим "Шаблон" выбран, но шаблон не задан — ` +
          `реактивация пропущена. Введите шаблон в Промпты → Реактивация или переключитесь на ИИ-режим.`,
      );
      return;
    }

    // Build delays array: prefer range (from/to) over legacy chips array.
    // Fall back to [1, 2, 3, 5, 7] when neither range nor legacy array is configured
    // (e.g. user enabled re-engagement but never explicitly saved the interval inputs).
    const fromDay = settings.reEngagementDelayFrom ?? null;
    const toDay = settings.reEngagementDelayTo ?? null;
    const delays: number[] =
      fromDay !== null && toDay !== null
        ? Array.from({ length: Math.max(0, toDay - fromDay + 1) }, (_, i) => fromDay + i)
        : (settings.reEngagementDelays?.length
            ? settings.reEngagementDelays
            : [1, 2, 3, 5, 7]); // sensible default when interval was never explicitly saved

    if (delays.length === 0 && !settings.reEngagementDelayMore) return;

    const now = Date.now();

    // ── Startup contacts snapshot (diagnose found=0 before any window logic) ─
    {
      const contacts = this.storage.getAllContactsDebug(this.id);
      const nowIso = new Date(now).toISOString();
      this.logger.info(
        `[TG:${this.name}] re-engagement check | delays=${JSON.stringify(delays)} ` +
          `more=${settings.reEngagementDelayMore ?? false} ` +
          `pause=${settings.reEngagementPauseMin ?? 0}-${settings.reEngagementPauseMax ?? 0}s ` +
          `trackedContacts=${contacts.length} now=${nowIso}`,
      );
      if (contacts.length === 0) {
        this.logger.warn(
          `[TG:${this.name}] re-engagement: NO CONTACTS in tg_contacts for this agent — ` +
            `saveContactInfo may not be called on incoming messages, or agent never received any.`,
        );
      } else {
        // Log each contact's last-activity so we can see which day-window they'd hit.
        for (const c of contacts) {
          const name = c.firstName ?? c.username ?? c.chatId;
          const lastMsgTime = new Date(c.lastClientMsgAt).getTime();
          const silenceMs = now - lastMsgTime;
          const silenceDays = (silenceMs / 86400000).toFixed(2);
          const silenceHours = (silenceMs / 3600000).toFixed(1);

          // Check which day windows this contact would match
          const matchingDays: number[] = [];
          for (const days of delays) {
            const targetMs = days * 24 * 60 * 60 * 1000;
            const wMs = 36 * 60 * 60 * 1000; // ±36 hours window
            const windowStartMs = now - targetMs - wMs;
            const windowEndMs = now - targetMs + wMs;
            if (lastMsgTime >= windowStartMs && lastMsgTime < windowEndMs) {
              matchingDays.push(days);
            }
          }

          this.logger.info(
            `[TG:${this.name}] re-engagement contact | chat=${c.chatId} name="${name}" ` +
              `last=${c.lastClientMsgAt} silence=${silenceDays}d (${silenceHours}h) ` +
              `alreadySent=[${c.sentDays}] matchingWindows=[${matchingDays.join(",")}]`,
          );
        }
      }
    }

    // Window for exact-day matches: ±36 h for all days.
    // This gives each contact a 72-hour eligibility period (3 days worth) so that contacts
    // will more reliably fall into the target window even if their silence time is slightly
    // off from the exact day count. period_ref dedup in the DB prevents double-sending per
    // contact per delay period even if the cron fires many times within the window.
    const windowMs = (_d: number) => 36 * 60 * 60 * 1000;

    // Helper: send a re-engagement message to a contact.
    // Returns true if a message was actually sent (used for pause counting).
    const sendReEngagement = async (
      contact: {
        chatId: string;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        lastClientMsgAt: string;
      },
      dayLabel: number,
    ): Promise<boolean> => {
      const resolvedName = contact.firstName ?? contact.username ?? null;
      if (settings.reEngagementNameOnly && !resolvedName) return false;

      const chatKey = `${this.id}:${contact.chatId}`;
      let message: string;

      if (effectiveMode === "ai") {
        // Full AI mode: generate from chat history; fall back to template when history is empty.
        const aiMsg = await this.generateAiReEngagement(contact, chatKey);
        if (!aiMsg) {
          if (!template) return false; // no history, no template — skip
          // Fallback: use template with AI enhancement
          const baseMessage = this.formatReEngagementMessage(
            template,
            contact.firstName,
            contact.lastName,
            contact.username,
          );
          if (!baseMessage) return false;
          message = await this.enhanceReEngagementMessage(baseMessage, chatKey);
        } else {
          message = aiMsg;
        }
      } else {
        // Template mode (default): fill template + AI enhance
        const baseMessage = this.formatReEngagementMessage(
          template,
          contact.firstName,
          contact.lastName,
          contact.username,
        );
        if (!baseMessage) return false;
        message = await this.enhanceReEngagementMessage(baseMessage, chatKey);
      }

      try {
        await this.callTool("sendMessage", { target: contact.chatId, message });
        this.trackMessage("out", message, contact.chatId);
        this.storage.markReEngagementSent(
          this.id,
          contact.chatId,
          dayLabel,
          contact.lastClientMsgAt,
        );
        this.logger.info(
          `[TG:${this.name}] re-engagement sent | chat=${contact.chatId} day=${dayLabel}`,
        );
        this.pushEvent("reengagement", {
          action: "sent",
          chatId: contact.chatId,
          day: dayLabel,
          mode: effectiveMode,
          text: message,
        });
        return true;
      } catch (e) {
        this.logger.warn(
          `[TG:${this.name}] re-engagement failed | chat=${contact.chatId}: ${String(e)}`,
        );
        return false;
      }
    };

    // Configurable pause between messages to avoid flood-detection.
    const pauseMin = (settings.reEngagementPauseMin ?? 0) * 1000;
    const pauseMax = Math.max(pauseMin, (settings.reEngagementPauseMax ?? 0) * 1000);
    let sentCount = 0;
    if (pauseMax > 0) {
      this.logger.info(
        `[TG:${this.name}] re-engagement pause config | min=${pauseMin}ms max=${pauseMax}ms`,
      );
    }
    const maybePause = async () => {
      if (sentCount === 0 || pauseMax === 0) return;
      const delay = pauseMin + Math.random() * (pauseMax - pauseMin);
      this.logger.info(
        `[TG:${this.name}] re-engagement pause | ${Math.round(delay)}ms before next send (sent=${sentCount})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    };

    // Process each specific day in the range.
    for (const days of delays) {
      const targetMs = days * 24 * 60 * 60 * 1000;
      const wMs = windowMs(days);
      const windowStart = new Date(now - targetMs - wMs).toISOString();
      const windowEnd = new Date(now - targetMs + wMs).toISOString();

      const contacts = this.storage.getContactsForReEngagement(
        this.id,
        days,
        windowStart,
        windowEnd,
      );

      // Enhanced logging with human-readable window boundaries
      const windowStartDate = new Date(windowStart);
      const windowEndDate = new Date(windowEnd);
      const windowDurationHours = (
        (windowEndDate.getTime() - windowStartDate.getTime()) /
        3600000
      ).toFixed(1);

      this.logger.info(
        `[TG:${this.name}] re-engagement day=${days} window=[${windowStart}..${windowEnd}] ` +
          `duration=${windowDurationHours}h found=${contacts.length}`,
      );
      if (contacts.length === 0) {
        const stats = this.storage.getReEngagementWindowStats(
          this.id,
          days,
          windowStart,
          windowEnd,
        );
        this.logger.info(
          `[TG:${this.name}] re-engagement day=${days} diagnostics | tracked=${stats.trackedTotal} inWindow=${stats.inWindow} dedupBlocked=${stats.dedupBlocked} eligible=${stats.eligible}`,
        );
      }
      for (const contact of contacts) {
        await maybePause();
        const sent = await sendReEngagement(contact, days);
        if (sent) sentCount++;
      }
    }

    // "И более": contacts silent for longer than the range end, re-engaged at
    // most once per `toDay` days (uses delay_days=9999 as dedup marker).
    if (settings.reEngagementDelayMore) {
      const moreDay = toDay ?? (delays.length > 0 ? Math.max(...delays) : 1);
      const contacts = this.storage.getContactsForReEngagementMore(this.id, moreDay);
      this.logger.info(
        `[TG:${this.name}] re-engagement more (>${moreDay}d) found=${contacts.length}`,
      );
      if (contacts.length === 0) {
        const stats = this.storage.getReEngagementMoreStats(this.id, moreDay);
        this.logger.info(
          `[TG:${this.name}] re-engagement more (>${moreDay}d) diagnostics | tracked=${stats.trackedTotal} olderThanCutoff=${stats.olderThanCutoff} cooloffBlocked=${stats.cooloffBlocked} eligible=${stats.eligible}`,
        );
      }
      for (const contact of contacts) {
        await maybePause();
        const sent = await sendReEngagement(contact, 9999);
        if (sent) sentCount++;
      }
    }
  }

  // ─── Follow-up scheduling ──────────────────────────────────────────────────

  /**
   * Parse a client message and return the requested delay in milliseconds,
   * or null if no delay pattern is found.
   * Supports Russian, English and Turkish patterns.
   */
  private parseFollowupDelay(text: string): number | null {
    const t = text.toLowerCase();
    // "через X минут/мин"
    const minRu = t.match(/через\s+(\d+)\s*(?:минут|минуты|минуту|мин\b)/);
    if (minRu) return parseInt(minRu[1]) * 60_000;
    // "через час" / "через X часов"
    const hourRu = t.match(/через\s+(\d+)\s*(?:часов|часа|час\b)/);
    if (hourRu) return parseInt(hourRu[1]) * 3_600_000;
    if (/через\s+час\b/.test(t)) return 3_600_000;
    // "через полчаса"
    if (/через\s+полчаса|через\s+пол\s*часа/.test(t)) return 1_800_000;
    // English: "in X min(utes)" / "in X hour(s)"
    const minEn = t.match(/\bin\s+(\d+)\s*(?:min|mins|minute|minutes)\b/);
    if (minEn) return parseInt(minEn[1]) * 60_000;
    const hourEn = t.match(/\bin\s+(\d+)\s*(?:hour|hours)\b/);
    if (hourEn) return parseInt(hourEn[1]) * 3_600_000;
    // Turkish: "X dakika sonra" / "X saat sonra"
    const minTr = t.match(/(\d+)\s*dakika\s+sonra/);
    if (minTr) return parseInt(minTr[1]) * 60_000;
    const hourTr = t.match(/(\d+)\s*saat\s+sonra/);
    if (hourTr) return parseInt(hourTr[1]) * 3_600_000;
    return null;
  }

  /**
   * Detect follow-up requests in incoming messages and schedule a reminder.
   * Cancel any existing follow-up for this chat (client is active again).
   * Call this from every message handler after tracking the inbound message.
   */
  protected detectFollowupRequest(chatId: string, chatKey: string, userText: string): void {
    // Any message from the client cancels prior pending follow-up for this chat
    this.cancelFollowupForChat(chatId);

    const delayMs = this.parseFollowupDelay(userText);
    if (!delayMs) return;

    // Only schedule if client explicitly asks to be contacted later
    const wantsCallback =
      /напиши|напомни|свяжись|позвон|пиши|write|message|call|remind|yaz|ara|mesaj/i.test(userText);
    if (!wantsCallback && delayMs < 600_000) return; // < 10 min without explicit request — skip

    const id = `${this.id}:${chatId}:${Date.now()}`;
    const sendAt = new Date(Date.now() + delayMs).toISOString();
    this.storage.addFollowup(id, this.id, chatId, chatKey, sendAt);
    this.scheduleFollowupTimer(id, chatId, chatKey, delayMs);

    const minutes = Math.round(delayMs / 60_000);
    this.logger.info(`[TG:${this.name}] follow-up scheduled | chat=${chatId} in ${minutes}min`);
    this.pushEvent("followup", {
      action: "scheduled",
      chatId,
      inMinutes: minutes,
    });
  }

  /** Schedule an in-process timer for a follow-up. */
  private scheduleFollowupTimer(
    id: string,
    chatId: string,
    chatKey: string,
    delayMs: number,
  ): void {
    // Cap at 6 hours to avoid holding timers too long; DB ensures persistence across restarts
    const safeDelay = Math.min(delayMs, 6 * 3_600_000);
    const handle = setTimeout(() => {
      this.followupTimers.delete(id);
      void this.sendFollowupNow(id, chatId, chatKey);
    }, safeDelay);
    this.followupTimers.set(id, handle);
  }

  /** Cancel all pending follow-up timers for a chat and mark them sent in DB. */
  private cancelFollowupForChat(chatId: string): void {
    // Clear in-memory timers for this chat
    for (const [id, handle] of this.followupTimers) {
      if (id.includes(`:${chatId}:`)) {
        clearTimeout(handle);
        this.followupTimers.delete(id);
      }
    }
    this.storage.cancelFollowupsForChat(this.id, chatId);
  }

  /**
   * Generate and send the follow-up message using AI.
   * Reads conversation history to produce a contextual re-engagement.
   */
  private async sendFollowupNow(
    followupId: string,
    chatId: string,
    chatKey: string,
  ): Promise<void> {
    // Master AI kill-switch — skip follow-up when AI is fully disabled.
    const followupSettings = this.getAgentSettings();
    if (followupSettings.aiEnabled === false) {
      this.storage.markFollowupSent(followupId); // consume it so it doesn't retry
      return;
    }
    // Mark as sent first so even if sending fails it won't retry
    this.storage.markFollowupSent(followupId);

    const history = this.storage.loadConversationHistory(chatKey).slice(-10);
    const historyText = history
      .map((m) => `${m.role === "user" ? "Клиент" : "Менеджер"}: ${m.content.slice(0, 200)}`)
      .join("\n");

    const rawName = this.name.replace(/\s*\(.*?\)\s*/g, "").trim();
    const allClientText = history
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ");

    const systemPrompt =
      `Ты — ${rawName}, менеджер по продажам. Клиент просил написать ему позже — сейчас нужное время пришло.\n` +
      `Напиши короткое, живое сообщение — напомни о себе и продолжи разговор.\n\n` +
      (historyText ? `История до паузы:\n${historyText}\n\n` : "") +
      `Правила:\n` +
      `• Не пиши «напоминаю» или «как и обещал» — звучи естественно\n` +
      `• Одно короткое сообщение, 1–2 предложения\n` +
      `• Заверши мягким открытым вопросом чтобы продолжить диалог\n` +
      `• Язык: определи по тексту клиента («${allClientText.slice(0, 100)}»)\n` +
      `• НЕ раскрывай что ты ИИ`;

    try {
      const { callAdapterOnce } = await import("../behaviors/AiReplyEngine.js");
      const raw = await callAdapterOnce("Напиши follow-up сообщение клиенту.", systemPrompt);
      const message = raw.trim().replace(/\s{2,}/g, " ");
      if (!message) return;
      await this.callTool("sendMessage", { target: chatId, message });
      this.trackMessage("out", message, chatId);
      this.logger.info(`[TG:${this.name}] follow-up sent | chat=${chatId}`);
      this.pushEvent("followup", {
        action: "sent",
        chatId,
        text: message,
      });
    } catch (e) {
      this.logger.warn(`[TG:${this.name}] follow-up send failed: ${String(e)}`);
    }
  }

  /**
   * On agent start: restore any pending follow-ups from the DB that weren't
   * sent yet (e.g. gateway was restarted). Re-arms their timers.
   */
  protected restorePendingFollowups(): void {
    const pending = this.storage.getAllPendingFollowups(this.id);
    if (pending.length === 0) return;
    const now = Date.now();
    for (const f of pending) {
      const sendAt = new Date(f.sendAt).getTime();
      const delayMs = Math.max(sendAt - now, 5_000); // min 5s if already overdue
      this.scheduleFollowupTimer(f.id, f.chatId, f.chatKey, delayMs);
    }
    this.logger.info(`[TG:${this.name}] restored ${pending.length} pending follow-up(s)`);
  }

  /**
   * Join the configured leads group and send a one-time welcome message.
   * Idempotent — tracks welcomed links in settings so it won't repeat on restart.
   * Called on agent start and when the group link is first configured.
   */
  public async initLeadsGroup(): Promise<void> {
    const settings = this.getAgentSettings();
    const groupLink = settings.leadsGroupLink?.trim();
    if (!groupLink) return;

    const welcomed = settings.leadsGroupWelcomedLinks ?? [];
    if (welcomed.includes(groupLink)) return; // Already initialized

    try {
      // Try to join first (succeeds for UserBot; Bot agents will fail silently).
      // joinChat returns { resolvedId } for invite-link joins so we can sendMessage
      // using the numeric chat ID instead of the invite URL.
      let messageTarget = groupLink;
      try {
        const joinResult = await this.callTool("joinChat", { target: groupLink });
        const resolvedId = (joinResult as any)?.resolvedId;
        if (resolvedId) messageTarget = resolvedId;
        this.logger.info(`[TG:${this.name}] joined leads group: ${groupLink}`);
      } catch {
        // Bot agents don't have joinChat — silently continue
      }

      const welcomeMessage =
        `👋 Привет! Я — AI-менеджер *${this.name}*.\n\n` +
        `Буду автоматически отправлять сюда карточки новых лидов 🎯\n\n` +
        `Канал готов к работе — жду первых контактов!`;

      await this.callTool("sendMessage", { target: messageTarget, message: welcomeMessage });

      // Mark as welcomed so we don't repeat on restart
      const updatedSettings = {
        ...settings,
        leadsGroupWelcomedLinks: [...welcomed, groupLink],
      };
      this.storage.saveAgentSettings(this.id, updatedSettings);
      this.logger.info(`[TG:${this.name}] leads group welcome sent: ${groupLink}`);
    } catch (e) {
      this.logger.warn(`[TG:${this.name}] initLeadsGroup failed: ${String(e)}`);
    }
  }

  /**
   * Format and send a lead card to the specified Telegram group/channel.
   * Uses callTool("sendMessage") so it works for both Bot and UserBot agents.
   * Silently logs on error — never throws.
   */
  private async pushLeadToGroup(
    groupLink: string,
    lead: {
      firstName?: string;
      lastName?: string;
      phone?: string;
      contactMethod?: string;
      country?: string;
      age?: number;
      preferredContactTime?: string;
      agentName?: string;
    },
  ): Promise<void> {
    try {
      const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "—";
      const lines: string[] = [`🎯 Новый лид`, `👤 ${name}`];
      if (lead.phone) lines.push(`📞 ${lead.phone}`);
      if (lead.contactMethod) lines.push(`📱 ${lead.contactMethod}`);
      if (lead.country) lines.push(`🌍 ${lead.country}`);
      if (lead.age) lines.push(`👤 ${lead.age} лет`);
      if (lead.preferredContactTime) lines.push(`🕐 Время связи: ${lead.preferredContactTime}`);
      if (lead.agentName) lines.push(`🤖 Агент: ${lead.agentName}`);
      const message = lines.join("\n");
      await this.callTool("sendMessage", { target: groupLink, message });
      this.logger.info(`[TG:${this.name}] lead pushed to group ${groupLink}`);
    } catch (e) {
      this.logger.warn(`[TG:${this.name}] pushLeadToGroup failed: ${String(e)}`);
    }
  }

  /**
   * Render the full diagram as a numbered plain-text script for use in the
   * system prompt. BFS-traversal from the start node preserves the natural
   * reading order. Decision branches are shown inline with their edge labels.
   */
  private buildScriptContext(diagram: FlowDiagram): string {
    if (diagram.nodes.length === 0) return "";
    const lines: string[] = ["## ПОЛНЫЙ СКРИПТ (для справки)"];

    const startNode = diagram.nodes.find((n: DiagramNode) => n.type === "start");
    if (!startNode) {
      // Fallback: flat list
      for (const n of diagram.nodes) lines.push(`• [${n.type.toUpperCase()}] ${n.text}`);
      return lines.join("\n");
    }

    // BFS through nodes, building numbered steps with branch annotations
    const visited = new Set<string>();
    const queue: string[] = [startNode.id];
    let step = 1;

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = diagram.nodes.find((n: DiagramNode) => n.id === nodeId);
      if (!node) continue;

      const outs = diagram.edges.filter((e: DiagramEdge) => e.sourceId === nodeId);
      const branchStr = outs
        .map((e: DiagramEdge) => {
          const target = diagram.nodes.find((n: DiagramNode) => n.id === e.targetId);
          return `→ ${e.label ? `[${e.label}] ` : ""}${target?.text ?? "?"}`;
        })
        .join("  ");

      lines.push(
        `${step}. [${node.type.toUpperCase()}] ${node.text}${branchStr ? `  ${branchStr}` : ""}`,
      );
      step++;

      for (const e of outs) {
        if (!visited.has(e.targetId)) queue.push(e.targetId);
      }
    }

    // Append any nodes disconnected from the start (shouldn't happen in a well-formed diagram)
    for (const n of diagram.nodes) {
      if (!visited.has(n.id)) lines.push(`${step++}. [${n.type.toUpperCase()}] ${n.text}`);
    }

    return lines.join("\n");
  }

  /**
   * Build a visual funnel-progress section for the system prompt.
   * Shows which nodes are "done" (before the current node in BFS order),
   * the current position, and the remaining path to the end goal.
   *
   * Example output:
   *   ## ВОРОНКА ПРОДАЖ — ПРОГРЕСС
   *   [✓ 1] Новый лид  →  [✓ 2] Приветствие  →  [► 3] Презентация  →  [ 4] Оффер  →  [ 5] Закрытие
   *   Прогресс: 2 из 5 шагов  (40%)  |  Текущий: "Презентация"  |  Цель: "Закрытие"
   */
  private buildFunnelProgressSection(diagram: FlowDiagram, currentNodeId: string): string {
    const startNode = diagram.nodes.find((n: DiagramNode) => n.type === "start");
    if (!startNode || diagram.nodes.length < 2) return "";

    // BFS order — gives us a linear reading of the funnel
    const bfsOrder: DiagramNode[] = [];
    const visited = new Set<string>();
    const queue: string[] = [startNode.id];
    while (queue.length > 0) {
      const nid = queue.shift()!;
      if (visited.has(nid)) continue;
      visited.add(nid);
      const node = diagram.nodes.find((n: DiagramNode) => n.id === nid);
      if (node) bfsOrder.push(node);
      for (const e of diagram.edges.filter((e: DiagramEdge) => e.sourceId === nid)) {
        if (!visited.has(e.targetId)) queue.push(e.targetId);
      }
    }
    // Any unreachable nodes appended
    for (const n of diagram.nodes) {
      if (!visited.has(n.id)) bfsOrder.push(n);
    }

    const total = bfsOrder.length;
    const currentIdx = bfsOrder.findIndex((n) => n.id === currentNodeId);
    if (currentIdx < 0) return "";

    const completedCount = currentIdx; // nodes strictly before current
    const pct = Math.round((completedCount / Math.max(total - 1, 1)) * 100);

    // Build compact funnel line (max 8 nodes shown to keep prompt short)
    const showNodes = bfsOrder.slice(0, 8);
    const funnelLine = showNodes
      .map((n, i) => {
        const label = n.text.slice(0, 30);
        if (n.id === currentNodeId) return `[►${i + 1}] ${label}`;
        if (i < currentIdx) return `[✓${i + 1}] ${label}`;
        return `[ ${i + 1}] ${label}`;
      })
      .join("  →  ");
    const moreStr = bfsOrder.length > 8 ? `  →  … (ещё ${bfsOrder.length - 8})` : "";

    const endNode = bfsOrder[bfsOrder.length - 1];
    const goalLabel = endNode?.text.slice(0, 50) ?? "";

    return (
      `## ВОРОНКА ПРОДАЖ — ПРОГРЕСС\n` +
      `${funnelLine}${moreStr}\n` +
      `Прогресс: ${completedCount} из ${total - 1} шагов (${pct}%)  |  ` +
      `Текущий шаг: "${bfsOrder[currentIdx]?.text.slice(0, 40)}"  |  ` +
      `Цель: "${goalLabel}"\n` +
      `⚡ Каждый твой ответ должен ПРОДВИГАТЬ клиента к следующему шагу. ` +
      `Не застревай на текущем — веди вперёд.\n`
    );
  }

  /**
   * Returns the primary signal ID for the latest client messages.
   * Same priority logic as detectClientSignals but lightweight — no text blocks,
   * used only for event logging / observability.
   */
  private getSignalId(conversationHistory: Array<{ role: string; content: string }>): string {
    const clientMsgs = conversationHistory
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => m.content.toLowerCase());
    if (clientMsgs.length === 0) return "neutral";
    const text = clientMsgs.join(" ");
    if (/злой|злит|бесит|раздраж|надоело|достало|хватит|angry|annoyed|frustrated|fed up/.test(text))
      return "angry";
    if (/готов|согласен|давай|оформим|беру|где платить|как оплатить|deal\b|i['']?m in/.test(text))
      return "close";
    if (/дорого|не по карман|бюджет|скидк|цена|стоимость|expensive|price|cost\b|afford/.test(text))
      return "price";
    if (
      /подумаю|посоветуюсь|позже|не сейчас|потом|надо подумать|i'?ll think|maybe later/.test(text)
    )
      return "delay";
    if (/партнёр|партнер|жена|муж|руководител|согласов|boss|partner|approval/.test(text))
      return "approval";
    if (/не уверен|сомневаюсь|риск|гарантии|отзывы|кейс|not sure|doubt|guarantee/.test(text))
      return "doubt";
    if (/конкурент|другой вариант|альтернатив|сравни|competitor|alternative/.test(text))
      return "competitor";
    if (/сроки|как долго|договор|когда начн|условия сотруд|timeline/.test(text)) return "details";
    if (/интересно|расскажи|хочу узнать|подробнее|tell me more|interesting/.test(text))
      return "interest";
    return "neutral";
  }

  /** Human-readable Russian label + short reason for a signal ID. */
  private getSignalLabel(signalId: string): string {
    const labels: Record<string, string> = {
      angry: "😡 Раздражение — клиент выразил недовольство",
      close: "🤝 Готов к сделке — сигнал покупки",
      price: "💰 Ценовое возражение — упомянул стоимость/бюджет",
      delay: "⏳ Откладывает — «подумаю», «потом»",
      approval: "👥 Нужно согласование — партнёр/руководитель",
      doubt: "🤔 Сомнение — просит гарантии/кейсы",
      competitor: "⚔️ Сравнивает с конкурентом",
      details: "📋 Уточняет условия — сроки/договор",
      interest: "✨ Проявляет интерес — хочет узнать больше",
      neutral: "💬 Нейтральный диалог",
    };
    return labels[signalId] ?? signalId;
  }

  /**
   * Returns the last N client messages as an array of strings for event logging.
   * Gives full context of what triggered the AI response.
   */
  private getTriggerMessages(
    conversationHistory: Array<{ role: string; content: string }>,
    n = 3,
  ): string[] {
    return conversationHistory
      .filter((m) => m.role === "user")
      .slice(-n)
      .map((m) => m.content.slice(0, 300));
  }

  /**
   * Infer the current dialog stage and a human-readable node label from
   * conversation history alone — no diagram required.
   *
   * Used for event logging AND system-prompt injection in offline-lead,
   * free-mode, and any path that doesn't have an explicit diagram node.
   * Detection is keyword-heuristic only (deterministic, no AI call).
   * Patterns cover RU / EN / TR / ES / FR so the stage is detected
   * regardless of the client's language.
   *
   * Priority order (first match wins):
   *   callback-confirmed > callback-client-time > callback-scheduling >
   *   closing > objection > re-engagement > greeting > interest >
   *   discovery > details > dialogue
   */
  protected detectDialogStage(
    history: Array<{ role: string; content: string }>,
    opts?: { isReEngaged?: boolean },
  ): { stage: string; stageLabel: string; node: string; stageInstruction: string } {
    const clientMsgs = history.filter((m) => m.role === "user");
    const turnCount = clientMsgs.length;
    const signal = this.getSignalId(history);

    // Multilingual time-mention pattern: HH:MM universal, "3am/pm", and
    // prepositions in RU / EN / TR that precede a bare hour number.
    const timeRegex =
      /\d{1,2}[:\.]\d{2}|\d{1,2}\s*(?:утра|вечера|дня|ночи|am|pm)|(?:после|в|к|около|after|at|around|saat|às|a las)\s+(\d{1,2})(?!\d)/i;

    const lastAgentWithTime = [...history]
      .reverse()
      .find((m) => m.role === "assistant" && timeRegex.test(m.content));
    const timeProposed = !!lastAgentWithTime;

    // Positive confirmation — RU / EN / TR / ES / FR
    const positiveReply =
      /\bда\b|ок\b|окей|хорош|отлич|договор|супер|ладно|давай|согласен|норм|подход|yes\b|ok\b|sure\b|good\b|deal\b|perfect\b|fine\b|agreed?\b|confirmed?\b|tamam\b|olur\b|evet\b|kabul\b|sí\b|claro\b|bueno\b|oui\b|d'accord\b/i;

    const timeAgreed =
      timeProposed &&
      (() => {
        const idx = history.lastIndexOf(lastAgentWithTime!);
        return history
          .slice(idx + 1)
          .some((m) => m.role === "user" && positiveReply.test(m.content));
      })();
    const clientMentionedTime = clientMsgs.some((m) => timeRegex.test(m.content));

    // Buying-signal presence — RU / EN / TR
    const hasBuyingSignal = clientMsgs.some((m) =>
      /цена|стоимость|сколько|условия|как работ|расскаж|интересно|хочу|могу|попробовать|записат|покупа|заказ|интересует|узнать больше|price\b|cost\b|how much|details|conditions|interested|want to|buy\b|order\b|sign.?up|try\b|book\b|tell me more|more info|how does|fiyat|ücret|ne kadar|koşullar|ilginç|almak|sipariş|bilgi/i.test(
        m.content,
      ),
    );

    // Objection-signal node labels and per-stage tactical instructions.
    // Instructions go into the AI system prompt to guide behavior at this stage.
    type StageResult = {
      stage: string;
      stageLabel: string;
      node: string;
      stageInstruction: string;
    };

    const objectionMeta: Record<string, { node: string; instruction: string }> = {
      price: {
        node: "Ценовое возражение",
        instruction:
          "Клиент поднял тему цены/бюджета. Ты уверен в своём предложении — это лучший вариант для него. " +
          "НЕЛЬЗЯ: предлагать дешевле, аналоги или «другие варианты» — это покажет сомнение в собственном оффере. " +
          "Покажи ROI и конкретную ценность: что он получит за эти деньги. " +
          "Вскрой барьер одним вопросом: «Что смущает — сумма целиком или соотношение с результатом?»",
      },
      delay: {
        node: "Откладывает решение",
        instruction:
          "Клиент откладывает. Вскрой реальную причину одним вопросом: «Что сейчас стопорит?» " +
          "Не давай давление — создай мягкую срочность через реальный факт (слот, дедлайн).",
      },
      doubt: {
        node: "Сомнения / гарантии",
        instruction:
          "Клиент сомневается. Дай конкретное социальное доказательство (кейс, цифра, гарантия). " +
          "Не говори «не сомневайтесь» — покажи факты. Один аргумент, не пять.",
      },
      approval: {
        node: "Нужно согласование",
        instruction:
          "Клиенту нужно согласовать с кем-то. Помоги подготовить аргументы: " +
          "«Что важно объяснить руководителю/партнёру?» — дай готовую формулировку выгоды.",
      },
      competitor: {
        node: "Сравнение с конкурентом",
        instruction:
          "Клиент сравнивает с конкурентом. Подчеркни 1–2 уникальных преимущества, не критикуй других. " +
          "Спроси: «Что именно сравниваете — цену, условия, скорость?» — конкретизируй.",
      },
      angry: {
        node: "Негатив клиента",
        instruction:
          "Клиент раздражён. Сначала признай: «Понимаю, это неприятно». Не спорь, не оправдывайся. " +
          "Переведи в конструктив: «Что сделать чтобы исправить ситуацию?»",
      },
    };

    // ── Priority-ordered stage detection ────────────────────────────────────
    if (timeAgreed)
      return {
        stage: "callback-confirmed",
        stageLabel: "✅ Созвон подтверждён",
        node: "Подтверждение договорённости",
        stageInstruction:
          "Время созвона уже подтверждено. Коротко подтверди договорённость и тепло заверши диалог. " +
          "НЕ продолжай продажу, НЕ задавай новые вопросы — договорённость зафиксирована.",
      };
    if (clientMentionedTime && !timeProposed)
      return {
        stage: "callback-client-time",
        stageLabel: "📅 Клиент предложил время",
        node: "Согласование времени",
        stageInstruction:
          "Клиент назвал конкретное время. Если оно входит в рабочее окно — подтверди сразу. " +
          "Если вне окна — вежливо откажи и предложи ближайший доступный слот.",
      };
    if (timeProposed)
      return {
        stage: "callback-scheduling",
        stageLabel: "📞 Предложение созвона",
        node: "Назначение встречи",
        stageInstruction:
          "Время созвона уже предложено — не повторяй его снова. " +
          "Сначала ответь по сути вопроса клиента, затем мягко уточни: «То время ещё актуально?»",
      };
    if (signal === "close")
      return {
        stage: "closing",
        stageLabel: "🤝 Готов к сделке",
        node: "Закрытие",
        stageInstruction:
          "Клиент готов к сделке — сигнал покупки получен. НЕ тормози дополнительными вопросами. " +
          "Назови конкретный следующий шаг: «Отлично, тогда...» и двигай к оформлению/звонку.",
      };
    if (signal in objectionMeta) {
      const meta = objectionMeta[signal]!;
      return {
        stage: "objection",
        stageLabel: `🛡️ Возражение (${signal})`,
        node: meta.node,
        stageInstruction: meta.instruction,
      };
    }
    if (opts?.isReEngaged && turnCount <= 2)
      return {
        stage: "re-engagement",
        stageLabel: "🔁 Реактивация — первый ответ",
        node: "Реактивация",
        stageInstruction:
          "Клиент ответил после паузы на твоё сообщение. Поздоровайся — одна тёплая короткая фраза — " +
          "и сразу к сути. Не затягивай приветствие.",
      };
    if (turnCount <= 1)
      return {
        stage: "greeting",
        stageLabel: "👋 Знакомство",
        node: "Приветствие",
        stageInstruction:
          "Первый контакт. Произведи хорошее впечатление: 1 фраза о том чем можешь помочь. " +
          "НЕ задавай несколько вопросов подряд — максимум один, и только если нужно.",
      };
    if (signal === "interest" || (hasBuyingSignal && turnCount >= 2))
      return {
        stage: "interest",
        stageLabel: "✨ Высокий интерес",
        node: "Развитие интереса",
        stageInstruction:
          "Клиент проявляет интерес — покупательская активность высокая. " +
          "Раскрывай ценность конкретными фактами/цифрами, двигай к следующему шагу (звонок, демо, условия).",
      };
    if (signal === "details")
      return {
        stage: "details",
        stageLabel: "📋 Уточнение условий",
        node: "Детали сделки",
        stageInstruction:
          "Клиент уточняет условия (сроки, договор, процесс). Отвечай конкретно и чётко. " +
          "Избегай расплывчатых «всё обсудим» — называй реальные цифры и сроки.",
      };
    if (turnCount <= 5)
      return {
        stage: "discovery",
        stageLabel: "🔍 Выявление потребностей",
        node: "Квалификация",
        stageInstruction:
          "Стадия квалификации. Задавай уточняющие вопросы — по одному. " +
          "Цель: понять ключевую боль/потребность и показать как ты её решаешь.",
      };
    return {
      stage: "dialogue",
      stageLabel: "💬 Свободный диалог",
      node: "Диалог",
      stageInstruction:
        "Открытый диалог. Отвечай по сути, не зацикливайся на одной теме. " +
        "Двигай разговор к конкретному следующему шагу.",
    };
  }

  /**
   * Detect buying signals in the latest client messages and return a
   * buyer-style tactical instruction for the agent.
   *
   * No extra AI call — keyword heuristic, fast and deterministic.
   * Detects ALL matching signals; returns the highest-priority one with a
   * brief secondary hint when two signals fire at once (e.g. "дорого, но интересно").
   *
   * Priority (lower = more urgent): angry(0) > close(1) > price(2) >
   *   delay/approval(3) > doubt(4) > competitor/details(5) > interest(6)
   */
  private detectClientSignals(
    conversationHistory: Array<{ role: string; content: string }>,
  ): string {
    const clientMsgs = conversationHistory
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => m.content.toLowerCase());
    if (clientMsgs.length === 0) return "";
    const text = clientMsgs.join(" ");

    type Signal = { id: string; priority: number; block: string };
    const matched: Signal[] = [];

    // ── 1. Агрессивный / раздражённый (деэскалация — высший приоритет) ────
    if (
      /злой|злит|бесит|раздраж|надоело|достало|хватит|ужасно|кошмар|отстой|angry|annoyed|frustrated|fed up|this is ridiculous|waste of time/.test(
        text,
      )
    ) {
      matched.push({
        id: "angry",
        priority: 0,
        block:
          `## СТАТУС: 🔴 КЛИЕНТ РАЗДРАЖЁН\n` +
          `Продавать сейчас бесполезно — сначала снять напряжение.\n` +
          `► Признай эмоцию без оправданий: "Понимаю, что неприятно — давай разберёмся прямо сейчас".\n` +
          `► НЕ защищайся, не спорь, не объясняй — только конкретный шаг к решению.\n` +
          `► Дай ощущение контроля: предложи клиенту выбрать следующий шаг.\n` +
          `► Продажу — ПОСЛЕ того как человек почувствовал что его услышали.\n`,
      });
    }

    // ── 2. Готов к сделке ─────────────────────────────────────────────────
    if (
      /готов|согласен|давай|оформим|беру|где платить|как оплатить|как купить|стартуем|let'?s do|deal\b|sounds good|i['']?m in|ok go|записывай|подписываем/.test(
        text,
      )
    ) {
      matched.push({
        id: "close",
        priority: 1,
        block:
          `## СТАТУС: 🟢 ЗАКРЫВАЕТСЯ\n` +
          `Клиент в точке решения — НЕ дай остыть.\n` +
          `► Назови конкретный следующий шаг прямо сейчас: дата/время, реквизиты, ссылка или контакт.\n` +
          `► НЕ переспрашивай "точно?", "уверены?" — просто веди к действию.\n` +
          `► Тон: деловой, спокойный, как будто так и должно быть.\n`,
      });
    }

    // ── 3. Ценовое возражение ─────────────────────────────────────────────
    if (
      /дорого|не по карман|бюджет|скидк|дешевл|сколько стоит|цена|стоимость|expensive|too (much|pricey)|cheaper|price|cost\b|afford/.test(
        text,
      )
    ) {
      matched.push({
        id: "price",
        priority: 2,
        block:
          `## СТАТУС: 💰 ЦЕНОВОЕ ВОЗРАЖЕНИЕ\n` +
          `Клиент застрял на цене — типичный этап, не паникуй. Ты уверен в своём предложении.\n` +
          `► НЕЛЬЗЯ: предлагать дешевле, аналоги или "другие варианты" — это сигнал что ты сам сомневаешься.\n` +
          `► НЕЛЬЗЯ: говорить "могу подобрать что-то более доступное" — это убивает доверие к первому варианту.\n` +
          `► Сначала: переведи в ROI — "ты платишь X, получаешь Y — окупается за Z".\n` +
          `► Потом: вскрой реальный барьер — "что смущает — сумма целиком или соотношение с результатом?"\n` +
          `► Держись своей рекомендации уверенно. Цену не снижай и альтернатив не предлагай первым.\n`,
      });
    }

    // ── 4. Откладывает / тянет ────────────────────────────────────────────
    if (
      /подумаю|посоветуюсь|позже|не сейчас|потом|нужно время|надо подумать|не готов|i'?ll think|maybe later|let me think|later|not now/.test(
        text,
      )
    ) {
      matched.push({
        id: "delay",
        priority: 3,
        block:
          `## СТАТУС: ⏳ ТЯНЕТ РЕЗИНУ\n` +
          `"Подумаю" = скрытое возражение. НЕ говори "конечно, думайте".\n` +
          `► Вскрой реальный стопор: "что конкретно стопорит — цена, время, или что-то ещё?"\n` +
          `► Покажи потери: что клиент теряет каждую неделю пока не стартовал (цифры).\n` +
          `► Создай реальную срочность: дедлайн, следующий свободный слот, изменение условий.\n` +
          `► НЕ давай "подумать" — назови конкретное следующее действие уверенно: "Давай сделаем X" — без объяснений почему это "просто" или "быстро".\n`,
      });
    }

    // ── 5. Нужно согласовать с партнёром / руководителем ─────────────────
    if (
      /партнёр|партнер|жена|муж|руководител|начальн|директор|согласов|одобрен|boss|partner|spouse|manager\b|approval|check with|ask my|tell my/.test(
        text,
      )
    ) {
      matched.push({
        id: "approval",
        priority: 3,
        block:
          `## СТАТУС: 👥 НУЖНО СОГЛАСОВАНИЕ\n` +
          `Клиент прячется за другого человека — реальный блок или мягкий отказ.\n` +
          `► Выясни: "Что конкретно нужно согласовать — условия или принципиальное решение?"\n` +
          `► Если реальный ЛПР — предложи материал для "продажи внутри": кейс, цифры, короткое резюме.\n` +
          `► Если отговорка — мягко вскрой скрытое возражение: "Что лично вас останавливает?"\n` +
          `► НЕ жди: "Давай назначим созвон с вами обоими — сэкономим время".\n`,
      });
    }

    // ── 6. Сомневается / просит доказательств ─────────────────────────────
    if (
      /не уверен|сомневаюсь|риск|а вдруг|докажи|гарантии|отзывы|кейс|пример|not sure|doubt|guarantee|proof|risk|show me|evidence/.test(
        text,
      )
    ) {
      matched.push({
        id: "doubt",
        priority: 4,
        block:
          `## СТАТУС: 🤔 НУЖНЫ ДОКАЗАТЕЛЬСТВА\n` +
          `Клиент хочет снизить воспринимаемый риск.\n` +
          `► Дай конкретный кейс с цифрами из скриптов/KB — не "многие клиенты", а "один чел из похожей ниши сделал X за Y".\n` +
          `► Используй специфику: ниша, срок, результат — чем конкретнее, тем лучше работает.\n` +
          `► Назови конкретное следующее действие уверенно — не продавай идею шага, просто его называй: "Давай сделаем X" — без слов "безопасно", "маленький", "просто".\n`,
      });
    }

    // ── 7. Конкурент / альтернатива ────────────────────────────────────────
    if (
      /конкурент|другой вариант|альтернатив|сравни|у других|видел другой|есть ещё|competitor|alternative|compare|other option/.test(
        text,
      )
    ) {
      matched.push({
        id: "competitor",
        priority: 5,
        block:
          `## СТАТУС: ⚔️ СРАВНИВАЕТ С КОНКУРЕНТОМ\n` +
          `Клиент держит open loop — изучает рынок.\n` +
          `► НЕ поливай конкурентов — это слабость.\n` +
          `► Укрепи свою позицию: назови 1–2 конкретных отличия с цифрами.\n` +
          `► Используй контраст: "там платишь за X, у нас X + Y + Z".\n` +
          `► Закрой на следующий шаг, пока ещё не ушёл к другим.\n`,
      });
    }

    // ── 8. Уточняет детали процесса (близко к решению) ───────────────────
    if (
      /сроки|как долго|что включен|условия сотруд|договор|когда начн|когда старт|как начать|что входит|порядок работ|timeline|contract|payment terms|what'?s included|how long|when (do we|can we) start/.test(
        text,
      )
    ) {
      matched.push({
        id: "details",
        priority: 5,
        block:
          `## СТАТУС: 📋 УТОЧНЯЕТ ДЕТАЛИ — БЛИЗКО К РЕШЕНИЮ\n` +
          `Вопросы о процессе = мысленная примерка. Клиент уже видит себя внутри.\n` +
          `► Ответь чётко и коротко — без лишнего.\n` +
          `► Сразу после ответа — переход к действию: "Хочешь зафиксируем дату/условия прямо сейчас?"\n` +
          `► НЕ грузи деталями сверх вопроса — это затормозит решение.\n`,
      });
    }

    // ── 9. Активный интерес ────────────────────────────────────────────────
    if (
      /интересно|расскажи|хочу узнать|подробнее|а как|а можно|tell me more|interesting|how does|what about|i want|хочу попробовать/.test(
        text,
      )
    ) {
      matched.push({
        id: "interest",
        priority: 6,
        block:
          `## СТАТУС: 🔥 ГОРЯЧИЙ ИНТЕРЕС\n` +
          `Клиент открыт — это лучший момент для продвижения.\n` +
          `► НЕ сыпь фичами — дай один конкретный результат который получит именно он.\n` +
          `► Сразу предложи следующий шаг: "давай 15-минутный созвон — покажу конкретику под твою ситуацию".\n` +
          `► Тон: уверенный, не заискивающий — ты знаешь что у тебя есть рабочий продукт.\n`,
      });
    }

    // ── 10. Нейтральный / стандартный ─────────────────────────────────────
    if (matched.length === 0) {
      return (
        `## СТАТУС: 🔵 НЕЙТРАЛЬНЫЙ\n` +
        `Стандартный ход.\n` +
        `► Выполни текущий шаг скрипта: конкретное предложение или выгода.\n` +
        `► Один вопрос в конце чтобы продвинуть к следующему узлу воронки.\n` +
        `► Думай о ROI клиента — говори его деньгами и его результатами.\n`
      );
    }

    // Sort by priority (lower = more urgent), return primary block.
    // When two signals fire at once, append a one-line tactical hint for the
    // secondary so the agent holds both in mind without bloating the prompt.
    matched.sort((a, b) => a.priority - b.priority);
    const primary = matched[0];
    const secondary = matched.length > 1 ? matched[1] : null;

    const secondaryHints: Record<string, string> = {
      close: "клиент близок к сделке",
      price: "цена тоже беспокоит",
      delay: "хочет затянуть",
      approval: "нужно согласовать",
      doubt: "есть сомнения — нужны доказательства",
      competitor: "смотрит на конкурентов",
      details: "уточняет детали процесса — почти готов",
      angry: "есть раздражение — не давить",
      interest: "есть живой интерес",
    };

    let result = primary.block;
    if (secondary) {
      const hint = secondaryHints[secondary.id] ?? secondary.id;
      result += `► Также: ${hint} — учти при ответе.\n`;
    }
    return result;
  }
}

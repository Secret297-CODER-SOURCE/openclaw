/**
 * pii-guard/index.ts — публичный API модуля
 */
export { PiiProxy, piiSessions } from './proxy.js';
export { buildPiiSystemPromptAddon, buildPiiSystemPromptAddonShort } from './system-prompt.js';
export type { PiiPattern } from './patterns.js';
export { PII_PATTERNS, SORTED_PATTERNS } from './patterns.js';

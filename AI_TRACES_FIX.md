# AI Traces Fix - Recording All AI Interactions

## Problem

The AI Traces feature in the Telegram Manager UI was not displaying any traces. Investigation revealed that traces were only being recorded for re-engagement messages, not for regular schema-based AI replies.

## Root Cause

The `fireAiTrace()` method was only called in re-engagement code paths:

- `enhanceReEngagementMessage()` - for template-enhanced re-engagement
- `generateAiReEngagement()` - for full AI-generated re-engagement

Regular AI replies in schema mode (via `runScriptStep()`) were not recording traces at all.

## Solution

Added AI trace recording to the schema-based AI reply generation in `BaseAgent.ts`:

### 1. Added Timing Tracking

```typescript
const t0 = Date.now();
let rawReply: string;
let latencyMs: number;
let aiError: Error | null = null;

try {
  rawReply = await aiReply(userText, chatKey, systemPrompt, this.storage, workspaceTools);
  latencyMs = Date.now() - t0;
} catch (err) {
  latencyMs = Date.now() - t0;
  aiError = err instanceof Error ? err : new Error(String(err));
  // ... error trace recording ...
  throw err;
}
```

### 2. Added Error Trace Recording

When AI generation fails, a trace is recorded with error details before re-throwing:

```typescript
this.fireAiTrace({
  chatId,
  inputData: {
    mode: "schema",
    nodeText: currentNode.text,
    nodeType: currentNode.type,
    userText,
    systemPrompt: systemPrompt.slice(0, 500), // Truncated for storage
    history: conversationHistory.slice(-8).map((m) => ({
      role: m.role,
      content: m.content.slice(0, 200),
    })),
    settings: {
      strict,
      hasTemplates,
      buyerMode: settings.schemaDeliveryStyle === "buyer",
      aggression: settings.buyerAggressionLevel ?? "balanced",
    },
  },
  outputData: {
    rawReply: null,
    finalReply: null,
    source: "error",
    chosenBranch: null,
  },
  meta: {
    latencyMs,
    status: "error",
    error: String(err),
  },
});
```

### 3. Added Success Trace Recording

After successful AI reply generation and validation, a comprehensive trace is recorded:

```typescript
this.fireAiTrace({
  chatId,
  inputData: {
    mode: "schema",
    nodeText: currentNode.text,
    nodeType: currentNode.type,
    userText,
    systemPrompt,
    history: conversationHistory.slice(-8).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    settings: {
      strict,
      hasTemplates,
      buyerMode: settings.schemaDeliveryStyle === "buyer",
      aggression: settings.buyerAggressionLevel ?? "balanced",
    },
  },
  outputData: {
    rawReply,
    finalReply: reply,
    source: replySource, // "template", "generated", or "rebuilt"
    chosenBranch: chosenNextNodeId ?? null,
  },
  meta: {
    latencyMs,
    status: "success",
    signal: _sig3,
    signalLabel: this.getSignalLabel(_sig3),
  },
});
```

## Trace Data Structure

Each trace now includes:

### Input Data

- `mode`: "schema" for normal replies, "ai" or "template+enhance" for re-engagement
- `nodeText`: Current diagram node text
- `nodeType`: Node type (process, decision, etc.)
- `userText`: User's message that triggered the AI reply
- `systemPrompt`: Full system prompt sent to the AI (truncated in error case)
- `history`: Last 8 conversation turns
- `settings`: Relevant agent settings (strict mode, buyer mode, aggression level)

### Output Data

- `rawReply`: Raw AI response before any processing
- `finalReply`: Final reply after validation/guards/processing
- `source`: How the reply was generated ("template", "generated", "rebuilt", "error")
- `chosenBranch`: For multi-exit decision nodes, which branch was chosen

### Metadata

- `latencyMs`: AI call latency in milliseconds
- `status`: "success" or "error"
- `error`: Error message (if status is "error")
- `signal`: User sentiment signal
- `signalLabel`: Human-readable signal label

## Impact

Now the "AI Traces" tab in the Telegram Manager UI will show:

1. **All regular schema-based AI replies** with full context:
   - What the user said
   - What system prompt was used
   - What the AI generated
   - What was actually sent (after guards/validation)
   - How long it took

2. **Error traces** when AI generation fails:
   - What went wrong
   - How long it took before failing
   - Input context for debugging

3. **Re-engagement traces** (already working):
   - Template-enhanced messages
   - Fully AI-generated re-engagement messages

## Files Modified

- `extensions/telegram-manager/src/agents/BaseAgent.ts`
  - Added timing tracking around `aiReply()` call
  - Wrapped AI call in try-catch to record error traces
  - Added `fireAiTrace()` call after successful reply processing

## Testing

Build completed successfully:

```bash
pnpm build --filter=@openclaw/telegram-manager
✔ Build complete in 1410ms
```

## Benefits

1. **Complete audit trail**: Every AI interaction is now logged
2. **Performance monitoring**: Latency tracking for all AI calls
3. **Error debugging**: Failed AI calls are captured with full context
4. **User experience insights**: Can see exactly what the AI generated vs what was sent
5. **Quality control**: Can review AI outputs and identify issues

## Notes

- Traces are fire-and-forget (via `setImmediate`) so they never block message delivery
- Failed trace writes retry once after 2 seconds, then silently drop
- Traces are stored in the `ai_traces` SQLite table with automatic cleanup of old entries
- The UI limits display to the last 30 traces per agent

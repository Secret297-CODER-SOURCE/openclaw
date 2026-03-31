import { describe, expect, it } from "vitest";
import { processTelegramTrainingFile } from "./telegram.ts";

function createState() {
  return {
    client: null,
    connected: false,
    telegramTrainingLoading: false,
    telegramTrainingError: null,
    telegramShowCreateNodesPrompt: true,
    telegramTrainingGroups: [] as Array<{
      chatId: string;
      participantName: string;
      firstDate: string;
      lastDate: string;
      pairs: Array<{ input: string; response: string }>;
    }>,
    telegramTrainingPairs: [] as Array<{
      id: string;
      input: string;
      response: string;
      sourceFile: string;
    }>,
    telegramTrainingScope: "personal" as const,
    telegramTrainingLabels: {} as Record<string, "success" | "fail" | "neutral">,
    telegramAnalysisResults: {} as Record<
      string,
      { status: string; score: number; reason: string }
    >,
  };
}

describe("processTelegramTrainingFile", () => {
  it("imports editor snapshot JSON with groups + labels", async () => {
    const state = createState();
    const json = JSON.stringify({
      groups: [
        {
          chatId: "chat-1",
          participantName: "Alice",
          firstDate: "2026-03-01T10:00:00Z",
          lastDate: "2026-03-01T10:02:00Z",
          pairs: [{ input: "Привет", response: "Привет, чем помочь?" }],
        },
      ],
      labels: { "chat-1": "success" },
      analysisResults: {
        "chat-1": {
          status: "success",
          score: 93,
          reason: "Инициативный менеджер",
          analyzedAt: "2026-03-31T10:00:00Z",
        },
      },
    });

    await processTelegramTrainingFile(state as never, "agent-1", json, "snapshot.json");

    expect(state.telegramTrainingError).toBeNull();
    expect(state.telegramTrainingGroups).toHaveLength(1);
    expect(state.telegramTrainingGroups[0]?.chatId).toBe("chat-1");
    expect(state.telegramTrainingPairs).toHaveLength(1);
    expect(state.telegramTrainingLabels["chat-1"]).toBe("success");
    expect(state.telegramAnalysisResults["chat-1"]?.score).toBe(93);
  });

  it("imports generic chat-list JSON with role-based messages", async () => {
    const state = createState();
    const json = JSON.stringify({
      chats: [
        {
          chatId: "chat-2",
          participantName: "Bob",
          messages: [
            { role: "client", text: "Сколько стоит?", date: "2026-03-01T11:00:00Z" },
            {
              role: "manager",
              text: "Для вас 20 000, окупаемость 2 месяца.",
              date: "2026-03-01T11:01:00Z",
            },
          ],
        },
      ],
    });

    await processTelegramTrainingFile(state as never, "agent-1", json, "chat-list.json");

    expect(state.telegramTrainingError).toBeNull();
    expect(state.telegramTrainingGroups).toHaveLength(1);
    expect(state.telegramTrainingGroups[0]?.participantName).toBe("Bob");
    expect(state.telegramTrainingPairs).toHaveLength(1);
    expect(state.telegramTrainingPairs[0]?.input).toBe("Сколько стоит?");
  });
});

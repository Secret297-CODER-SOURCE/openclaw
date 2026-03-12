import { describe, expect, it } from "vitest";
import {
  normalizeTelegramCommandDescription,
  resolveTelegramCustomCommands,
  TELEGRAM_COMMAND_DESCRIPTION_MAX_LENGTH,
} from "./telegram-custom-commands.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("telegram custom commands schema", () => {
  it("normalizes custom commands", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          customCommands: [{ command: "/Backup", description: "  Git backup  " }],
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.channels?.telegram?.customCommands).toEqual([
      { command: "backup", description: "Git backup" },
    ]);
  });

  it("normalizes hyphens in custom command names", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          customCommands: [{ command: "Bad-Name", description: "Override status" }],
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.channels?.telegram?.customCommands).toEqual([
      { command: "bad_name", description: "Override status" },
    ]);
  });
});

describe("normalizeTelegramCommandDescription", () => {
  it("trims whitespace", () => {
    expect(normalizeTelegramCommandDescription("  Hello world  ")).toBe("Hello world");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeTelegramCommandDescription("   ")).toBe("");
  });

  it("truncates descriptions longer than 256 characters with ellipsis", () => {
    const long = "A".repeat(300);
    const result = normalizeTelegramCommandDescription(long);
    expect(result).toHaveLength(TELEGRAM_COMMAND_DESCRIPTION_MAX_LENGTH);
    expect(result.endsWith("…")).toBe(true);
  });

  it("does not truncate descriptions at exactly 256 characters", () => {
    const exact = "A".repeat(TELEGRAM_COMMAND_DESCRIPTION_MAX_LENGTH);
    expect(normalizeTelegramCommandDescription(exact)).toBe(exact);
  });
});

describe("resolveTelegramCustomCommands", () => {
  it("rejects commands with descriptions shorter than 3 characters", () => {
    const result = resolveTelegramCustomCommands({
      commands: [{ command: "cmd", description: "ab" }],
    });

    expect(result.commands).toHaveLength(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toContain("too short");
  });

  it("accepts descriptions with exactly 3 characters", () => {
    const result = resolveTelegramCustomCommands({
      commands: [{ command: "cmd", description: "abc" }],
    });

    expect(result.commands).toHaveLength(1);
    expect(result.issues).toHaveLength(0);
  });

  it("truncates descriptions longer than 256 characters", () => {
    const long = "A".repeat(300);
    const result = resolveTelegramCustomCommands({
      commands: [{ command: "cmd", description: long }],
    });

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.description).toHaveLength(TELEGRAM_COMMAND_DESCRIPTION_MAX_LENGTH);
    expect(result.issues).toHaveLength(0);
  });
});

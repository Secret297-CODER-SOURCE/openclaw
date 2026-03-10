import { describe, expect, it } from "vitest";
import {
  agentResponseRequestsConfirmation,
  buildConfirmationRequiredSystemNote,
  buildPendingConfirmationNote,
  isConfirmationResponse,
  isRejectionResponse,
} from "./dialogue-confirmation.js";

describe("isConfirmationResponse", () => {
  it("returns true for 'yes'", () => {
    expect(isConfirmationResponse("yes")).toBe(true);
  });

  it("returns true for 'ok'", () => {
    expect(isConfirmationResponse("ok")).toBe(true);
  });

  it("returns true for Russian 'да'", () => {
    expect(isConfirmationResponse("да")).toBe(true);
  });

  it("returns true for Russian 'ок'", () => {
    expect(isConfirmationResponse("ок")).toBe(true);
  });

  it("returns true for 'confirm'", () => {
    expect(isConfirmationResponse("confirm")).toBe(true);
  });

  it("returns true for 'yes!'", () => {
    expect(isConfirmationResponse("yes!")).toBe(true);
  });

  it("returns true for 'согласен'", () => {
    expect(isConfirmationResponse("согласен")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isConfirmationResponse("")).toBe(false);
  });

  it("returns false for unrelated text", () => {
    expect(isConfirmationResponse("What time is it?")).toBe(false);
  });
});

describe("isRejectionResponse", () => {
  it("returns true for 'no'", () => {
    expect(isRejectionResponse("no")).toBe(true);
  });

  it("returns true for 'cancel'", () => {
    expect(isRejectionResponse("cancel")).toBe(true);
  });

  it("returns true for Russian 'нет'", () => {
    expect(isRejectionResponse("нет")).toBe(true);
  });

  it("returns true for 'stop'", () => {
    expect(isRejectionResponse("stop")).toBe(true);
  });

  it("returns true for 'отмена'", () => {
    expect(isRejectionResponse("отмена")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isRejectionResponse("")).toBe(false);
  });

  it("returns false for unrelated text", () => {
    expect(isRejectionResponse("What time is it?")).toBe(false);
  });
});

describe("agentResponseRequestsConfirmation", () => {
  it("returns true for 'Please confirm this action'", () => {
    expect(agentResponseRequestsConfirmation("Please confirm this action.")).toBe(true);
  });

  it("returns true for 'Do you confirm?'", () => {
    expect(agentResponseRequestsConfirmation("Do you confirm this?")).toBe(true);
  });

  it("returns true for 'Would you like me to proceed?'", () => {
    expect(agentResponseRequestsConfirmation("Would you like me to proceed?")).toBe(true);
  });

  it("returns true for 'Shall I proceed?'", () => {
    expect(agentResponseRequestsConfirmation("Shall I proceed?")).toBe(true);
  });

  it("returns true for Russian 'Подтвердите'", () => {
    expect(agentResponseRequestsConfirmation("Подтвердите ваше решение.")).toBe(true);
  });

  it("returns false for regular text", () => {
    expect(agentResponseRequestsConfirmation("I have completed the task.")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(agentResponseRequestsConfirmation("")).toBe(false);
  });
});

describe("buildPendingConfirmationNote", () => {
  it("includes the task in the note", () => {
    const note = buildPendingConfirmationNote("delete all files");
    expect(note).toContain("delete all files");
    expect(note).toContain("awaiting user confirmation");
  });
});

describe("buildConfirmationRequiredSystemNote", () => {
  it("contains the confirmation-required instructions", () => {
    const note = buildConfirmationRequiredSystemNote();
    expect(note).toContain("confirmation required");
    expect(note.toLowerCase()).toContain("explicitly ask the user to confirm");
  });
});

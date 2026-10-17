import { describe, expect, it } from "vitest";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import {
  isActionableInteraction,
  buildInteractionCallbackData,
  parseInteractionCallbackData,
  INTERACTION_ACCEPT_PREFIX,
  INTERACTION_REJECT_PREFIX,
} from "../src/interaction-routing.js";

function interaction(overrides: Partial<IssueThreadInteraction> = {}): IssueThreadInteraction {
  return {
    id: "int-1",
    kind: "request_confirmation",
    status: "pending",
    payload: { version: 1, prompt: "Ship it?" },
    ...overrides,
  } as IssueThreadInteraction;
}

describe("isActionableInteraction", () => {
  it("accepts a pending request_confirmation", () => {
    expect(isActionableInteraction(interaction())).toBe(true);
  });

  it("rejects non-pending confirmations", () => {
    for (const status of ["accepted", "rejected", "answered", "cancelled", "expired", "failed"] as const) {
      expect(isActionableInteraction(interaction({ status }))).toBe(false);
    }
  });

  it("rejects kinds that cannot be resolved by accept/reject", () => {
    for (const kind of [
      "suggest_tasks",
      "ask_user_questions",
      "request_checkbox_confirmation",
      "request_item_verdicts",
      "connection_intent",
    ] as const) {
      expect(isActionableInteraction(interaction({ kind } as Partial<IssueThreadInteraction>))).toBe(false);
    }
  });
});

describe("interaction callback_data codec", () => {
  const uuid = "6f8f1c7e-2b4a-4c1d-9e3a-1f2b3c4d5e6f";

  it("round-trips accept and reject", () => {
    expect(parseInteractionCallbackData(buildInteractionCallbackData("accept", uuid))).toEqual({
      action: "accept",
      interactionId: uuid,
    });
    expect(parseInteractionCallbackData(buildInteractionCallbackData("reject", uuid))).toEqual({
      action: "reject",
      interactionId: uuid,
    });
  });

  it("stays within Telegram's 64-byte callback_data limit", () => {
    expect(Buffer.byteLength(buildInteractionCallbackData("accept", uuid))).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(buildInteractionCallbackData("reject", uuid))).toBeLessThanOrEqual(64);
  });

  it("ignores foreign callback_data (approvals, escalations, empty ids)", () => {
    expect(parseInteractionCallbackData(`approve_${uuid}`)).toBeNull();
    expect(parseInteractionCallbackData(`reject_${uuid}`)).toBeNull();
    expect(parseInteractionCallbackData(`esc_defer_${uuid}`)).toBeNull();
    expect(parseInteractionCallbackData(INTERACTION_ACCEPT_PREFIX)).toBeNull();
    expect(parseInteractionCallbackData(INTERACTION_REJECT_PREFIX)).toBeNull();
  });

  it("uses prefixes distinct from the approval prefixes", () => {
    expect(INTERACTION_ACCEPT_PREFIX.startsWith("approve_")).toBe(false);
    expect(INTERACTION_REJECT_PREFIX.startsWith("reject_")).toBe(false);
  });
});

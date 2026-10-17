import { describe, it, expect } from "vitest";
import type { RequestConfirmationInteraction } from "@paperclipai/shared";
import { formatIssueInteraction } from "../src/formatters.js";

function card(overrides: Partial<RequestConfirmationInteraction["payload"]> = {}): RequestConfirmationInteraction {
  return {
    id: "6f8f1c7e-2b4a-4c1d-9e3a-1f2b3c4d5e6f",
    kind: "request_confirmation",
    status: "pending",
    title: "Deploy to production?",
    payload: { version: 1, prompt: "Roll out build 42 to prod now?", ...overrides },
  } as RequestConfirmationInteraction;
}

describe("formatIssueInteraction", () => {
  it("renders the prompt and uses MarkdownV2", () => {
    const msg = formatIssueInteraction(card());
    expect(msg.text).toContain("Roll out build 42 to prod now?");
    expect(msg.options.parseMode).toBe("MarkdownV2");
  });

  it("uses the interaction title as the heading, falling back to a default", () => {
    expect(formatIssueInteraction(card()).text).toContain("Deploy to production?");
    const noTitle = formatIssueInteraction({ ...card(), title: null } as RequestConfirmationInteraction);
    expect(noTitle.text).toContain("Decision needed");
  });

  it("builds accept/reject buttons carrying the interaction id", () => {
    const [row] = formatIssueInteraction(card()).options.inlineKeyboard!;
    expect(row[0]!.callback_data).toBe("int_accept_6f8f1c7e-2b4a-4c1d-9e3a-1f2b3c4d5e6f");
    expect(row[1]!.callback_data).toBe("int_reject_6f8f1c7e-2b4a-4c1d-9e3a-1f2b3c4d5e6f");
  });

  it("honours custom accept/reject labels", () => {
    const [row] = formatIssueInteraction(card({ acceptLabel: "Ship", rejectLabel: "Hold" })).options
      .inlineKeyboard!;
    expect(row[0]!.text).toContain("Ship");
    expect(row[1]!.text).toContain("Hold");
  });

  it("adds an issue deep-link button when an external base URL is known", () => {
    const msg = formatIssueInteraction(
      card(),
      { identifier: "ART-7", title: "Release" },
      { baseUrl: "https://paperclip.example.com", issuePrefix: "ART" },
    );
    expect(msg.text).toContain("ART\\-7");
    const urlButton = msg.options.inlineKeyboard!.flat().find((b) => b.url);
    expect(urlButton?.url).toContain("/ART/issues/ART-7");
  });

  it("includes details when present", () => {
    const msg = formatIssueInteraction(card({ detailsMarkdown: "Changelog: fixes login bug" }));
    expect(msg.text).toContain("Changelog: fixes login bug");
  });
});

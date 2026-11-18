import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { RequestConfirmationInteraction } from "@paperclipai/shared";

vi.mock("@paperclipai/plugin-sdk", async () => {
  const actual = (await vi.importActual("@paperclipai/plugin-sdk")) as Record<string, unknown>;
  return { ...actual, runWorker: vi.fn() };
});

type Call = { chatId: string; messageId?: number; text: string; options?: Record<string, unknown> };
const sent: Call[] = [];
const edited: Call[] = [];
const answered: string[] = [];
let nextMessageId = 900;

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_c: unknown, _t: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sent.push({ chatId, text, options });
      return nextMessageId++;
    }),
    editMessage: vi.fn(async (_c: unknown, _t: string, chatId: string, messageId: number, text: string, options?: Record<string, unknown>) => {
      edited.push({ chatId, messageId, text, options });
      return true;
    }),
    answerCallbackQuery: vi.fn(async (_c: unknown, _t: string, _id: string, text: string) => {
      answered.push(text ?? "");
      return true;
    }),
  };
});

import { handleUpdate } from "../src/worker.js";
import { formatIssueInteraction, markdownToMarkdownV2 } from "../src/formatters.js";

const UUID = "6f8f1c7e-2b4a-4c1d-9e3a-1f2b3c4d5e6f";
const CHAT_ID = 123456;
const CARD_MSG_ID = 55;
const ISSUE_ID = "issue-abc";
const COMPANY_ID = "company-xyz";
const CARD_TEXT = "🗳️ *Freigabe* full card text";

function card(overrides: Partial<RequestConfirmationInteraction["payload"]> = {}): RequestConfirmationInteraction {
  return {
    id: UUID,
    kind: "request_confirmation",
    status: "pending",
    title: "Freigabe",
    payload: { version: 1, prompt: "Freigeben?", ...overrides },
  } as RequestConfirmationInteraction;
}

function mockCtx(opts: { rejectRequiresReason?: boolean } = {}) {
  const state = new Map<string, unknown>();
  state.set(`msg_${CHAT_ID}_${CARD_MSG_ID}`, {
    entityId: ISSUE_ID,
    entityType: "issue_interaction",
    companyId: COMPANY_ID,
    interactionId: UUID,
    rejectRequiresReason: opts.rejectRequiresReason ?? false,
    cardText: CARD_TEXT,
    cardKeyboard: [
      [
        { text: "✅ Freigeben", callback_data: `int_accept_${UUID}` },
        { text: "❌ Nicht freigeben", callback_data: `int_reject_${UUID}` },
      ],
      [{ text: "Open ART-1 ↗", url: "https://paperclip.example.com/ART/issues/ART-1" }],
    ],
    acceptLabel: "Freigeben",
    rejectLabel: "Nicht freigeben",
    rejectReasonLabel: "Begründung (geht zurück an die Redaktion)",
  });
  const respondInteraction = vi.fn().mockResolvedValue({ applied: true });
  const createComment = vi.fn().mockResolvedValue({ id: "c1" });
  const ctx = {
    http: { fetch: vi.fn() },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    secrets: { resolve: vi.fn().mockResolvedValue(undefined) },
    state: {
      get: vi.fn(async (k: { stateKey: string }) => state.get(k.stateKey) ?? null),
      set: vi.fn(async (k: { stateKey: string }, v: unknown) => void state.set(k.stateKey, v)),
      delete: vi.fn(async (k: { stateKey: string }) => void state.delete(k.stateKey)),
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    issues: { respondInteraction, createComment },
  } as unknown as PluginContext;
  return { ctx, state, respondInteraction, createComment };
}

const config = {
  enableCommands: true,
  enableInbound: true,
  allowedTelegramUserIds: [],
  allowedTelegramChatIds: [],
  issueInteractionActorUserId: "actor-user-1",
  interactionLocale: "de",
} as unknown as Parameters<typeof handleUpdate>[2];

function callback(data: string, messageId = CARD_MSG_ID) {
  return {
    update_id: 1,
    callback_query: {
      id: "cq-1",
      from: { id: 1, username: "owner" },
      message: { message_id: messageId, chat: { id: CHAT_ID } },
      data,
    },
  } as unknown as Parameters<typeof handleUpdate>[3];
}

function reply(text: string, replyTo: number) {
  return {
    update_id: 2,
    message: {
      message_id: 700,
      chat: { id: CHAT_ID, type: "private" },
      from: { id: 1, username: "owner" },
      text,
      reply_to_message: { message_id: replyTo, from: { id: 99, is_bot: true } },
    },
  } as unknown as Parameters<typeof handleUpdate>[3];
}

beforeEach(() => {
  sent.length = 0;
  edited.length = 0;
  answered.length = 0;
  nextMessageId = 900;
});

describe("markdownToMarkdownV2", () => {
  it("renders bold, code, links and bullets instead of escaping them raw", () => {
    const out = markdownToMarkdownV2("**Fassung:** `1690667` (r1)\n- Slug: `a-b`\n[Doku](https://x.example/a_b)");
    expect(out).toBe("*Fassung:* `1690667` \\(r1\\)\n• Slug: `a-b`\n[Doku](https://x.example/a_b)");
  });

  it("leaves snake_case and lone asterisks alone", () => {
    expect(markdownToMarkdownV2("status_draft 2 * 3")).toBe("status\\_draft 2 \\* 3");
  });
});

describe("formatIssueInteraction full text", () => {
  it("does not truncate long details", () => {
    const details = Array.from({ length: 6 }, (_, i) => `Absatz ${i} ` + "x".repeat(300)).join("\n\n");
    const msg = formatIssueInteraction(card({ detailsMarkdown: details }));
    expect(msg.leadingParts).toHaveLength(0);
    expect(msg.text).toContain("Absatz 5");
    expect(msg.text).not.toContain("...");
  });

  it("splits over-long cards into parts with the buttons on the last one", () => {
    const details = Array.from({ length: 20 }, (_, i) => `Absatz ${i} ` + "y".repeat(400)).join("\n\n");
    const msg = formatIssueInteraction(card({ detailsMarkdown: details }));
    const all = [...msg.leadingParts, msg.text];
    expect(all.length).toBeGreaterThan(1);
    for (const part of all) expect(part.length).toBeLessThanOrEqual(4096);
    expect(all.join("\n")).toContain("Absatz 19");
    expect(msg.text).toContain(`\\(${all.length}/${all.length}\\)`);
    expect(msg.options.inlineKeyboard![0]![0]!.callback_data).toBe(`int_accept_${UUID}`);
  });
});

describe("reject with optional reason", () => {
  it("asks for a reason and offers reject-without-reason / back on the card", async () => {
    const { ctx, respondInteraction } = mockCtx();
    await handleUpdate(ctx, "token", config, callback(`int_reject_${UUID}`), "http://localhost:3100");

    expect(respondInteraction).not.toHaveBeenCalled();
    expect(sent[0]!.text).toContain("Begründung (geht zurück an die Redaktion)");
    expect(sent[0]!.options).toMatchObject({ forceReply: true, replyToMessageId: CARD_MSG_ID });
    const kb = edited[0]!.options!.inlineKeyboard as Array<Array<{ callback_data?: string; url?: string }>>;
    expect(kb[0]!.map((b) => b.callback_data)).toEqual([`int_rnow_${UUID}`, `int_back_${UUID}`]);
    expect(kb[1]![0]!.url).toContain("ART-1");
    expect(edited[0]!.text).toBe(CARD_TEXT);
  });

  it("rejects with the reply as reason and keeps the card text", async () => {
    const { ctx, respondInteraction } = mockCtx();
    await handleUpdate(ctx, "token", config, callback(`int_reject_${UUID}`), "http://localhost:3100");
    await handleUpdate(ctx, "token", config, reply("Bitte Einleitung kürzen", 900), "http://localhost:3100");

    expect(respondInteraction).toHaveBeenCalledWith(
      ISSUE_ID,
      UUID,
      { action: "reject", actorUserId: "actor-user-1", reason: "Bitte Einleitung kürzen" },
      COMPANY_ID,
    );
    const last = edited[edited.length - 1]!;
    expect(last.messageId).toBe(CARD_MSG_ID);
    expect(last.text.startsWith(CARD_TEXT)).toBe(true);
    expect(last.text).toContain("Nicht freigeben");
    expect(last.text).toContain("Begründung: Bitte Einleitung kürzen");
  });

  it("rejects without reason via the swapped button", async () => {
    const { ctx, respondInteraction } = mockCtx();
    await handleUpdate(ctx, "token", config, callback(`int_rnow_${UUID}`), "http://localhost:3100");
    expect(respondInteraction).toHaveBeenCalledWith(ISSUE_ID, UUID, { action: "reject", actorUserId: "actor-user-1", reason: null }, COMPANY_ID);
  });

  it("restores the original buttons on back", async () => {
    const { ctx, respondInteraction } = mockCtx();
    await handleUpdate(ctx, "token", config, callback(`int_back_${UUID}`), "http://localhost:3100");
    expect(respondInteraction).not.toHaveBeenCalled();
    const kb = edited[0]!.options!.inlineKeyboard as Array<Array<{ callback_data?: string }>>;
    expect(kb[0]![0]!.callback_data).toBe(`int_accept_${UUID}`);
  });

  it("required reason: prompt only, buttons untouched", async () => {
    const { ctx } = mockCtx({ rejectRequiresReason: true });
    await handleUpdate(ctx, "token", config, callback(`int_reject_${UUID}`), "http://localhost:3100");
    expect(sent).toHaveLength(1);
    expect(edited).toHaveLength(0);
  });

  it("accept keeps the card text and appends the outcome", async () => {
    const { ctx } = mockCtx();
    await handleUpdate(ctx, "token", config, callback(`int_accept_${UUID}`), "http://localhost:3100");
    expect(edited[0]!.text.startsWith(CARD_TEXT)).toBe(true);
    expect(edited[0]!.text).toContain("Freigeben");
    expect(edited[0]!.text).toContain("von owner");
  });
});

describe("direct reply to a decision card", () => {
  it("asks what to do, then rejects with the reply as reason", async () => {
    const { ctx, respondInteraction, state } = mockCtx();
    await handleUpdate(ctx, "token", config, reply("Titel passt nicht", CARD_MSG_ID), "http://localhost:3100");

    expect(respondInteraction).not.toHaveBeenCalled();
    expect(sent[0]!.text).toContain("Was soll mit deiner Antwort passieren?");
    const choiceId = 900;
    expect(state.get(`intreply_${CHAT_ID}_${choiceId}`)).toMatchObject({ text: "Titel passt nicht" });

    await handleUpdate(ctx, "token", config, callback(`int_rr_${choiceId}`, choiceId), "http://localhost:3100");
    expect(respondInteraction).toHaveBeenCalledWith(
      ISSUE_ID,
      UUID,
      { action: "reject", actorUserId: "actor-user-1", reason: "Titel passt nicht" },
      COMPANY_ID,
    );
    expect(state.has(`intreply_${CHAT_ID}_${choiceId}`)).toBe(false);
  });

  it("posts the reply as a human-attributed comment", async () => {
    const { ctx, respondInteraction, createComment } = mockCtx();
    await handleUpdate(ctx, "token", config, reply("Bitte noch ein Beispiel", CARD_MSG_ID), "http://localhost:3100");
    await handleUpdate(ctx, "token", config, callback("int_rc_900", 900), "http://localhost:3100");
    expect(createComment).toHaveBeenCalledWith(ISSUE_ID, "Bitte noch ein Beispiel", COMPANY_ID, { actorUserId: "actor-user-1" });
    expect(respondInteraction).not.toHaveBeenCalled();
  });

  it("discards without side effects", async () => {
    const { ctx, respondInteraction, createComment, state } = mockCtx();
    await handleUpdate(ctx, "token", config, reply("egal", CARD_MSG_ID), "http://localhost:3100");
    await handleUpdate(ctx, "token", config, callback("int_rd_900", 900), "http://localhost:3100");
    expect(respondInteraction).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(state.has(`intreply_${CHAT_ID}_900`)).toBe(false);
  });

  it("ignores a choice callback from a different message", async () => {
    const { ctx, respondInteraction } = mockCtx();
    await handleUpdate(ctx, "token", config, reply("x", CARD_MSG_ID), "http://localhost:3100");
    await handleUpdate(ctx, "token", config, callback("int_rr_900", 901), "http://localhost:3100");
    expect(respondInteraction).not.toHaveBeenCalled();
  });
});

import { formatIssueDocumentParts } from "../src/formatters.js";

describe("formatIssueDocumentParts", () => {
  it("renders the document and cuts at the total limit with a note", () => {
    const body = Array.from({ length: 10 }, (_, i) => `## Teil ${i}\n\n` + "w ".repeat(300)).join("\n\n");
    const parts = formatIssueDocumentParts({ key: "beitrag", title: "T", body }, { identifier: "ART-1" }, undefined, 3800, 2500);
    const all = parts.join("\n");
    expect(all).toContain("*Teil 0*");
    expect(all).toContain("gekürzt");
    expect(all).not.toContain("Teil 9");
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
  });

  it("returns nothing for an empty document", () => {
    expect(formatIssueDocumentParts({ key: "beitrag", body: "  " })).toEqual([]);
  });
});

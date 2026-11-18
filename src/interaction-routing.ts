import type {
  IssueThreadInteraction,
  RequestConfirmationInteraction,
  AskUserQuestionsInteraction,
  RequestItemVerdictsInteraction,
} from "@paperclipai/shared";

// Issue-thread-interaction ("decision card") Telegram wiring.
//
// The host has no `interaction.created` event, so the plugin discovers decision
// cards by listing an issue's interactions whenever that issue changes
// (issue.created / issue.updated — both already subscribed). Only the daily
// binary decision cards are actionable from Telegram: `respondInteraction` is
// accept/reject(+reason), so `request_confirmation` is the one kind a two-button
// message can fully resolve. The richer kinds (ask_user_questions,
// request_checkbox_confirmation, request_item_verdicts) need the web UI and are
// left to the existing digest path.

export const INTERACTION_ACCEPT_PREFIX = "int_accept_";
export const INTERACTION_REJECT_PREFIX = "int_reject_";
export const INTERACTION_REJECT_NOW_PREFIX = "int_rnow_";
export const INTERACTION_BACK_PREFIX = "int_back_";
export const INTERACTION_REPLY_REJECT_PREFIX = "int_rr_";
export const INTERACTION_REPLY_COMMENT_PREFIX = "int_rc_";
export const INTERACTION_REPLY_DISCARD_PREFIX = "int_rd_";

/** State key holding a free-text reply to a card until the user picks what to do with it. */
export function interactionReplyStateKey(chatId: string, choiceMessageId: number): string {
  return `intreply_${chatId}_${choiceMessageId}`;
}

/**
 * State entityType stored on an interaction notification's `msg_<chat>_<id>`
 * record so callbacks and reason replies can recover the issue/company/interaction.
 */
export const INTERACTION_ENTITY_TYPE = "issue_interaction";
/** entityType stored on the force_reply "reason?" prompt message. */
export const INTERACTION_REASON_ENTITY_TYPE = "issue_interaction_reason";

/**
 * True when this interaction is a daily decision card the plugin can both
 * notify about and resolve from Telegram: a still-pending `request_confirmation`.
 * `respondInteraction` is accept/reject, so this is the one kind two buttons can
 * fully resolve.
 */
export function isActionableInteraction(
  interaction: IssueThreadInteraction,
): interaction is RequestConfirmationInteraction {
  return interaction.kind === "request_confirmation" && interaction.status === "pending";
}

/**
 * True when this is a pending decision the plugin should surface but CANNOT
 * resolve from Telegram: `ask_user_questions` (multiple-choice answers) and
 * `request_item_verdicts` (per-item approve/reject/defer). The plugin SDK
 * (@paperclipai/plugin-sdk 2026.1012.0) exposes only `respondInteraction`
 * (accept/reject) — there is no host method to submit question answers or item
 * verdicts — so these are forwarded as notify-only cards with an "open in
 * Paperclip" deep link rather than dropped onto the n8n digest silently.
 */
export function isNotifyOnlyInteraction(
  interaction: IssueThreadInteraction,
): interaction is AskUserQuestionsInteraction | RequestItemVerdictsInteraction {
  return (
    interaction.status === "pending" &&
    (interaction.kind === "ask_user_questions" || interaction.kind === "request_item_verdicts")
  );
}

/**
 * Any pending interaction the plugin forwards to Telegram — actionable
 * (accept/reject buttons) or notify-only (deep link). Other kinds
 * (suggest_tasks, request_checkbox_confirmation, connection_intent) stay on the
 * digest path.
 */
export function isForwardableInteraction(interaction: IssueThreadInteraction): boolean {
  return isActionableInteraction(interaction) || isNotifyOnlyInteraction(interaction);
}

/**
 * accept/reject — the card's two main buttons.
 * reject_now — "reject without a reason" (shown while an optional reason is asked for).
 * back — restore the card's original buttons (cancel a started rejection).
 */
export type InteractionCallback = {
  action: "accept" | "reject" | "reject_now" | "back";
  interactionId: string;
};

/** Choice offered after a free-text reply to a card: reject with it, post it as comment, discard. */
export type InteractionReplyCallback = {
  action: "reply_reject" | "reply_comment" | "reply_discard";
  /** message_id of the bot's choice message, which keys the pending reply state. */
  choiceMessageId: number;
};

/** An issue worth re-listing interactions for on a scheduler-poll tick. */
export type InteractionCandidate = {
  issueId: string;
  companyId: string;
};

/**
 * Bounded, time-windowed record of issues the plugin has recently seen events
 * for, feeding the scheduler-poll fallback (worker's `check-issue-interactions`
 * job).
 *
 * The event-driven path misses a decision card that is posted without a
 * *subsequent* issue.updated: the host fires issue.created before the card
 * exists, and card creation itself need not emit a plugin-visible issue.updated
 * (observed live — a card only forwarded once an unrelated priority bump fired
 * a later issue.updated). Re-listing the interactions of recently-active issues
 * a tick later catches that gap without enumerating the whole board.
 *
 * Bounded two ways: entries older than `ttlMs` are dropped, and the newest
 * `maxEntries` are kept when the map would grow past that. Re-recording an
 * issue refreshes its timestamp so a steadily-active issue never ages out.
 */
export function createRecentIssueTracker(options: { ttlMs?: number; maxEntries?: number } = {}) {
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const maxEntries = options.maxEntries ?? 200;
  const seen = new Map<string, { companyId: string; ts: number }>();

  function prune(now: number): void {
    for (const [issueId, rec] of seen) {
      if (now - rec.ts >= ttlMs) seen.delete(issueId);
    }
    if (seen.size > maxEntries) {
      const byAge = [...seen.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < byAge.length - maxEntries; i++) seen.delete(byAge[i]![0]);
    }
  }

  return {
    record(issueId: string, companyId: string, now: number = Date.now()): void {
      if (!issueId || !companyId) return;
      seen.set(issueId, { companyId, ts: now });
      prune(now);
    },
    candidates(now: number = Date.now()): InteractionCandidate[] {
      prune(now);
      return [...seen.entries()].map(([issueId, rec]) => ({ issueId, companyId: rec.companyId }));
    },
    get size(): number {
      return seen.size;
    },
  };
}

export type RecentIssueTracker = ReturnType<typeof createRecentIssueTracker>;

/**
 * Merge candidate lists (tracked activity first, then wider nets) into a
 * deduped, capped set. First occurrence of an issueId wins, so the
 * higher-signal source listed first keeps its company attribution, and the
 * result never exceeds `maxCandidates` — the bound that keeps a poll tick from
 * fanning out across the whole board.
 */
export function mergeInteractionCandidates(
  sources: InteractionCandidate[][],
  maxCandidates: number,
): InteractionCandidate[] {
  const byIssue = new Map<string, InteractionCandidate>();
  for (const list of sources) {
    for (const candidate of list) {
      if (!candidate.issueId || !candidate.companyId) continue;
      if (byIssue.has(candidate.issueId)) continue;
      byIssue.set(candidate.issueId, candidate);
      if (byIssue.size >= maxCandidates) return [...byIssue.values()];
    }
  }
  return [...byIssue.values()];
}

const CALLBACK_PREFIXES: Array<[InteractionCallback["action"], string]> = [
  ["accept", INTERACTION_ACCEPT_PREFIX],
  ["reject", INTERACTION_REJECT_PREFIX],
  ["reject_now", INTERACTION_REJECT_NOW_PREFIX],
  ["back", INTERACTION_BACK_PREFIX],
];

const REPLY_PREFIXES: Array<[InteractionReplyCallback["action"], string]> = [
  ["reply_reject", INTERACTION_REPLY_REJECT_PREFIX],
  ["reply_comment", INTERACTION_REPLY_COMMENT_PREFIX],
  ["reply_discard", INTERACTION_REPLY_DISCARD_PREFIX],
];

/** Build the Telegram `callback_data` for a decision-card button. */
export function buildInteractionCallbackData(
  action: InteractionCallback["action"],
  interactionId: string,
): string {
  const prefix = CALLBACK_PREFIXES.find(([a]) => a === action)![1];
  return `${prefix}${interactionId}`;
}

/**
 * Parse an interaction `callback_data`, or null when it is not one of ours.
 * All prefixes are pairwise non-overlapping ("int_reject_" vs "int_rnow_" …)
 * and disjoint from the approval/escalation prefixes handled elsewhere.
 */
export function parseInteractionCallbackData(data: string): InteractionCallback | null {
  for (const [action, prefix] of CALLBACK_PREFIXES) {
    if (data.startsWith(prefix)) {
      const interactionId = data.slice(prefix.length);
      return interactionId ? { action, interactionId } : null;
    }
  }
  return null;
}

export function buildInteractionReplyCallbackData(
  action: InteractionReplyCallback["action"],
  choiceMessageId: number,
): string {
  const prefix = REPLY_PREFIXES.find(([a]) => a === action)![1];
  return `${prefix}${choiceMessageId}`;
}

export function parseInteractionReplyCallbackData(data: string): InteractionReplyCallback | null {
  for (const [action, prefix] of REPLY_PREFIXES) {
    if (data.startsWith(prefix)) {
      const choiceMessageId = Number(data.slice(prefix.length));
      return Number.isInteger(choiceMessageId) && choiceMessageId > 0 ? { action, choiceMessageId } : null;
    }
  }
  return null;
}

type InteractionStrings = {
  reasonPromptRequired: (label: string) => string;
  reasonPromptOptional: (label: string) => string;
  rejectWithoutReason: string;
  back: string;
  replyChoice: string;
  replyReject: (rejectLabel: string) => string;
  replyComment: string;
  replyDiscard: string;
  commentSent: string;
  commentNote: string;
  discarded: string;
  noActor: string;
  noLongerAvailable: string;
  alreadyResolved: string;
  reasonPrefix: string;
  by: string;
  answerReply: string;
  failed: string;
};

const STRINGS: Record<"en" | "de", InteractionStrings> = {
  en: {
    reasonPromptRequired: (l) => `✍️ ${l}\nReply to this message with your reason.`,
    reasonPromptOptional: (l) =>
      `✍️ ${l}\nReply to this message with a reason or a change request — or reject without one using the button on the card.`,
    rejectWithoutReason: "❌ Reject without reason",
    back: "↩️ Back",
    replyChoice: "What should happen with your reply?",
    replyReject: (l) => `❌ ${l} with this reason`,
    replyComment: "💬 Post as comment only",
    replyDiscard: "✖️ Discard",
    commentSent: "💬 Posted as a comment on the issue.",
    commentNote: "💬 Comment posted",
    discarded: "✖️ Discarded.",
    noActor: "No board user is configured for decisions (set issueInteractionActorUserId)",
    noLongerAvailable: "This decision is no longer available",
    alreadyResolved: "already resolved",
    reasonPrefix: "Reason",
    by: "by",
    answerReply: "Reply with a reason",
    failed: "Failed",
  },
  de: {
    reasonPromptRequired: (l) => `✍️ ${l}\nBitte auf diese Nachricht mit deiner Begründung antworten.`,
    reasonPromptOptional: (l) =>
      `✍️ ${l}\nAuf diese Nachricht mit Begründung oder Änderungswunsch antworten — oder auf der Karte „ohne Begründung“ ablehnen.`,
    rejectWithoutReason: "❌ Ohne Begründung ablehnen",
    back: "↩️ Zurück",
    replyChoice: "Was soll mit deiner Antwort passieren?",
    replyReject: (l) => `❌ ${l} mit dieser Begründung`,
    replyComment: "💬 Nur als Kommentar senden",
    replyDiscard: "✖️ Verwerfen",
    commentSent: "💬 Als Kommentar ans Issue gesendet.",
    commentNote: "💬 Kommentar gesendet",
    discarded: "✖️ Verworfen.",
    noActor: "Kein Board-User für Entscheidungen konfiguriert (issueInteractionActorUserId)",
    noLongerAvailable: "Diese Entscheidung ist nicht mehr verfügbar",
    alreadyResolved: "war bereits entschieden",
    reasonPrefix: "Begründung",
    by: "von",
    answerReply: "Bitte Begründung als Antwort schreiben",
    failed: "Fehlgeschlagen",
  },
};

export function interactionStrings(locale?: string): InteractionStrings {
  return locale?.toLowerCase().startsWith("de") ? STRINGS.de : STRINGS.en;
}

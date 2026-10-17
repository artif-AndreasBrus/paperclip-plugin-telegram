import type {
  IssueThreadInteraction,
  RequestConfirmationInteraction,
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
 */
export function isActionableInteraction(
  interaction: IssueThreadInteraction,
): interaction is RequestConfirmationInteraction {
  return interaction.kind === "request_confirmation" && interaction.status === "pending";
}

export type InteractionCallback = {
  action: "accept" | "reject";
  interactionId: string;
};

/** Build the Telegram `callback_data` for an accept/reject button. */
export function buildInteractionCallbackData(
  action: "accept" | "reject",
  interactionId: string,
): string {
  const prefix = action === "accept" ? INTERACTION_ACCEPT_PREFIX : INTERACTION_REJECT_PREFIX;
  return `${prefix}${interactionId}`;
}

/**
 * Parse an interaction `callback_data`, or null when it is not one of ours.
 * Reject is checked first so the accept prefix (a strict substring of neither)
 * cannot shadow it; both prefixes are disjoint from the approval/escalation
 * prefixes handled elsewhere.
 */
export function parseInteractionCallbackData(data: string): InteractionCallback | null {
  if (data.startsWith(INTERACTION_ACCEPT_PREFIX)) {
    const interactionId = data.slice(INTERACTION_ACCEPT_PREFIX.length);
    return interactionId ? { action: "accept", interactionId } : null;
  }
  if (data.startsWith(INTERACTION_REJECT_PREFIX)) {
    const interactionId = data.slice(INTERACTION_REJECT_PREFIX.length);
    return interactionId ? { action: "reject", interactionId } : null;
  }
  return null;
}

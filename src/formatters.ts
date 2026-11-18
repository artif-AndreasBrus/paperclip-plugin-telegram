import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type {
  RequestConfirmationInteraction,
  AskUserQuestionsInteraction,
  RequestItemVerdictsInteraction,
} from "@paperclipai/shared";
import { escapeMarkdownV2, truncateAtWord } from "./telegram-api.js";
import type { SendMessageOptions } from "./telegram-api.js";
import { AGENT_ERROR_TRUNCATE_LENGTH } from "./constants.js";
import {
  buildInteractionCallbackData,
} from "./interaction-routing.js";
import { str } from "./coerce.js";

type Payload = Record<string, unknown>;

type FormattedMessage = {
  text: string;
  options: SendMessageOptions;
};

function esc(s: string): string {
  return escapeMarkdownV2(s);
}

function bold(s: string): string {
  return `*${esc(s)}*`;
}

function code(s: string): string {
  return `\`${esc(s)}\``;
}

export type IssueLinksOpts = { baseUrl?: string; issuePrefix?: string };

function isExternalUrl(url?: string): boolean {
  return !!url && url.startsWith("https://");
}

function issueLink(identifier: string, opts?: IssueLinksOpts): string {
  if (opts?.baseUrl && opts?.issuePrefix) {
    const url = `${opts.baseUrl}/${opts.issuePrefix}/issues/${identifier}`;
    return `[${esc(identifier)}](${url})`;
  }
  return bold(identifier);
}

function issueButton(identifier: string, opts?: IssueLinksOpts): { text: string; url: string } | null {
  if (opts?.baseUrl && opts?.issuePrefix && isExternalUrl(opts.baseUrl)) {
    return { text: `Open ${identifier} ↗`, url: `${opts.baseUrl}/${opts.issuePrefix}/issues/${identifier}` };
  }
  return null;
}

function agentButton(agentId: string, label: string, publicUrl?: string): { text: string; url: string } | null {
  if (publicUrl && isExternalUrl(publicUrl)) {
    return { text: label, url: `${publicUrl}/agents/${agentId}` };
  }
  return null;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function displayAgentName(value: string): string {
  return isUuidLike(value) ? `Agent ${value.slice(0, 8)}` : value;
}

function runButton(agentId: string, runId: string | null, publicUrl?: string): { text: string; url: string } | null {
  if (publicUrl && isExternalUrl(publicUrl) && runId) {
    return { text: "View Run ↗", url: `${publicUrl}/agents/${agentId}/runs/${runId}` };
  }
  return null;
}

// Renders only when the inline error text was cut, and takes runButton's
// place in the keyboard row rather than sitting alongside it: the run
// dashboard exposes no error-anchored URL, so both buttons would point at
// the identical `/runs/:runId` page. Two labels for one URL reads as
// broken, so the more accurate label ("Full error", surfaced right below
// the truncated text it completes) wins the slot; formatAgentError falls
// back to runButton when the message wasn't truncated.
function fullErrorButton(agentId: string, runId: string | null, publicUrl?: string): { text: string; url: string } | null {
  if (publicUrl && isExternalUrl(publicUrl) && runId) {
    return { text: "Full error ↗", url: `${publicUrl}/agents/${agentId}/runs/${runId}` };
  }
  return null;
}

function classifyAgentError(errorMessage: string): string {
  if (/timed?\s*out|timeout/i.test(errorMessage)) return "Agent Timeout";
  if (/limit|rate.?limit|quota/i.test(errorMessage)) return "Agent Rate Limit";
  return "Agent Error";
}

// Issue-lifecycle notifications (created/assigned/done) are
// silent for low/medium priority issues so routine churn doesn't buzz the phone; high/critical
// priority stays loud, and unknown priority defaults to loud so we never silently swallow a
// notification we can't classify. Approvals and agent errors are always loud, unconditionally.
const SILENT_ISSUE_PRIORITIES = new Set(["low", "medium"]);

function silentForPriority(priority: string | null): boolean {
  return priority !== null && SILENT_ISSUE_PRIORITIES.has(priority.toLowerCase());
}

export function formatIssueCreated(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const identifier = str(p.identifier, event.entityId);
  const title = str(p.title, "Untitled");
  const status = p.status ? str(p.status) : null;
  const priority = p.priority ? str(p.priority) : null;
  const assigneeName = p.assigneeName ? str(p.assigneeName) : null;
  const projectName = p.projectName ? str(p.projectName) : null;

  const lines: string[] = [
    `${esc("📋")} ${bold("Issue Created")}: ${issueLink(identifier, opts)}`,
    bold(title),
  ];

  const meta: string[] = [];
  if (status) meta.push(`Status: ${code(status)}`);
  if (priority) meta.push(`Priority: ${code(priority)}`);
  if (assigneeName) meta.push(`Assignee: ${esc(assigneeName)}`);
  if (projectName) meta.push(`Project: ${esc(projectName)}`);
  if (meta.length > 0) lines.push(meta.join(" \\| "));

  if (p.description) {
    const desc = truncateAtWord(str(p.description), 200);
    lines.push(`\n${esc(">")} ${esc(desc)}`);
  }

  const button = issueButton(identifier, opts);
  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(silentForPriority(priority) ? { disableNotification: true } : {}),
      ...(button ? { inlineKeyboard: [[button]] } : {}),
    },
  };
}

export function formatIssueAssigned(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const prev = (p._previous as Payload | undefined) ?? {};
  const identifier = str(p.identifier, event.entityId);
  const title = str(p.title, "Untitled");
  const priority = p.priority ? str(p.priority) : null;
  const assigneeName = p.assigneeName ? str(p.assigneeName) : null;
  const prevAssigneeName = prev.assigneeName ? str(prev.assigneeName) : null;

  const lines: string[] = [
    `${esc("🎯")} ${bold("Issue Assigned")}: ${issueLink(identifier, opts)}`,
    bold(title),
  ];

  if (assigneeName) {
    lines.push(
      prevAssigneeName
        ? `Assignee: ${esc(prevAssigneeName)} ${esc("→")} ${esc(assigneeName)}`
        : `Assignee: ${esc(assigneeName)}`,
    );
  } else {
    lines.push(esc("Unassigned"));
  }

  const button = issueButton(identifier, opts);
  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(silentForPriority(priority) ? { disableNotification: true } : {}),
      ...(button ? { inlineKeyboard: [[button]] } : {}),
    },
  };
}

export function formatIssueDone(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const identifier = str(p.identifier, event.entityId);
  const title = str(p.title);
  const priority = p.priority ? str(p.priority) : null;
  const comment = p.comment ? str(p.comment) : null;

  const lines: string[] = [
    `${esc("✅")} ${bold("Issue Completed")}: ${issueLink(identifier, opts)}`,
    `${bold(title)} ${esc("is now done.")}`,
  ];

  if (comment) {
    const truncated = truncateAtWord(comment, 300);
    lines.push(`\n${esc(">")} ${esc(truncated)}`);
  }

  const button = issueButton(identifier, opts);
  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(silentForPriority(priority) ? { disableNotification: true } : {}),
      ...(button ? { inlineKeyboard: [[button]] } : {}),
    },
  };
}

export function formatApprovalCreated(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const approvalType = str(p.type, "unknown");
  const approvalId = str(p.approvalId, event.entityId);
  const title = str(p.title, "Approval Requested");
  const description = p.description ? str(p.description) : null;
  const agentName = p.agentName ? str(p.agentName) : null;

  const lines: string[] = [
    `${esc("🔔")} ${bold("Approval Requested")}`,
    bold(title),
  ];

  if (agentName) lines.push(`Agent: ${esc(agentName)} \\| Type: ${code(approvalType)}`);
  if (description) lines.push(`\n${esc(truncateAtWord(description, 300))}`);

  // Add linked issues if present
  const linkedIssues = Array.isArray(p.linkedIssues) ? p.linkedIssues as Array<Payload> : [];
  if (linkedIssues.length > 0) {
    lines.push(`\n${bold(`Linked Issues (${String(linkedIssues.length)})`)}`);
    for (const issue of linkedIssues.slice(0, 5)) {
      const issueId = str(issue.identifier, "?");
      const issueParts = [`${issueLink(issueId, opts)} ${esc(str(issue.title))}`];
      const issueMeta: string[] = [];
      if (issue.status) issueMeta.push(str(issue.status));
      if (issue.priority) issueMeta.push(str(issue.priority));
      if (issue.assignee) issueMeta.push(`-> ${str(issue.assignee)}`);
      if (issueMeta.length > 0) issueParts.push(`\\(${esc(issueMeta.join(" | "))}\\)`);
      lines.push(issueParts.join(" "));
    }
  }

  const keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
    [
      { text: "Approve", callback_data: `approve_${approvalId}` },
      { text: "Reject", callback_data: `reject_${approvalId}` },
    ],
  ];

  // Add deep link to the first linked issue if available
  if (linkedIssues.length > 0) {
    const firstIssueId = str(linkedIssues[0]!.identifier);
    if (firstIssueId) {
      const btn = issueButton(firstIssueId, opts);
      if (btn) keyboard.push([btn]);
    }
  }

  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      inlineKeyboard: keyboard,
    },
  };
}

export function formatAgentError(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const agentId = str(p.agentId, event.entityId);
  const rawAgentName = str(p.agentName, str(p.name, agentId));
  const agentName = displayAgentName(rawAgentName);
  const errorMessage = str(p.error, str(p.message, "Unknown error"));
  const runId = p.runId ? str(p.runId) : null;
  const companyName = p.companyName ? str(p.companyName) : null;
  const issueIdentifier = p.issueIdentifier ? str(p.issueIdentifier) : null;
  const issueTitle = p.issueTitle ? str(p.issueTitle) : null;

  const lines: string[] = [
    `${esc("❌")} ${bold(classifyAgentError(errorMessage))}`,
    `Agent: ${bold(agentName)}`,
  ];
  // The compact label hides the identifier it was derived from, and the "View Agent"
  // button only exists when a public base URL is configured. Keep the full id in a
  // metadata line so error notifications stay correlatable without one.
  if (agentName !== rawAgentName) lines.push(`Agent ID: ${code(rawAgentName)}`);
  if (companyName) lines.push(`Company: ${esc(companyName)}`);
  if (issueIdentifier) {
    lines.push(
      issueTitle
        ? `Issue: ${issueLink(issueIdentifier, opts)} ${esc("—")} ${esc(issueTitle)}`
        : `Issue: ${issueLink(issueIdentifier, opts)}`,
    );
  }
  const isTruncated = errorMessage.length > AGENT_ERROR_TRUNCATE_LENGTH;
  lines.push(`\n${code(truncateAtWord(errorMessage, AGENT_ERROR_TRUNCATE_LENGTH))}`);

  // fullErrorButton and runButton point at the same run page, so only one
  // occupies the slot — never both.
  const fullError = isTruncated ? fullErrorButton(agentId, runId, opts?.baseUrl) : null;
  const buttons = [
    fullError,
    fullError ? null : runButton(agentId, runId, opts?.baseUrl),
    issueIdentifier ? issueButton(issueIdentifier, opts) : null,
    agentButton(agentId, "View Agent ↗", opts?.baseUrl),
  ].filter((button): button is { text: string; url: string } => Boolean(button));

  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(buttons.length > 0 ? { inlineKeyboard: [buttons] } : {}),
    },
  };
}

export function formatAgentRunStarted(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const agentId = str(p.agentId, event.entityId);
  const agentName = displayAgentName(str(p.agentName, agentId));
  const runId = p.runId ? str(p.runId) : null;

  const buttons: Array<{ text: string; url: string }> = [];
  if (opts?.baseUrl && isExternalUrl(opts.baseUrl)) {
    const url = runId
      ? `${opts.baseUrl}/agents/${agentId}/runs/${runId}`
      : `${opts.baseUrl}/agents/${agentId}`;
    buttons.push({ text: "View Run ↗", url });
  }

  return {
    text: `${esc("▶️")} ${bold(agentName)} ${esc("started run")}`,
    options: {
      parseMode: "MarkdownV2",
      disableNotification: true,
      ...(buttons.length > 0 ? { inlineKeyboard: [buttons] } : {}),
    },
  };
}

export function formatAgentRunFinished(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const agentId = str(p.agentId, event.entityId);
  const agentName = displayAgentName(str(p.agentName, agentId));
  const runId = p.runId ? str(p.runId) : null;

  const buttons: Array<{ text: string; url: string }> = [];
  if (opts?.baseUrl && isExternalUrl(opts.baseUrl)) {
    const url = runId
      ? `${opts.baseUrl}/agents/${agentId}/runs/${runId}`
      : `${opts.baseUrl}/agents/${agentId}`;
    buttons.push({ text: "View Run ↗", url });
  }

  return {
    text: `${esc("✅")} ${bold(agentName)} ${esc("completed run")}`,
    options: {
      parseMode: "MarkdownV2",
      disableNotification: true,
      ...(buttons.length > 0 ? { inlineKeyboard: [buttons] } : {}),
    },
  };
}

export type InteractionIssueInfo = { identifier?: string | null; title?: string | null };

// Daily decision card (issue-thread `request_confirmation`). Unlike the
// event-based formatters above this takes the interaction object directly —
// decision cards arrive via `ctx.issues.listInteractions`, not a PluginEvent.
//
// The board user decides from Telegram, so the card carries the FULL prompt and
// details (no truncation) with the creator's Markdown rendered, not escaped
// raw. When the text exceeds one Telegram message it is split at paragraph
// boundaries into `leadingParts` (sent first) and the final card message that
// carries the buttons — so the buttons always sit under the end of the text.
//
// Two action buttons carry the interaction id in their `callback_data`
// (`int_accept_`/`int_reject_` + UUID, ~47 bytes, well under Telegram's 64);
// the callback handler recovers issue/company from the notification's stored
// `msg_` mapping. Always loud: a decision card is something a human must act on.
export type IssueInteractionMessage = FormattedMessage & {
  /** Messages to send BEFORE the button card when the text is too long for one. */
  leadingParts: string[];
};

/** Telegram's hard limit is 4096; leave headroom for the part header. */
export const INTERACTION_PART_MAX = 3800;

export function interactionCardKeyboard(
  interaction: RequestConfirmationInteraction,
  issue: InteractionIssueInfo = {},
  opts?: IssueLinksOpts,
): Array<Array<{ text: string; callback_data?: string; url?: string }>> {
  const payload = interaction.payload;
  const acceptLabel = payload.acceptLabel?.trim() || "Approve";
  const rejectLabel = payload.rejectLabel?.trim() || "Reject";
  const keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
    [
      { text: `✅ ${acceptLabel}`, callback_data: buildInteractionCallbackData("accept", interaction.id) },
      { text: `❌ ${rejectLabel}`, callback_data: buildInteractionCallbackData("reject", interaction.id) },
    ],
  ];
  const identifier = issue.identifier?.trim();
  if (identifier) {
    const btn = issueButton(identifier, opts);
    if (btn) keyboard.push([btn]);
  }
  return keyboard;
}

export function formatIssueInteraction(
  interaction: RequestConfirmationInteraction,
  issue: InteractionIssueInfo = {},
  opts?: IssueLinksOpts,
  maxPartLength: number = INTERACTION_PART_MAX,
): IssueInteractionMessage {
  const payload = interaction.payload;
  const heading = interaction.title?.trim() || "Decision needed";
  const headLine = `${esc("🗳️")} ${bold(heading)}`;

  const blocks: string[] = [];
  const identifier = issue.identifier?.trim();
  if (identifier) {
    const title = issue.title?.trim();
    blocks.push(title ? `${issueLink(identifier, opts)} ${esc(title)}` : issueLink(identifier, opts));
  }
  if (payload.prompt?.trim()) blocks.push(markdownToMarkdownV2(payload.prompt.trim()));
  const details = payload.detailsMarkdown?.trim();
  if (details) {
    for (const para of splitParagraphs(details)) blocks.push(markdownToMarkdownV2(para));
  }

  const chunks = packBlocks(blocks, maxPartLength - headLine.length - 16, maxPartLength);
  const total = chunks.length;
  const texts = chunks.map((chunk, i) => {
    const head = total > 1 ? `${headLine} ${esc(`(${i + 1}/${total})`)}` : headLine;
    return `${head}\n${chunk}`;
  });

  return {
    text: texts[texts.length - 1]!,
    leadingParts: texts.slice(0, -1),
    options: {
      parseMode: "MarkdownV2",
      inlineKeyboard: interactionCardKeyboard(interaction, issue, opts),
    },
  };
}

/** Upper bound for an attached document in Telegram (~10 messages); the rest stays in Paperclip. */
export const INTERACTION_DOCUMENT_MAX = 36_000;

/**
 * An issue document (e.g. the blog post a card asks to approve) rendered as
 * Telegram messages, sent silently right BEFORE the decision card so the card
 * and its buttons sit directly under the text. YAML front matter is dropped;
 * Markdown is rendered like the card itself. Over-long documents are cut at a
 * paragraph with a pointer to Paperclip.
 */
export function formatIssueDocumentParts(
  doc: { key: string; title?: string | null; body: string },
  issue: InteractionIssueInfo = {},
  opts?: IssueLinksOpts,
  maxPartLength: number = INTERACTION_PART_MAX,
  maxTotal: number = INTERACTION_DOCUMENT_MAX,
  truncatedNote = "… (gekürzt — vollständig in Paperclip)",
): string[] {
  const body = doc.body.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  if (!body) return [];

  const name = doc.title?.trim() || doc.key;
  const identifier = issue.identifier?.trim();
  const headLine = `${esc("📄")} ${bold(name)}${identifier ? ` ${esc("·")} ${issueLink(identifier, opts)}` : ""}`;

  const blocks: string[] = [];
  let used = 0;
  for (const para of splitParagraphs(body)) {
    if (used + para.length > maxTotal) {
      blocks.push(`_${esc(truncatedNote)}_`);
      break;
    }
    used += para.length;
    blocks.push(markdownToMarkdownV2(para));
  }

  const chunks = packBlocks(blocks, maxPartLength - headLine.length - 16, maxPartLength);
  const total = chunks.length;
  return chunks.map((chunk, i) => {
    const head = total > 1 ? `${headLine} ${esc(`(${i + 1}/${total})`)}` : headLine;
    return `${head}\n\n${chunk}`;
  });
}

/** Split Markdown into paragraphs (blank-line separated), keeping list blocks together. */
function splitParagraphs(md: string): string[] {
  return md
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Greedily pack already-escaped blocks into chunks of at most `budget` chars
 * (blank line between blocks). A single oversize block is hard-split at line
 * boundaries, then at `hardMax` as a last resort.
 */
function packBlocks(blocks: string[], budget: number, hardMax: number): string[] {
  const pieces: string[] = [];
  for (const block of blocks) {
    if (block.length <= budget) {
      pieces.push(block);
      continue;
    }
    let current = "";
    for (const line of block.split("\n")) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length <= budget) {
        current = candidate;
        continue;
      }
      if (current) pieces.push(current);
      current = line;
      while (current.length > budget) {
        // Never split inside an escape sequence ("\\x").
        let cut = Math.min(budget, hardMax);
        if (current[cut - 1] === "\\") cut -= 1;
        pieces.push(current.slice(0, cut));
        current = current.slice(cut);
      }
    }
    if (current) pieces.push(current);
  }

  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (candidate.length <= budget || !current) {
      current = candidate;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

/**
 * Render the small Markdown subset agents use in decision cards into Telegram
 * MarkdownV2: `**bold**` / `__bold__`, `*italic*` / `_italic_`, `` `code` ``,
 * fenced code blocks, `[text](https://url)`, `#` headings (bold) and `-`/`*`
 * bullets (•). Everything else is escaped, so arbitrary text can never break
 * the parse (sendMessage additionally falls back to plain text on a 400).
 */
export function markdownToMarkdownV2(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let fence: string[] = [];
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (inFence) {
        out.push("```\n" + fence.map(escapeCode).join("\n") + "\n```");
        fence = [];
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      fence.push(raw);
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(`*${renderInline(heading[1]!.replace(/\*\*/g, ""), true)}*`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (bullet) {
      const indent = bullet[1]!.length >= 2 ? "  " : "";
      out.push(`${indent}• ${renderInline(bullet[2]!)}`);
      continue;
    }
    out.push(renderInline(raw));
  }
  if (inFence && fence.length > 0) out.push("```\n" + fence.map(escapeCode).join("\n") + "\n```");
  return out.join("\n");
}

function escapeCode(s: string): string {
  return s.replace(/([`\\])/g, "\\$1");
}

function escapeUrl(s: string): string {
  return s.replace(/([)\\])/g, "\\$1");
}

/** Inline Markdown → MarkdownV2. `noBold` suppresses nested bold inside a heading. */
function renderInline(text: string, noBold = false): string {
  const re = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])|(?<![\w_])_([^_\s][^_\n]*?)_(?![\w_])/g;
  let result = "";
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    result += esc(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) result += `\`${escapeCode(m[1])}\``;
    else if (m[2] !== undefined) result += `[${renderInline(m[2], noBold)}](${escapeUrl(m[3]!)})`;
    else if (m[4] !== undefined || m[5] !== undefined) {
      const inner = renderInline((m[4] ?? m[5])!, true);
      result += noBold ? inner : `*${inner}*`;
    } else if (m[6] !== undefined || m[7] !== undefined) result += `_${renderInline((m[6] ?? m[7])!, true)}_`;
  }
  return result + esc(text.slice(last));
}

// Caps so a card with many items/questions stays well inside Telegram's
// 4096-char message limit; the deep link leads to the full list in Paperclip.
const NOTICE_MAX_ITEMS = 10;
const NOTICE_MAX_QUESTIONS = 8;
const NOTICE_MAX_OPTIONS = 6;

/**
 * Notify-only card for a pending decision the plugin cannot resolve from
 * Telegram: `ask_user_questions` and `request_item_verdicts`. `respondInteraction`
 * is accept/reject only, so there is no button that answers these — the card
 * summarizes what is pending and links out to Paperclip, where the board user
 * answers. Always loud: a human must act. Carries no resolve `callback_data`,
 * only an "Open" URL button, so the callback handler never has to touch it.
 */
export function formatIssueInteractionNotice(
  interaction: AskUserQuestionsInteraction | RequestItemVerdictsInteraction,
  issue: InteractionIssueInfo = {},
  opts?: IssueLinksOpts,
): FormattedMessage {
  const isQuestions = interaction.kind === "ask_user_questions";
  const heading =
    interaction.title?.trim() || (isQuestions ? "Questions need answering" : "Items need review");

  const lines: string[] = [`${esc("🗳️")} ${bold(heading)}`];

  const identifier = issue.identifier?.trim();
  if (identifier) {
    const title = issue.title?.trim();
    lines.push(title ? `${issueLink(identifier, opts)} ${esc(title)}` : issueLink(identifier, opts));
  }

  if (interaction.kind === "request_item_verdicts") {
    const payload = interaction.payload;
    lines.push(`\n${esc(truncateAtWord(payload.prompt, 400))}`);
    const details = payload.detailsMarkdown?.trim();
    if (details) lines.push(`\n${esc(truncateAtWord(details, 300))}`);

    const items = payload.items ?? [];
    const shown = items.slice(0, NOTICE_MAX_ITEMS);
    if (shown.length > 0) {
      lines.push("");
      for (const item of shown) lines.push(esc(`• ${item.label}`));
      if (items.length > shown.length) lines.push(esc(`…and ${items.length - shown.length} more`));
    }
  } else {
    const payload = interaction.payload;
    const title = payload.title?.trim();
    if (title) lines.push(`\n${esc(truncateAtWord(title, 300))}`);

    const questions = payload.questions ?? [];
    const shown = questions.slice(0, NOTICE_MAX_QUESTIONS);
    if (shown.length > 0) {
      lines.push("");
      for (const question of shown) {
        lines.push(esc(`• ${truncateAtWord(question.prompt, 200)}`));
        const options = (question.options ?? []).slice(0, NOTICE_MAX_OPTIONS).map((o) => o.label);
        if (options.length > 0) lines.push(`  ${esc(options.join(" / "))}`);
      }
      if (questions.length > shown.length) {
        lines.push(esc(`…and ${questions.length - shown.length} more`));
      }
    }
  }

  lines.push(`\n${esc("↗ Open in Paperclip to respond — this can't be answered from Telegram.")}`);

  const keyboard: Array<Array<{ text: string; url: string }>> = [];
  if (identifier) {
    const btn = issueButton(identifier, opts);
    if (btn) keyboard.push([btn]);
  }

  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(keyboard.length > 0 ? { inlineKeyboard: keyboard } : {}),
    },
  };
}

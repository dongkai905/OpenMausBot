// App-event automations as a person reads them: one plain sentence, one status word, what it skipped today and why.
import { clockOptions } from "@/lib/clock-time";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { AppTrigger } from "@/lib/app-triggers";
import { appProblem, appStatusParts, appWhen, skippedToday } from "@/lib/app-automations";
import type { OptionCardData } from "@/state/store";

export interface Automation {
  id: string;
  name: string;
  botId: string;
  instructions: string;
  enabled: boolean;
  appTrigger: AppTrigger;
}

/** With `bots`, an automation whose bot no longer exists is left out: it can never run, so it is never shown. */
export function automationsFrom(sources: { appTriggers: readonly AppTrigger[]; bots?: readonly { id: string }[] }): Automation[] {
  const botIds = sources.bots && new Set(sources.bots.map((bot) => bot.id));
  return sources.appTriggers
    .map((trigger) => ({
      id: trigger.id,
      name: trigger.name,
      botId: trigger.botId,
      instructions: trigger.prompt,
      enabled: trigger.enabled,
      appTrigger: trigger,
    }))
    .filter((automation) => !botIds || botIds.has(automation.botId));
}

export function automationFor(ref: { id: string }, sources: Parameters<typeof automationsFrom>[0]): Automation | null {
  return automationsFrom({
    appTriggers: sources.appTriggers.filter((trigger) => trigger.id === ref.id),
    bots: sources.bots,
  })[0] ?? null;
}

/** The automation a chat card made: a create that applied on its own. Its id never changes, so the card follows it. */
export function cardAutomation(card: OptionCardData): { id: string } | null {
  if (!card.autoApplied || card.answered !== "allow" || card.held) return null;
  const app = card.appTriggerRequest;
  if (app?.operation.action === "create" && app.resultId) return { id: app.resultId };
  return null;
}

// ---- Times: "today 9:02 AM", "yesterday", "Mon 9:00 AM" ----

const DAY_MS = 24 * 60 * 60_000;
const startOfDay = (at: number) => { const day = new Date(at); day.setHours(0, 0, 0, 0); return day.getTime(); };
const locale = () => activeLocale();

/** 9 AM on the hour, 9:30 AM otherwise, in the person's language. */
function clock(at: number, dropZeroMinutes = false): string {
  const date = new Date(at);
  return date.toLocaleTimeString(locale(), clockOptions(locale(), dropZeroMinutes && date.getMinutes() === 0));
}

/** When something last happened: "today 9:02 AM", "yesterday", "Mon 9:00 AM", or "Oct 3". */
export function lastWhen(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days <= 0) return t("automations.time.today", { time: clock(at) });
  if (days === 1) return t("automations.time.yesterday");
  if (days < 7) return t("automations.time.dayAt", { day: new Date(at).toLocaleDateString(locale(), { weekday: "short" }), time: clock(at) });
  return new Date(at).toLocaleDateString(locale(), { month: "short", day: "numeric" });
}

export const capital = (text: string) => text.charAt(0).toLocaleUpperCase(locale()) + text.slice(1);

// ---- The sentence ----

const IRREGULAR: Record<string, string> = { have: "has", do: "does", go: "goes", be: "is" };
const NOT_A_VERB = new Set(["if", "when", "whenever", "every", "each", "please", "the", "a", "an", "you", "i", "we", "my", "our", "your", "this", "that", "on", "at", "for", "after", "before"]);
const PHRASE_CHARS = 60;
const COMMON_VERBS = "add|archive|book|check|create|draft|email|file|flag|forward|label|list|message|move|notify|open|ping|post|reply|report|review|save|schedule|send|share|summarize|tell|update|write";

function thirdPerson(verb: string): string {
  const lower = verb.toLowerCase();
  if (IRREGULAR[lower]) return IRREGULAR[lower]!;
  if (/(s|sh|ch|x|z|o)$/.test(lower)) return `${lower}es`;
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

/** "SMS the team", "CRM: …", "HubSpot deals…": a capital after a word's first letter makes it a name, never a verb, and
 * it keeps its case ("e2E:…" and "smses the team" otherwise). */
const keepsCase = (word: string) => /\p{Lu}/u.test(word.slice(1));

/** What the bot does, as a short phrase: the first clause of its instructions, addressed to the person. */
/** Words a bot may leave at the end of its instructions that a person never says: "…a reply to the email in the event data". */
const TECHNICAL_TAIL = /\s+(?:in|from|of|inside)\s+(?:the\s+)?(?:(?:incoming|webhook|trigger|app)\s+)?(?:event(?:'s)?(?:\s+(?:data|payload|body))?|payload|webhook(?:\s+(?:data|body|payload|call))?|trigger(?:\s+(?:data|payload))?)$/i;

export function doesPhrase(instructions: string, english = activeLocale().startsWith("en")): string {
  let clause = instructions.replace(/^\s*please\s+/i, "").split(/[.:;!?\n]|\s[—–-]\s/)[0]?.trim().replace(TECHNICAL_TAIL, "") ?? "";
  if (!clause) return t("automations.does.default");
  if (english) {
    clause = clause.replace(/\bme\b/gi, "you").replace(/\bmy\b/gi, "your").replace(/\bmine\b/gi, "yours").replace(/\bI\b/g, "you");
    const [first = "", ...rest] = clause.split(/\s+/);
    clause = keepsCase(first) ? clause : /^[A-Za-z]+$/.test(first) && !NOT_A_VERB.has(first.toLowerCase())
      // "Summarize the inbox and post the top three" → "summarizes the inbox and posts the top three".
      ? [thirdPerson(first), ...rest].join(" ").replace(new RegExp(`\\b(and|then) (${COMMON_VERBS})\\b`, "g"), (_match, joiner: string, verb: string) => `${joiner} ${thirdPerson(verb)}`)
      : clause.charAt(0).toLowerCase() + clause.slice(1);
  } else if (!keepsCase(clause.split(/\s/)[0] ?? "")) {
    clause = clause.charAt(0).toLocaleLowerCase(locale()) + clause.slice(1);
  }
  if (clause.length <= PHRASE_CHARS) return clause;
  const cut = clause.slice(0, PHRASE_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : PHRASE_CHARS).trimEnd()}…`;
}

/** "When your sales form sends something, Scout drafts…". */
export function automationSentence(automation: Pick<Automation, "instructions" | "appTrigger">, botName: string): string {
  const does = doesPhrase(automation.instructions);
  return t("automations.sentence.appEvent", { when: appWhen(automation.appTrigger), bot: botName, does });
}

/** Under an automation's name: what it watches and what the bot does. */
export function automationSubtitle(automation: Automation, botName: string): string {
  return automationSentence(automation, botName);
}

// ---- Status: Working / Paused / Needs you ----

export type AutomationFix = "edit" | "reconnect";
export interface AutomationStatus {
  /** Working: the automation watches its app. Paused: it is switched off. Needs you: the app must be fixed first. */
  state: "working" | "paused" | "needs-you";
  /** Needs you: one plain sentence, and the one button that fixes it. */
  reason?: string;
  fix?: AutomationFix;
}

export function automationStatus(automation: Pick<Automation, "enabled" | "appTrigger">): AutomationStatus {
  if (!automation.enabled) return { state: "paused" };
  const app = appProblem(automation.appTrigger);
  if (app) return { state: "needs-you", ...app };
  return { state: "working" };
}

export const STATUS_WORD: Record<AutomationStatus["state"], LocaleKey> = {
  working: "automations.status.working", paused: "automations.status.paused", "needs-you": "automations.status.needsYou",
};

const RANK = { "needs-you": 0, working: 1, paused: 2 } as const;

/** Needs you first, then Working, then Paused; within each, by name. */
export function orderAutomations<T extends Automation>(automations: readonly T[]): T[] {
  return automations
    .map((automation) => ({ automation, rank: RANK[automationStatus(automation).state] }))
    .sort((left, right) => left.rank - right.rank
      || left.automation.name.localeCompare(right.automation.name))
    .map(({ automation }) => automation);
}

/** The grey line under a sentence: how it is checked, what it skipped today, and whether it waits for its first event. */
export function statusLine(automation: Automation, now = Date.now()): string {
  const status = automationStatus(automation);
  const parts = [t(STATUS_WORD[status.state])];
  parts.push(...appStatusParts(automation.appTrigger, Boolean(automation.appTrigger.lastRunId)));
  const skipped = skippedToday(automation.appTrigger, now);
  if (skipped) parts.push(skipped);
  return parts.join(" · ");
}

export const AUTOMATION_FIX_LABEL: Record<AutomationFix, LocaleKey> = {
  edit: "automations.fix.edit",
  reconnect: "automations.fix.reconnect",
};

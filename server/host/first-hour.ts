// A new personal Cloud's first hour, run by its Chief in its own chat, with no setup screen: a greeting by name and one
// question; the morning brief said once; the phone offered; and on day two a recap of what was really done. Each step
// happens once, kept with its time in first-hour.json, which the health report carries to the Admin.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { BotRecord, Message, Store } from "../store.ts";
import { writeFileAtomic } from "../atomic.ts";
import { createAgentCard } from "../chat-widgets.ts";
import { localDate, validZone } from "./check-plan.ts";
import { firstHourWords, type FirstHourWords } from "./first-hour-words.ts";
import { anyValue, minutesSaved, type ValueLedger, type ValueTally } from "./value-ledger.ts";

const SECOND = 1_000;
const HOUR = 60 * SECOND;
export const FIRST_HOUR_FILE = "first-hour.json";
/** The morning brief's time on a Cloud that began with its first hour, in the person's own zone. */
export const MORNING = "08:00";
/** The person is here and has not written: the hour's own moment comes anyway. */
export const UNASKED_MS = 90 * SECOND;
/** The Chief knows it is in the person's first day for this long. */
const FIRST_DAY_MS = 24 * HOUR;
const RECAP_AFTER_MS = 20 * HOUR;
const TICK_MS = 15 * SECOND;
/** A turn's chat is still busy as the turn ends: the next step is tried again this soon. */
const SOON_MS = SECOND;
const ROLE_ADDRESSES = new Set(["admin", "billing", "careers", "contact", "enquiries", "finance", "hello", "help", "hi", "hr", "info", "inquiries", "jobs", "mail",
  "marketing", "me", "no", "noreply", "office", "owner", "sales", "support", "team", "test", "user"]);

const at = z.number().finite().nonnegative();
const id = z.string().min(1).max(512);
const stateSchema = z.object({
  version: z.literal(1),
  startedAt: at,
  greeting: z.object({ threadId: id, messageId: id }).optional(),
  seenAt: at.optional(),
  firstMessageAt: at.optional(),
  briefOnAt: at.optional(),
  phoneOfferedAt: at.optional(),
  phonePairedAt: at.optional(),
  firstPushAt: at.optional(),
  firstBriefAt: at.optional(),
  recapAt: at.optional(),
  recapQuiet: z.boolean().optional(),
  /** The connected apps this Cloud had, before the catalogue was removed. They are accepted and ignored, so a
   * first-hour file written before the removal still loads instead of being refused whole. */
  firstAppAt: at.optional(),
  apps: z.array(z.string()).optional(),
}).transform((state) => {
  const { firstAppAt: _firstAppAt, apps: _apps, ...kept } = state;
  return kept;
});
type FirstHourState = z.infer<typeof stateSchema>;

/** The milestones as times since the Cloud's first boot, for the Admin to set beside the trial's outcome. Times only. */
export interface FirstHourReport {
  startedAt: number;
  ms: Partial<Record<"seen" | "firstMessage" | "briefOn" | "phoneOffered" | "phonePaired" | "recap", number>>;
}

export interface FirstHourDeps {
  store: Pick<Store, "bot" | "messagesFor" | "activePath" | "appendMessage" | "patchMessage" | "patchTask" | "patchBot" | "taskByThread" | "groupByThread">;
  dataDir: string;
  now?: () => number;
  /** The Chief the first hour belongs to: the place's MausBot, or its main Chief. */
  chief(): BotRecord | null;
  mainThread(botId: string): string | undefined;
  threadBusy(botId: string, threadId: string): boolean;
  /** What the person is called and signed in with, as far as this Cloud knows. */
  person(): { name?: string; email?: string };
  language(): string | undefined;
  timeZone(): string | undefined;
  /** The Chief's brief is on. */
  briefOn(): boolean;
  /** The brief is made now if it was not yet. */
  ensureBrief(): void;
  phones(): number;
  notify(bot: BotRecord, threadId: string, body: string): void;
  /** A line the server wrote: the next turn reads it. */
  wrote(bot: BotRecord, threadId: string): void;
  /** The Cloud's welcome steps are done: the Chief's chat is where it opens. */
  welcomeDone(): void;
  ledger: Pick<ValueLedger, "totals">;
}

/** A first name to greet with: the profile's first word, else an address like sam.lee@ or sam@, never a role address or a
 * run-together one. */
export function firstName(person: { name?: string; email?: string }): string | undefined {
  const named = person.name?.trim().split(/\s+/)[0];
  if (named) return named.slice(0, 40);
  const local = person.email?.split("@")[0]?.toLowerCase();
  const first = local?.split(/[._-]+/)[0];
  if (!local || !first || !/^\p{L}{2,20}$/u.test(first) || ROLE_ADDRESSES.has(first)) return undefined;
  if (!/[._-]/.test(local) && first.length > 8) return undefined;
  return first[0]!.toUpperCase() + first.slice(1);
}

export function greetingMessage(bot: Pick<BotRecord, "name">, person: { name?: string; email?: string }, language: string | undefined): Omit<Message, "id" | "at"> {
  return { role: "bot", kind: "text", text: firstHourWords(language).greeting(firstName(person), bot.name) };
}

const localMinutes = (ms: number, zone: string | undefined): number => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: validZone(zone) ?? "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const part = (type: "hour" | "minute") => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  return part("hour") * 60 + part("minute");
};
export const clockMinutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

export function createFirstHour(deps: FirstHourDeps) {
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, FIRST_HOUR_FILE);
  let state: FirstHourState | null = null;
  try {
    if (existsSync(file)) {
      const parsed = stateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) state = parsed.data;
      else console.warn(`first hour: ${file} is not a first-hour file; it stays off`);
    }
  } catch {
    console.warn(`first hour: ${file} is unreadable; it stays off`);
  }
  const save = (): void => {
    if (!state) return;
    try {
      writeFileAtomic(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`first hour: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const mark = (patch: Partial<FirstHourState>): void => {
    if (!state) return;
    state = { ...state, ...patch };
    save();
  };
  const words = (): FirstHourWords => firstHourWords(deps.language());
  const home = (): { bot: BotRecord; threadId: string } | null => {
    const bot = deps.chief();
    const threadId = bot ? deps.mainThread(bot.id) : undefined;
    return bot && threadId ? { bot, threadId } : null;
  };
  const said = (threadId: string, from: number): boolean =>
    deps.store.messagesFor(threadId).some((message) => message.role === "user" && message.kind === "text" && message.at >= from);
  /** The person's newest message on the shown branch has no answer from a bot turn yet (text or a rich reply such as a
   * widget): a server line now would read as that answer. Server-written lines (no turnId) are not answers. */
  const personUnanswered = (threadId: string): boolean =>
    deps.store.activePath(threadId).findLast((message) =>
      message.role === "user" ? message.kind === "text" : Boolean(message.turnId) && message.kind !== "activity" && message.kind !== "digest" && message.kind !== "compaction",
    )?.role === "user";
  const answered = (threadId: string, from: number): boolean =>
    deps.store.messagesFor(threadId).some((message) => message.role === "bot" && message.kind === "text" && message.at >= from);
  const soon = (step: () => Promise<void>): void => { setTimeout(() => void step(), SOON_MS).unref?.(); };

  /** One line from the Chief in its chat, unread, read by its next turn. */
  function say(bot: BotRecord, threadId: string, text: string): Message {
    const message = deps.store.appendMessage(threadId, { role: "bot", kind: "text", text });
    deps.store.patchTask(bot.id, threadId, { unread: true });
    deps.wrote(bot, threadId);
    return message;
  }

  let unaskedTimer: ReturnType<typeof setTimeout> | null = null;
  /** The person is here and has not written: the hour's own moment comes anyway. */
  let unasked = false;

  /** The greeting in the person's language and with their name, while it is still the last thing in the chat. */
  function refreshGreeting(): void {
    const greeting = state?.greeting;
    const bot = deps.chief();
    if (!greeting || !bot) return;
    const rows = deps.store.messagesFor(greeting.threadId);
    if (rows.at(-1)?.id !== greeting.messageId) return;
    const text = greetingMessage(bot, deps.person(), deps.language()).text!;
    if (rows.at(-1)!.text !== text) deps.store.patchMessage(greeting.threadId, greeting.messageId, { text });
  }

  /** The hour's own moment: the brief said once, then the phone offered, each once and only in a quiet chat. */
  async function afterGreeting(): Promise<void> {
    if (!state) return;
    const place = home();
    if (!place || deps.threadBusy(place.bot.id, place.threadId)) return;
    if (!state.briefOnAt) {
      if (!deps.briefOn()) deps.ensureBrief();
      if (deps.briefOn()) {
        say(place.bot, place.threadId, words().briefOn);
        mark({ briefOnAt: now() });
      }
    }
    if (!state.phoneOfferedAt) {
      if (deps.phones() > 0) mark({ phoneOfferedAt: now(), phonePairedAt: state.phonePairedAt ?? now() });
      else if (offerPhone(place.bot, place.threadId)) mark({ phoneOfferedAt: now() });
    }
  }

  /** The moment is due once the person is here: their answer to the greeting, or their quiet presence. */
  function momentDue(): boolean {
    if (!state) return false;
    if (unasked) return true;
    const place = home();
    return Boolean(state.firstMessageAt && place && answered(place.threadId, state.firstMessageAt));
  }

  function offerPhone(bot: BotRecord, threadId: string): boolean {
    const w = words();
    const widget = {
      type: "Card", id: "root", title: w.phoneTitle,
      children: [
        { type: "Text", value: w.phoneBody },
        { type: "Row", gap: 2, children: [{ type: "Button", label: w.phoneButton, style: "primary", iconStart: "phone", onClickAction: { type: "open_phone_pairing" } }] },
      ],
    };
    const posted = createAgentCard({ store: deps.store as Parameters<typeof createAgentCard>[0]["store"], bot, threadId, input: { tool: "show_widget", widget }, serverCard: true });
    if (!posted.ok) {
      console.warn(`first hour: the phone card was refused: ${posted.error}`);
      return false;
    }
    deps.store.patchTask(bot.id, threadId, { unread: true });
    deps.wrote(bot, threadId);
    return true;
  }

  /** A phone is paired: it is a milestone, and the first push it gets is the first brief. */
  function phonePaired(): void {
    if (!state || state.phonePairedAt) return;
    mark({ phonePairedAt: now() });
  }

  function tally(): ValueTally {
    return { ...deps.ledger.totals(), routines: 0 };
  }

  /** What was done, in the person's words, or undefined when nothing was. */
  function doneLine(counts: Partial<ValueTally>, w: FirstHourWords): string | undefined {
    const items = [
      counts.sorted ? w.sorted(counts.sorted) : "",
      counts.drafted ? w.drafted(counts.drafted) : "",
      counts.prepped ? w.prepped(counts.prepped) : "",
      counts.routines ? w.routines(counts.routines) : "",
    ].filter(Boolean);
    return items.length ? w.list(items) : undefined;
  }

  /** Day two, once its morning has come: what the Chief really did so far, and the time it gave back. */
  function recap(): void {
    if (!state || state.recapAt) return;
    const at = now(), zone = deps.timeZone();
    if (at - state.startedAt < RECAP_AFTER_MS || localDate(at, zone) === localDate(state.startedAt, zone) || localMinutes(at, zone) < clockMinutes(MORNING)) return;
    const place = home();
    if (!place || deps.threadBusy(place.bot.id, place.threadId) || personUnanswered(place.threadId)) return;
    const counts = tally();
    if (!anyValue(counts)) {
      mark({ recapAt: at, recapQuiet: true });
      return;
    }
    const w = words();
    say(place.bot, place.threadId, w.recap(doneLine(counts, w)!, w.time(minutesSaved(counts))));
    mark({ recapAt: at });
  }

  function tick(): void {
    if (!state) return;
    if (!state.phonePairedAt && deps.phones() > 0) phonePaired();
    if ((!state.briefOnAt || !state.phoneOfferedAt) && momentDue()) void afterGreeting();
    recap();
  }

  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    active: (): boolean => state !== null,
    /** On a new personal Cloud's first boot, once its Chief exists: the first hour begins, and never again. */
    begin(): void {
      if (state || existsSync(file)) return;
      const place = home();
      const first = place ? deps.store.messagesFor(place.threadId).find((message) => message.role === "bot") : undefined;
      state = { version: 1, startedAt: now(), ...(place && first ? { greeting: { threadId: place.threadId, messageId: first.id } } : {}) };
      save();
      deps.welcomeDone();
      if (place) {
        deps.store.patchBot(place.bot.id, { welcomed: true });
        deps.wrote(place.bot, place.threadId);
      }
    },
    morningAt: (): string | undefined => (state ? MORNING : undefined),
    /** The person opened the app: their name and language reach the greeting, and the hour's moment comes even if they
     * do not write. */
    arrived(): void {
      if (!state) return;
      if (!state.seenAt) mark({ seenAt: now() });
      refreshGreeting();
      if (unaskedTimer || (state.briefOnAt && state.phoneOfferedAt)) return;
      unaskedTimer = setTimeout(() => {
        unaskedTimer = null;
        if (!state || state.firstMessageAt) return;
        unasked = true;
        void afterGreeting();
      }, UNASKED_MS);
      unaskedTimer.unref?.();
    },
    /** A line was written anywhere: the person's first one is a milestone. */
    message(_threadId: string, message: Message): void {
      if (state && !state.firstMessageAt && message.role === "user" && message.kind === "text" && !message.peerAsk) mark({ firstMessageAt: message.at });
    },
    /** A turn ended. The Chief's first reply brings the hour's moment; the rest of the chat carries on. */
    turnCompleted(threadId: string, ok: boolean): void {
      const place = home();
      if (!state || !place || threadId !== place.threadId) return;
      if (state.briefOnAt && state.phoneOfferedAt) return;
      if (ok && state.firstMessageAt && said(threadId, state.startedAt)) soon(afterGreeting);
    },
    /** The push for the morning brief: the very first says it is the first. */
    morningPush(summary: string): string {
      if (!state || state.firstBriefAt) return summary;
      mark({ firstBriefAt: now(), ...(state.phonePairedAt && !state.firstPushAt ? { firstPushAt: now() } : {}) });
      return words().firstBriefReady;
    },
    /** The morning brief's first line: what was done while the person was away, from the counts kept as it happened. */
    overnight(counts: Partial<ValueTally>): string | undefined {
      if (!state) return undefined;
      const w = words();
      const done = doneLine(counts, w);
      return done ? w.overnight(done) : undefined;
    },
    /** The first day's words for the Chief in its own chat. */
    prompt(botId: string, threadId: string): string {
      const place = home();
      if (!state || !place || place.bot.id !== botId || place.threadId !== threadId || now() - state.startedAt > FIRST_DAY_MS) return "";
      const name = firstName(deps.person());
      return [
        ` This is ${name ? `${name}'s` : "the person's"} first day with you on their new Cloud. You greeted them and asked one question: what they want off their plate. Treat the answer as your first job: say in a line or two how you'll take it on, and do the first part now when you can. Keep replies short and concrete.`,
        `Their morning brief is on: every morning at ${MORNING.replace(/^0/, "")} their time you send a brief of what needs you.`,
        "Anything that would send, accept, decline or delete waits for them: write drafts and ask first.",
      ].join(" ");
    },
    health(): FirstHourReport | undefined {
      if (!state) return undefined;
      const s = state;
      const since = (time: number | undefined) => (time === undefined ? undefined : Math.max(0, time - s.startedAt));
      const ms: FirstHourReport["ms"] = {};
      const times = { seen: s.seenAt, firstMessage: s.firstMessageAt, briefOn: s.briefOnAt, phoneOffered: s.phoneOfferedAt, phonePaired: s.phonePairedAt, recap: s.recapAt };
      for (const [key, time] of Object.entries(times) as Array<[keyof FirstHourReport["ms"], number | undefined]>) {
        const value = since(time);
        if (value !== undefined) ms[key] = value;
      }
      return { startedAt: s.startedAt, ms };
    },
    tally,
    tick,
    start(): void {
      if (timer || !state) return;
      timer = setInterval(tick, TICK_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      if (unaskedTimer) clearTimeout(unaskedTimer);
      timer = null;
      unaskedTimer = null;
    },
  };
}

export type FirstHour = ReturnType<typeof createFirstHour>;

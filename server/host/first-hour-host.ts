// Wires a new Cloud's first hour into the server (server/host/README.md): the counts every personal Cloud keeps, the
// hooks the brief calls before the first hour exists, and the first hour itself once its Chief and services are up.
import { CLOUD_WELCOME_DONE } from "../../shared/cloud-hints.ts";
import type { Notification } from "../../shared/notification.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { AppConfig } from "../config.ts";
import type { BotRecord, Store } from "../store.ts";
import { createFirstHour, type FirstHour } from "./first-hour.ts";
import { proactiveOwner } from "./proactive-owner.ts";
import { createValueLedger, valueReport, type ValueKind } from "./value-ledger.ts";

/** Made before the proactive Chief, on a personal Cloud: the first hour attaches to it later. */
export function createFirstHourHooks(options: { dataDir: string; personal: boolean }) {
  const ledger = options.personal ? createValueLedger({ dataDir: options.dataDir }) : null;
  let current: FirstHour | null = null;
  return {
    ledger,
    /** For createProactive: the counts and the morning brief. */
    proactive: {
      counted: (kind: ValueKind, count: number) => ledger?.add(kind, count),
      morning: {
        at: () => current?.morningAt(),
        push: (summary: string) => current?.morningPush(summary) ?? summary,
        overnight: (since: number) => (ledger ? current?.overnight(ledger.since(since)) : undefined),
      },
    },
    attach(firstHour: FirstHour): void { current = firstHour; },
    /** The first day's words for the Chief's own chat, or nothing. */
    prompt: (botId: string, threadId: string): string => current?.prompt(botId, threadId) ?? "",
    arrived: (): void => current?.arrived(),
    health: () => ({
      ...(current?.health() ? { firstHour: current.health() } : {}),
      ...(ledger ? { value: valueReport(current?.tally() ?? { ...ledger.totals(), routines: 0 }) } : {}),
    }),
  };
}

export type FirstHourHooks = ReturnType<typeof createFirstHourHooks>;

export interface FirstHourHostDeps {
  hooks: FirstHourHooks;
  /** This boot made the place: a new personal Cloud, whose first hour begins now. */
  fresh: boolean;
  store: Store;
  bus: { subscribe(listener: (event: RuntimeEvent) => void): unknown };
  cfg: AppConfig;
  dataDir: string;
  /** The brief's own words: the language it reads in and the zone it writes in. */
  brief: { language(): string | undefined; timeZone(): string | undefined };
  /** The brief is on: the proactive bot's briefing routine. */
  briefOn(): boolean;
  ensureBrief(): void;
  sessions: { list(): ReadonlyArray<{ owner?: string; email?: string; scopes: readonly string[] }> };
  phones(): number;
  mainThread(botId: string): string | undefined;
  threadBusy(botId: string, threadId: string): boolean;
  notify(notification: Notification | null): void;
  wrote(bot: BotRecord, threadId: string): void;
  welcomeDone(): void;
  /** An event from a turn that no longer counts (a replaced or stopped one). */
  stale(event: RuntimeEvent): boolean;
}

/** Null where there is no first hour: anything but a personal Cloud, or one made before it existed. */
export function startFirstHour(deps: FirstHourHostDeps): FirstHour | null {
  if (!deps.hooks.ledger) return null;
  const { store, cfg } = deps;
  const firstHour = createFirstHour({
    store, dataDir: deps.dataDir,
    chief: () => proactiveOwner(store),
    mainThread: deps.mainThread, threadBusy: deps.threadBusy,
    person: () => {
      const name = cfg.profile?.name?.trim();
      const email = deps.sessions.list().find((session) => session.scopes.includes("admin") && session.owner)?.owner;
      return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
    },
    language: () => deps.brief.language(),
    timeZone: () => deps.brief.timeZone(),
    briefOn: deps.briefOn,
    ensureBrief: deps.ensureBrief,
    phones: deps.phones,
    notify: (bot, threadId, body) => deps.notify(bot.notifications === false ? null : { kind: "brief", botId: bot.id, botName: bot.name, threadId, title: bot.name, body, ...(bot.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}) }),
    wrote: deps.wrote,
    welcomeDone: deps.welcomeDone,
    ledger: deps.hooks.ledger,
  });
  if (deps.fresh) firstHour.begin();
  if (!firstHour.active()) return null;
  deps.hooks.attach(firstHour);
  store.onChange((change) => {
    if (change.type === "message") firstHour.message(change.threadId, change.message);
  });
  deps.bus.subscribe((event) => {
    if (event.type === "turn.completed" && !deps.stale(event)) firstHour.turnCompleted(event.threadId, event.ok);
  });
  firstHour.start();
  return firstHour;
}

/** The config patch that ends a new Cloud's welcome steps: it opens on its Chief's chat. */
export function welcomeDonePatch(onboarding: AppConfig["onboarding"]): { onboarding: { hintsSeen: string[] } } {
  return { onboarding: { hintsSeen: [...new Set([...(onboarding?.hintsSeen ?? []), CLOUD_WELCOME_DONE])] } };
}

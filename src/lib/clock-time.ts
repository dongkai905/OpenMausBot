import { activeLocale, intlLocale, t } from "@/lib/i18n";

const twentyFourHour = new Map<string, boolean>();

export const namesLocale = (): string => (activeLocale() === "en" ? "en-US" : intlLocale());

export function clockOptions(locale: string, wholeHour = false): Intl.DateTimeFormatOptions {
  if (activeLocale() === "en") return wholeHour ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" };
  if (!twentyFourHour.has(locale)) {
    const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
    twentyFourHour.set(locale, cycle === "h23" || cycle === "h24");
  }
  if (twentyFourHour.get(locale)) return { hour: "2-digit", minute: "2-digit" };
  return wholeHour ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" };
}

let timeFormat: { locale: string; clock: Intl.DateTimeFormat } | undefined;

export function formatTime(at: number) {
  const date = new Date(at);
  // toLocaleTimeString's output, where Intl.DateTimeFormat.format would throw
  if (Number.isNaN(date.getTime())) return t("time.invalid");
  const locale = intlLocale();
  if (timeFormat?.locale !== locale) timeFormat = { locale, clock: new Intl.DateTimeFormat(locale, clockOptions(locale)) };
  return timeFormat.clock.format(date);
}

/** The time of day when it happened today, the day and date when it did not. */
export function whenLabel(at: number): string {
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? formatTime(at) : date.toLocaleDateString(intlLocale(), { month: "short", day: "numeric" });
}

/** How long ago something happened, in the reader's language. */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return t("remote.time.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("remote.time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { count: hours });
  const days = Math.round(hours / 24);
  if (days === 1) return t("time.yesterday");
  if (days < 7) return t("time.daysAgo", { count: days });
  return new Date(at).toLocaleDateString(intlLocale(), { month: "short", day: "numeric" });
}

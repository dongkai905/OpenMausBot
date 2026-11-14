import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";

import type { AppTrigger } from "@/lib/app-triggers";
import { automationSentence, automationsFrom, automationStatus, doesPhrase, lastWhen, orderAutomations, statusLine } from "./automations";

const NOW = new Date(2026, 9, 17, 12, 0).getTime(); // Saturday Oct 17 2026, noon local
const at = (days: number, hours: number, minutes = 0) => { const day = new Date(NOW); day.setDate(day.getDate() + days); day.setHours(hours, minutes, 0, 0); return day.getTime(); };
const trigger = (overrides: Partial<AppTrigger> = {}): AppTrigger => ({
  id: "acme", name: "Acme replies", prompt: "Draft a short follow-up email for the lead.", botId: "scout", runOn: "maus", enabled: true,
  app: "gmail", appName: "Gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", eventName: "New Gmail message", delivery: "poll", accountId: "ca_1",
  config: {}, filter: { from: "Acme" }, remote: { triggerId: "ti_1", state: "active" }, received: 0, filtered: 0, createdAt: 0, updatedAt: 0, ...overrides,
});
const automation = (overrides: Partial<AppTrigger> = {}) => automationsFrom({ appTriggers: [trigger(overrides)] })[0]!;

describe("the plain sentence", () => {
  it("says when, who and what for an app event, turning the instructions into a short phrase addressed to the person", () => {
    expect(automationSentence(automation(), "Scout")).toBe("When you get an email from Acme, Scout drafts a short follow-up email for the lead");
  });

  it("shortens long instructions at a word", () => {
    expect(doesPhrase("Check every open support ticket across all of the shared inboxes and reply to the urgent ones first")).toMatch(/^checks every open support ticket across all of the shared…$/);
    expect(doesPhrase("Reply to each new lead")).toBe("replies to each new lead");
    expect(doesPhrase("Watch the build")).toBe("watches the build");
    expect(doesPhrase("Summarize the inbox and post the three priorities")).toBe("summarizes the inbox and posts the three priorities");
  });

  it("keeps a first word that is a name or an acronym as it is: no lowercase letter put in, no verb made of it", () => {
    expect(doesPhrase("SMS the team when a deal closes")).toBe("SMS the team when a deal closes");
    expect(doesPhrase("HubSpot deals over $10k go to Ana")).toBe("HubSpot deals over $10k go to Ana");
    expect(doesPhrase("PDF des factures à envoyer", false)).toBe("PDF des factures à envoyer");
    expect(doesPhrase("Envoyer le résumé", false)).toBe("envoyer le résumé");
    expect(doesPhrase("If it is urgent, call me")).toBe("if it is urgent, call you");
  });
});

describe("times in plain words", () => {
  it("says today, yesterday, a short weekday, or a date for what happened", () => {
    expect(lastWhen(at(0, 9, 2), NOW)).toBe("today 9:02 AM");
    expect(lastWhen(at(-1, 9), NOW)).toBe("yesterday");
    expect(lastWhen(at(-3, 9), NOW)).toBe("Wed 9:00 AM");
    expect(lastWhen(at(-20, 9), NOW)).toBe("Sep 27");
  });
  describe("in pt-BR", () => {
    afterEach(() => { setLocale("en"); });
    it("writes a 24-hour clock with two-digit hours and the minutes, and “às” before a weekday's time", () => {
      setLocale("pt-br");
      expect(lastWhen(at(0, 8, 30), NOW)).toBe("hoje às 08:30");
    });
  });
});

describe("status: Working, Paused, Needs you", () => {
  it("is Working while the app answers, and Paused when it is switched off", () => {
    expect(automationStatus(automation()).state).toBe("working");
    expect(automationStatus(automation({ enabled: false })).state).toBe("paused");
  });

  it("needs the person when the app connection expired, with Reconnect as the fix", () => {
    expect(automationStatus(automation({ problem: { kind: "reconnect", at: NOW } }))).toEqual({ state: "needs-you", reason: "Gmail needs to be reconnected.", fix: "reconnect" });
    expect(automationStatus(automation({ problem: { kind: "error", text: "bad channel", at: NOW } }))).toMatchObject({ state: "needs-you", fix: "edit" });
  });

  it("says what it is doing under the sentence", () => {
    expect(statusLine(automation(), NOW)).toBe("On · checks every 15 minutes · waiting for the first email");
    expect(statusLine(automation({ delivery: "instant", event: "SLACK_X" }), NOW)).toBe("On · waiting for the first one");
  });
});

describe("the list", () => {
  it("leaves out an automation whose bot no longer exists", () => {
    const sources = { appTriggers: [trigger(), trigger({ id: "second", botId: "second-bot" })] };
    expect(automationsFrom(sources).map((item) => item.id)).toEqual(["acme", "second"]);
    expect(automationsFrom({ ...sources, bots: [{ id: "scout" }] }).map((item) => item.id)).toEqual(["acme"]);
  });

  it("lists Needs you first, then Working, then Paused", () => {
    const listed = orderAutomations([
      automation({ id: "paused", name: "P", enabled: false }),
      automation({ id: "working", name: "W" }),
      automation({ id: "trouble", name: "T", problem: { kind: "reconnect", at: NOW } }),
    ]);
    expect(listed.map((item) => item.id)).toEqual(["trouble", "working", "paused"]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { NeedsYouItem } from "../../shared/today.ts";
import { Store, type Message } from "../store.ts";
import { AWAY_MS, createBrief } from "./brief.ts";
import { briefCard } from "./brief-cards.ts";
import { ENGLISH_BRIEF } from "./brief-words.ts";

const MINUTE = 60_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });


function setup(options: { hosted?: boolean; needsYou?: NeedsYouItem[]; language?: string; ideas?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-brief-"));
  dirs.push(dir);
  let now = Date.parse("2026-10-22T08:00:00Z");
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const chief = store.createBot({ name: "Chief" });
  store.setChiefOfStaff(chief.id);
  const notified: string[] = [];
  let busy = false;
  const make = () => createBrief({
    store, dataDir: dir, now: () => now, hosted: options.hosted ?? false, mainThread: () => store.bot(chief.id)!.threadId, threadBusy: () => busy,
    notify: (_bot, _thread, detail) => notified.push(detail), needsYou: () => options.needsYou ?? [], engineName: () => "Claude",
    hostTimeZone: () => "UTC", language: () => options.language, session: () => null, address: () => "me@x.test",
    ideas: (botId) => (botId === chief.id && options.ideas ? { ideas: options.ideas, conversations: 3 } : { ideas: [], conversations: 0 }),
  });
  let brief = make();
  const thread = () => store.bot(chief.id)!.threadId;
  const rows = (): Message[] => store.messagesFor(thread());
  const card = () => rows().findLast((message) => message.serverCard && message.widget?.root.title === "Your brief");
  const shown = () => JSON.stringify(card()?.widget?.root ?? null);
  return {
    get brief() { return brief; }, store, chief, notified, rows, card, shown, thread,
    advance: (ms: number) => { now += ms; }, now: () => now, busy: (value: boolean) => { busy = value; }, restart: () => { brief = make(); },
  };
}

describe("the brief", () => {

  it("counts only the emails it leaves out, and still says how many new ones wait", () => {
    const emails = Array.from({ length: 8 }, (_, at) => ({ messageId: `m${at}`, threadId: `t${at}`, from: `Sender ${at} <s${at}@x.test>`, subject: `Subject ${at}`, needsReply: false }));
    const shown = JSON.stringify(briefCard({ now: Date.parse("2026-10-22T08:00:00Z"), timeZone: "UTC", intro: false, needs: [], meetings: null, emails, waiting: 3, routines: [] }).card);
    expect(shown).toContain("and 2 more");
    expect(shown).toContain(ENGLISH_BRIEF.waitingCount(3));
  });

  it("offers the night's ideas as plain text on the first open of the day, without a notification", async () => {
    const s = setup({ ideas: ["Make the Friday report a routine", "<b>Save</b> the draft checklist as a skill"] });
    expect((await s.brief.active("desktop", "UTC")).open).toEqual({ botId: s.chief.id, threadId: s.thread() });
    const root = s.card()!.widget!.root;
    expect(s.shown()).toContain('"value":"Ideas"');
    expect(s.shown()).toContain("Make the Friday report a routine");
    expect(s.shown()).toContain("Noticed across 3 chats");
    expect(JSON.stringify(root)).not.toMatch(/"type":"(?:Button|Link|Image|Html)"[^}]*Save/);
    expect(s.notified).toEqual([]);
  });

  it("is not there while it has nothing for the person, so an open never takes the screen for an empty card", async () => {
    const needsYou: NeedsYouItem[] = [];
    const s = setup({ needsYou });
    expect(await s.brief.active("desktop", "UTC")).toEqual({ returned: false });
    expect(s.card()).toBeUndefined();
    // Something needs the person later that day: a ping while they use the app neither posts the brief nor opens it.
    needsYou.push({ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] });
    s.advance(5 * MINUTE);
    expect(await s.brief.active("desktop")).toEqual({ returned: false });
    expect(s.card()).toBeUndefined();
    s.advance(5 * MINUTE);
    expect(await s.brief.active("desktop")).toEqual({ returned: false });
  });

  it("shows on the first open of a day, saying what it does, and once more only after three hours away", async () => {
    const s = setup({ needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    expect(await s.brief.active("desktop", "UTC")).toEqual({ returned: false, open: { botId: s.chief.id, threadId: s.thread() } });
    expect(s.shown()).toContain(ENGLISH_BRIEF.intro);
    expect(s.shown()).toContain("Claude is signed out");
    const first = s.card()!;
    s.advance(30 * MINUTE);
    expect(await s.brief.active("desktop")).toEqual({ returned: false });
    s.advance(AWAY_MS);
    expect(await s.brief.active("desktop")).toMatchObject({ returned: true, open: { threadId: s.thread() } });
    expect(s.card()!.id).toBe(first.id);
    expect(s.card()!.widget!.rev ?? 0).toBe(0);
    expect(s.shown()).toContain(ENGLISH_BRIEF.intro);
  });

  it("keeps its home chat when the person starts a newer one, and posts a new card the next day", async () => {
    const s = setup({ needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    await s.brief.active("desktop", "UTC");
    const home = s.thread();
    const first = s.card()!.id;
    s.store.createTask(s.chief.id, "A newer chat", true);
    s.advance(24 * 60 * MINUTE);
    await s.brief.active("desktop");
    const today = s.store.messagesFor(home).findLast((message) => message.serverCard)!;
    expect(today.id).not.toBe(first);
    expect(today.widget!.root.title).toBe("Your brief");
    expect(JSON.stringify(today.widget!.root)).not.toContain(ENGLISH_BRIEF.intro);
  });

  it("follows the language the person's app shows over the server's, and switches today's card in place", async () => {
    const s = setup({ language: "pt-br", needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    await s.brief.active("desktop", "UTC", "es");
    const title = () => s.rows().findLast((message) => message.serverCard)!.widget!.root.title;
    const first = s.rows().findLast((message) => message.serverCard)!.id;
    expect(title()).toBe("Tu resumen");
    s.advance(2 * MINUTE);
    expect(await s.brief.active("desktop", "UTC", "de")).toEqual({ returned: false });
    expect(title()).toBe("Dein Überblick");
    expect(s.rows().filter((message) => message.serverCard).map((message) => message.id)).toEqual([first]);
    s.restart();
    await s.brief.refresh();
    expect(title()).toBe("Dein Überblick");
  });

  it("does not tell the person again about the same rows when only the language changed", async () => {
    const options = { language: "es", needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] as NeedsYouItem[] };
    const s = setup(options);
    await s.brief.active("desktop", "UTC");
    expect(s.notified).toEqual(["Tu resumen: 1 te necesita"]);
    options.language = "de";
    await s.brief.refresh();
    expect(s.rows().findLast((message) => message.serverCard)!.widget!.root.title).toBe("Dein Überblick");
    expect(s.notified).toHaveLength(1);
  });

  it("is never there on a hosted team workspace or a Team Cloud", async () => {
    const s = setup({ hosted: true });
    expect(await s.brief.active("desktop", "UTC")).toEqual({ returned: false });
    expect(s.card()).toBeUndefined();
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Store, type Message } from "../store.ts";
import { createFirstHour, FIRST_HOUR_FILE, firstName, greetingMessage, UNASKED_MS, type FirstHourDeps } from "./first-hour.ts";
import { createValueLedger } from "./value-ledger.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { start?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-first-hour-"));
  dirs.push(dir);
  let now = Date.parse(options.start ?? "2026-10-27T15:00:00Z");
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const chief = store.createBot({ name: "MausBot" }, { seedMessages: false });
  store.setChiefOfStaff(chief.id);
  const thread = () => store.bot(chief.id)!.threadId;
  store.appendMessage(thread(), greetingMessage(chief, {}, undefined));
  const world = {
    person: {} as { name?: string; email?: string }, language: undefined as string | undefined, zone: "UTC",
    briefOn: false, phones: 0, busy: false,
    pushed: [] as string[], welcomeDone: 0,
  };
  const ledger = createValueLedger({ dataDir: dir, now: () => now });
  const deps: FirstHourDeps = {
    store, dataDir: dir, now: () => now, chief: () => store.bot(chief.id), mainThread: () => thread(), threadBusy: () => world.busy,
    person: () => world.person, language: () => world.language, timeZone: () => world.zone,
    briefOn: () => world.briefOn, ensureBrief: () => { world.briefOn = true; }, phones: () => world.phones,
    notify: (_bot, _thread, body) => world.pushed.push(body), wrote: () => {}, welcomeDone: () => { world.welcomeDone += 1; },
    ledger,
  };
  const make = () => {
    const made = createFirstHour(deps);
    store.onChange((change) => {
      if (change.type === "message") made.message(change.threadId, change.message);
    });
    return made;
  };
  const rows = (): Message[] => store.messagesFor(thread());
  const texts = () => rows().filter((row) => row.role === "bot" && row.kind === "text").map((row) => row.text);
  const write = (text: string) => store.appendMessage(thread(), { role: "user", kind: "text", text });
  const reply = (text: string) => store.appendMessage(thread(), { role: "bot", kind: "text", text });
  /** The Chief's first answer, as the server's turns write and end it. */
  const answer = async (fh: ReturnType<typeof make>, text = "My inbox is a mess.") => {
    write(text);
    reply("On it.");
    fh.turnCompleted(thread(), true);
    fh.tick();
    await settle();
    await settle();
  };
  return { dir, store, chief, thread, world, ledger, make, rows, texts, write, reply, answer, advance: (ms: number) => { now += ms; }, set: (iso: string) => { now = Date.parse(iso); }, now: () => now };
}

describe("a new Cloud's first hour", () => {
  it("begins once, on the new Cloud only: its welcome steps end and the Chief opens", () => {
    const s = setup();
    const fh = s.make();
    expect(fh.active()).toBe(false);
    fh.begin();
    expect(fh.active()).toBe(true);
    expect(s.world.welcomeDone).toBe(1);
    expect(s.store.bot(s.chief.id)!.welcomed).toBe(true);
    const again = s.make();
    again.begin();
    expect(again.active()).toBe(true);
    expect(s.world.welcomeDone).toBe(1);
  });

  it("greets by name in the person's language once they arrive, only while nobody has answered", () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    expect(s.texts()[0]).toBe("Hi! I'm MausBot, your Chief of Staff. I live on the Cloud, so I keep working while your computer is off. What do you want off your plate?");
    s.world.person = { email: "sam.lee@example.test" };
    s.world.language = "de";
    fh.arrived();
    fh.stop();
    expect(s.texts()[0]).toBe("Hallo Sam! Ich bin MausBot, dein Chief of Staff. Ich lebe in deiner Cloud und arbeite weiter, auch wenn dein Computer aus ist. Was soll ich dir abnehmen?");
    s.write("Mein Postfach");
    s.world.language = "fr";
    fh.arrived();
    fh.stop();
    expect(s.texts()[0]).toMatch(/^Hallo Sam!/);
  });

  it("says the brief once and offers the phone once, after the Chief's first answer", async () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    await s.answer(fh);
    expect(s.texts().at(-1)).toBe("Every morning at 8 I'll send you a brief of what needs you.");
    const phone = s.rows().at(-1)!;
    expect(phone).toMatchObject({ serverCard: true, kind: "widget" });
    expect(JSON.stringify(phone.widget!.root)).toContain('"onClickAction":{"type":"open_phone_pairing"}');
    expect(fh.health()!.ms.briefOn).toBeDefined();
    expect(fh.health()!.ms.phoneOffered).toBeDefined();
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("Every morning at 8"))).toHaveLength(1);
    expect(s.rows().filter((row) => row.serverCard)).toHaveLength(1);
  });

  it("brings its moment a second after the Chief's answer ends, not at the next check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = setup();
    const fh = s.make();
    fh.begin();
    s.write("My inbox is a mess.");
    s.reply("On it.");
    fh.turnCompleted(s.thread(), true);
    expect(s.texts().some((text) => text?.startsWith("Every morning at 8"))).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.texts().some((text) => text?.startsWith("Every morning at 8"))).toBe(true);
  });

  it("brings its moment unasked when the person is here and has not written", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = setup();
    const fh = s.make();
    fh.begin();
    fh.arrived();
    await vi.advanceTimersByTimeAsync(UNASKED_MS - 1_000);
    expect(s.texts().some((text) => text?.startsWith("Every morning at 8"))).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.texts().some((text) => text?.startsWith("Every morning at 8"))).toBe(true);
    expect(s.rows().at(-1)).toMatchObject({ serverCard: true, kind: "widget" });
    fh.stop();
  });

  it("marks a phone that is already paired, and never offers the card", async () => {
    const s = setup();
    s.world.phones = 1;
    const fh = s.make();
    fh.begin();
    await s.answer(fh);
    expect(s.rows().filter((row) => row.serverCard)).toHaveLength(0);
    expect(fh.health()!.ms.phonePaired).toBeDefined();
    expect(fh.health()!.ms.phoneOffered).toBeDefined();
  });

  it("says the first brief is the first, and the later ones are not", () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    expect(fh.morningPush("Your brief: 2 meetings")).toBe("Your first brief is ready");
    expect(fh.morningPush("Your brief: 2 meetings")).toBe("Your brief: 2 meetings");
  });

  it("loads a first-hour file written before the connected apps were removed, and forgets them", () => {
    const s = setup();
    writeFileSync(join(s.dir, FIRST_HOUR_FILE), JSON.stringify({
      version: 1, startedAt: Date.parse("2026-10-27T15:00:00Z"), firstAppAt: 123, apps: ["gmail", "googlecalendar"],
    }));
    const fh = s.make();
    expect(fh.active()).toBe(true);
    expect(fh.health()!.ms).not.toHaveProperty("firstApp");
    fh.arrived();
    const saved = JSON.parse(readFileSync(join(s.dir, FIRST_HOUR_FILE), "utf8")) as Record<string, unknown>;
    expect(saved.apps).toBeUndefined();
    expect(saved.firstAppAt).toBeUndefined();
    expect(saved.seenAt).toBeDefined();
  });

  it("recaps on day two, from what was really done, with the time it gave back kept conservative", async () => {
    const s = setup({ start: "2026-10-27T15:00:00Z" });
    s.world.zone = "America/New_York";
    const fh = s.make();
    fh.begin();
    s.ledger.add("sorted", 40);
    s.ledger.add("drafted", 6);
    s.ledger.add("prepped", 4);
    s.set("2026-10-28T11:59:00Z");
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("So far"))).toEqual([]);
    s.set("2026-10-28T12:00:00Z");
    fh.tick();
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("So far"))).toEqual(["So far I've sorted 40 emails, drafted 6 replies and prepped 4 meetings: about 2 hours back."]);
    expect(fh.tally()).toEqual({ sorted: 40, drafted: 6, prepped: 4, routines: 0 });
  });

  it("holds the recap while the person's newest message is still unanswered, so it never reads as the answer", () => {
    const s = setup({ start: "2026-10-27T09:00:00Z" });
    const fh = s.make();
    fh.begin();
    s.ledger.add("sorted", 29);
    s.set("2026-10-28T09:00:00Z");
    s.write("Every couple in both movies and Friends");
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("So far"))).toEqual([]);
    s.store.appendMessage(s.thread(), { role: "bot", kind: "text", text: "A server notice." });
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("So far"))).toEqual([]);
    s.store.appendMessage(s.thread(), { role: "bot", kind: "widget", text: "Pick one", turnId: "turn-1" });
    fh.tick();
    expect(s.texts().at(-1)).toBe("So far I've sorted 29 emails: about 30 minutes back.");
  });

  it("counts a routine's posted results in the recap, and says nothing at all when nothing was done", () => {
    const s = setup({ start: "2026-10-27T09:00:00Z" });
    const fh = s.make();
    fh.begin();
    s.set("2026-10-28T09:00:00Z");
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("So far"))).toEqual([]);
    expect(fh.health()!.ms.recap).toBeDefined();

    const t = setup({ start: "2026-10-27T09:00:00Z" });
    const other = t.make();
    other.begin();
    t.ledger.add("drafted", 1);
    t.set("2026-10-28T09:00:00Z");
    other.tick();
    expect(t.texts().filter((text) => text?.startsWith("So far"))).toEqual(["So far I've drafted 1 reply and ran 1 routine: about 10 minutes back."]);
  });

  it("tells the Chief about the first day in its own chat only, and only that day", () => {
    const s = setup();
    const fh = s.make();
    expect(fh.prompt(s.chief.id, s.thread())).toBe("");
    fh.begin();
    s.world.person = { name: "Sam Lee" };
    expect(fh.prompt(s.chief.id, s.thread())).toContain("This is Sam's first day with you on their new Cloud.");
    expect(fh.prompt(s.chief.id, s.thread())).not.toContain("Gmail");
    expect(fh.prompt(s.chief.id, "another-chat")).toBe("");
    s.advance(25 * HOUR);
    expect(fh.prompt(s.chief.id, s.thread())).toBe("");
  });
});

describe("the name it greets with", () => {
  it("is the profile's first name, else a plain address's, never a role address or a run-together one", () => {
    expect(firstName({ name: "  Sam Lee ", email: "x@y.test" })).toBe("Sam");
    expect(firstName({ email: "sam.lee@example.test" })).toBe("Sam");
    expect(firstName({ email: "maria_garcia@example.test" })).toBe("Maria");
    expect(firstName({ email: "ana@example.test" })).toBe("Ana");
    expect(firstName({ email: "info@example.test" })).toBeUndefined();
    expect(firstName({ email: "hello@example.test" })).toBeUndefined();
    expect(firstName({ email: "jsmith42@example.test" })).toBeUndefined();
    expect(firstName({ email: "johnathansmith@example.test" })).toBeUndefined();
    expect(firstName({})).toBeUndefined();
  });
});

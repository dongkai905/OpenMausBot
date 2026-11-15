import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertBotHere, botMoveRefusal, createBotMoves, MY_CLOUD_TEAM } from "./bot-moves.ts";
import type { BotRecord } from "./store.ts";
import { WaitManager } from "./waits.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ACME = { id: "team-acme", name: "Acme" };

function waitsFor(settled: string[][]) {
  const dir = mkdtempSync(join(tmpdir(), "omb-bot-moves-"));
  dirs.push(dir);
  return new WaitManager({
    file: join(dir, "waits.json"), probes: { stamp: async () => null }, sourceAlive: () => true, botBusy: () => false,
    post: () => true, followUp: () => undefined, showCard: (wait) => `card-${wait.label}`, settleCard: (wait, how) => { settled.push([wait.label, how]); },
  });
}

function setup({ busy = false, waits = null as WaitManager | null } = {}) {
  const bots = new Map<string, Record<string, unknown>>([["scout", { id: "scout", name: "Scout" }], ["pip", { id: "pip", name: "Pip" }]]);
  const moves = createBotMoves({
    store: {
      bot: (id) => (bots.get(id) as unknown as BotRecord) ?? null,
      patchBot: (id, patch) => { const bot = bots.get(id)!; Object.assign(bot, patch); return bot as unknown as BotRecord; },
    },
    waits: () => waits,
    busy: () => busy,
    now: () => 1_000,
  });
  return { moves, bots };
}

describe("My Cloud holding a bot while it moves into a team", () => {
  it("takes no turns while it moves; holding it again changes nothing", async () => {
    const { moves, bots } = setup();
    expect(await moves.hold("scout", ACME)).toEqual({ movedTo: { team: ACME, state: "moving", at: 1_000, held: [] } });
    expect(() => assertBotHere(bots.get("scout") as never)).toThrow("Scout is moving to Acme. It's ready there in a moment.");
    expect(() => assertBotHere(bots.get("pip") as never)).not.toThrow();
    expect((await moves.hold("scout", ACME) as { movedTo: { held: string[] } }).movedTo.held).toEqual([]);
    expect(await moves.hold("scout", { id: "team-beta", name: "Beta" })).toEqual({ refused: "Scout is moving to Acme. It's ready there in a moment." });
  });

  it("waits while the bot is answering, and refuses a bot that is gone", async () => {
    expect(await setup({ busy: true }).moves.hold("scout", ACME)).toEqual({ busy: "Scout" });
    expect(await setup().moves.hold("nobody", ACME)).toEqual({ refused: "This bot is no longer here." });
  });

  it("lets the bot go on as it was when the move stops", async () => {
    const { moves, bots } = setup();
    await moves.hold("scout", ACME);
    expect(await moves.release("scout")).toEqual({ released: true });
    expect(bots.get("scout")!.movedTo).toBeUndefined();
    expect(() => assertBotHere(bots.get("scout") as never)).not.toThrow();
  });

  it("keeps the bot as the line that opens it in the team once it arrived: archived, never let go of after", async () => {
    const { moves, bots } = setup();
    await moves.hold("scout", ACME);
    expect(moves.moved("scout", { id: "team-beta", name: "Beta" })).toEqual({ refused: "This bot is not moving to that team." });
    expect(moves.moved("scout", ACME)).toMatchObject({ movedTo: { team: ACME, state: "moved" } });
    expect(bots.get("scout")).toMatchObject({ hidden: true, movedTo: { state: "moved" } });
    expect(botMoveRefusal(bots.get("scout") as never)).toBe("Scout lives in Acme now.");
    expect(await moves.release("scout")).toEqual({ refused: "Scout lives in Acme now." });
    expect(moves.moved("scout", ACME)).toMatchObject({ movedTo: { state: "moved" } });
    expect(moves.moved("pip", ACME)).toEqual({ refused: "This bot is not moving to that team." });
  });

  it("cancels the moving bot's waits, card and all, so none fires for a bot that lives in the team; other bots keep theirs", async () => {
    const settled: string[][] = [];
    const waits = waitsFor(settled);
    const made = (botId: string, label: string) => waits.create({ botId, threadId: `t-${botId}`, label, condition: { kind: "file_exists", path: `/${label}` }, followUp: "Tell them." });
    await made("scout", "the report"); await made("pip", "the build");
    const { moves } = setup({ waits });
    await moves.hold("scout", ACME);
    expect(waits.all().map((wait) => wait.botId)).toEqual(["pip"]);
    expect(settled).toEqual([["the report", "cancelled"]]);
    await made("scout", "the invoice");
    moves.moved("scout", ACME);
    expect(waits.all().map((wait) => wait.botId)).toEqual(["pip"]);
    expect(settled).toEqual([["the report", "cancelled"], ["the invoice", "cancelled"]]);
  });
});

describe("a bot moving from this computer to My Cloud", () => {
  const MY_CLOUD = { id: MY_CLOUD_TEAM, name: "My Cloud" };
  function here() {
    const bots = new Map<string, Record<string, unknown>>([["scout", { id: "scout", name: "Scout" }], ["pip", { id: "pip", name: "Pip" }], ["maus", { id: "maus", name: "Maus", defaultBot: { v: 1 } }]]);
    const groups = [{ id: "both", memberIds: ["scout", "pip"], dm: false }, { id: "alone", memberIds: ["scout", "maus"], dm: false }];
    const moves = createBotMoves({
      store: { bot: (id) => (bots.get(id) as unknown as BotRecord) ?? null, patchBot: (id, patch) => Object.assign(bots.get(id)!, patch) as unknown as BotRecord, groups,
        patchGroup: (id, patch) => Object.assign(groups.find((group) => group.id === id)!, patch) },
      waits: () => null, busy: () => false,
    });
    return { moves, bots, groups };
  }

  it("leaves a room some of whose bots stay, and keeps a room all of whose bots left", async () => {
    const { moves, bots, groups } = here();
    await moves.hold("scout", MY_CLOUD);
    moves.moved("scout", MY_CLOUD);
    expect(bots.get("scout")).toMatchObject({ hidden: true, movedTo: { state: "moved" } });
    expect(groups.find((group) => group.id === "both")!.memberIds, "the room goes on here without it").toEqual(["pip"]);
    expect(groups.find((group) => group.id === "alone")!.memberIds, "only the helper every place has is left").toEqual(["scout", "maus"]);
  });

  it("is here again as it went if My Cloud ends", async () => {
    const { moves, bots } = here();
    await moves.hold("scout", MY_CLOUD);
    moves.moved("scout", MY_CLOUD);
    expect(moves.back("scout")).toEqual({ released: true });
    expect(bots.get("scout")).toMatchObject({ hidden: false, movedTo: undefined });
    expect(moves.back("pip"), "a bot that never left has nothing to come back from").toEqual({ released: true });
  });

  it("a bot that went into a team never comes back this way", async () => {
    const { moves } = here();
    await moves.hold("pip", ACME);
    moves.moved("pip", ACME);
    expect("refused" in moves.back("pip")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import "../server-line-packs.ts";
import type { HandoffView } from "../coordinator.ts";
import { createOutsideLineage, type OutsideLineageDeps } from "./outside-lineage.ts";

function world(over: Partial<OutsideLineageDeps> = {}) {
  const tasks = new Map<string, { threadId: string; outside?: true }>();
  for (const threadId of ["chat", "hook-run", "teammate", "results", "person-work"]) tasks.set(threadId, { threadId });
  const lines = new Map<string, Array<Record<string, unknown>>>();
  const rooms = new Set<string>();
  const nodes = new Map<string, HandoffView>();
  const store = {
    botByThread: (threadId: string) => (tasks.has(threadId) ? { id: "bot" } : null),
    taskByThread: (_botId: string, threadId: string) => tasks.get(threadId),
    patchTask: (_botId: string, threadId: string, patch: { outside?: true }) => { Object.assign(tasks.get(threadId)!, patch); },
    messagesFor: (threadId: string) => lines.get(threadId) ?? [],
    groupByThread: (threadId: string) => (rooms.has(threadId) ? { id: threadId } : undefined),
    appendMessage: (threadId: string, row: Record<string, unknown>) => { lines.set(threadId, [...(lines.get(threadId) ?? []), row]); return row; },
  } as unknown as OutsideLineageDeps["store"];
  const lineage = createOutsideLineage({
    home: true, team: true, solo: () => false, store, confinedNow: () => false,
    starters: () => [], guestOpened: () => false, ownerPerson: () => false,
    node: (id) => nodes.get(id), active: () => [...nodes.values()], language: () => undefined, ...over,
  });
  return { lineage, tasks, lines, rooms, nodes };
}

describe("work from outside stays with that work", () => {
  it("carries the record to what a marked conversation hands on, and no further than that", () => {
    const w = world();
    w.lineage.mark("hook-run");
    w.lineage.carry("hook-run", "teammate");
    expect(w.tasks.get("teammate")?.outside).toBe(true);
    w.lineage.carry("chat", "person-work");
    expect(w.tasks.get("person-work")?.outside).toBeUndefined();
  });

  it("lets confined work reach only what is confined already, and everything else reach anything", () => {
    const w = world();
    w.lineage.mark("hook-run");
    w.lineage.mark("teammate");
    expect(w.lineage.mayReach("hook-run", "person-work")).toBe(false);
    expect(w.lineage.mayReach("hook-run", "teammate")).toBe(true);
    expect(w.lineage.mayReach("chat", "hook-run")).toBe(true);
    expect(w.lineage.mayReach("chat", "person-work")).toBe(true);
  });

  it("off a Cloud nothing is confined, and the record only stops a level travelling", () => {
    const desktop = world({ home: false, team: false });
    desktop.lineage.mark("hook-run");
    expect(desktop.lineage.cloudGuestDriven("hook-run")).toBe(false);
    expect(desktop.lineage.mayReach("hook-run", "person-work")).toBe(true);
    expect(desktop.lineage.handsNoLevel("hook-run")).toBe(true);
    expect(desktop.lineage.handsNoLevel("chat")).toBe(false);
  });

  it("tells a person once why the bot works without its shell here, and only on a Team Cloud", () => {
    const w = world();
    w.lineage.mark("hook-run");
    w.lineage.personLineConfined("hook-run");
    w.lineage.personLineConfined("hook-run");
    expect(w.lines.get("hook-run")).toHaveLength(1);
    w.lineage.personLineConfined("chat");
    expect(w.lines.get("chat")).toBeUndefined();
    const solo = world({ team: false, solo: () => true });
    solo.lineage.mark("hook-run");
    solo.lineage.personLineConfined("hook-run");
    expect(solo.lines.get("hook-run")).toBeUndefined();
  });

  it("names outside work in its own words when the engine can't run confined", () => {
    const w = world();
    w.lineage.mark("hook-run");
    expect(w.lineage.guestEngineRefusal("hook-run")).toContain("Work from outside came into this conversation");
  });
});

describe("confinement explanations follow the conversation language without choosing branches by translated text", () => {
  it.each([
    ["en", "Work from outside came into this conversation", "This bot's AI can't run it that way.", "This conversation is from before the Cloud was only yours"],
    ["pt-br", "Esta conversa recebeu trabalho de fora", "A IA deste bot não pode trabalhar dessa forma.", "Esta conversa é de antes de o Cloud ser só seu"],
    ["de", "Arbeit von außerhalb ist in diese Unterhaltung gelangt", "Die KI dieses Bots kann so nicht arbeiten.", "Diese Unterhaltung stammt aus der Zeit, bevor die Cloud nur dir gehörte"],
  ])("keeps both refusal branches in %s", (language, outside, prefix, old) => {
    const w = world({ language: () => language });
    w.lineage.mark("hook-run");
    expect(w.lineage.confinedWhy("hook-run")).toContain(outside);
    expect(w.lineage.guestEngineRefusal("hook-run")).toContain(prefix);
    expect(w.lineage.guestEngineRefusal("hook-run")).toContain(outside);
    expect(w.lineage.guestEngineRefusal("chat")).toContain(old);
    expect(w.lineage.guestEngineRefusal("chat")).not.toContain(prefix);
  });
});

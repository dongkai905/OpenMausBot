import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { arrivedRoute, automationsOffRoute, homeRoute, movedFrom } from "./cloud-send-arrived.ts";
import "./server-line-packs.ts";
import type { MoveAutomations } from "./move-freeze.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function cloud(owner = true, language?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-arrived-")); dirs.push(dataDir);
  const lines: Array<{ threadId: string; text?: string; textCode?: string }> = [];
  const deps = {
    dataDir,
    store: { bot: (id: string) => (id === "scout" ? { threadId: "t-scout" } : undefined), appendMessage: (threadId: string, message: { text?: string; textCode?: string }) => { lines.push({ threadId, text: message.text, ...(message.textCode ? { textCode: message.textCode } : {}) }); return message; } } as never,
    lineLanguage: (person?: string) => person === "p_owner" ? language : "en",
    owner: () => (owner ? { person: "p_owner", name: "Owner" } : null),
  };
  const ask = async (body: unknown) => {
    let answered: { status: number; body: any } | undefined;
    await arrivedRoute(deps, { path: "/api/cloud-send/arrived", method: "POST", req: {} as never, res: {} as never, auth: {} as never, url: new URL("http://x/"),
      json: (_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }, readBody: async () => body } as never);
    return answered!;
  };
  return { dataDir, lines, ask, deps };
}

describe("POST /api/cloud-send/arrived", () => {
  it("has the person told what stayed behind, in their language, once the move is recorded", async () => {
    const { dataDir, ask, deps } = cloud(true, "de");
    const told: Array<string | undefined> = [];
    (deps as { stayed?: (language?: string) => void }).stayed = (language) => { told.push(language); expect(movedFrom(dataDir)?.computer).toBe("MacBook Air"); };
    expect((await ask({ v: 1, computer: "MacBook Air" })).status).toBe(200);
    expect(told).toEqual(["de"]);
  });

  it("keeps the computer the bots came from, and says it once", async () => {
    const { dataDir, lines, ask } = cloud();
    expect(await ask({ v: 1, computer: "MacBook Air" })).toEqual({ status: 200, body: { v: 1, told: 0 } });
    expect(lines).toEqual([]);
    expect(movedFrom(dataDir)).toMatchObject({ computer: "MacBook Air", told: [] });
  });

  it("only from My Cloud's owner", async () => {
    const { dataDir, lines, ask } = cloud(false);
    expect((await ask({ v: 1, computer: "MacBook Air" })).status).toBe(403);
    expect([lines, movedFrom(dataDir)]).toEqual([[], null]);
  });
});

describe("POST /api/cloud-send/home", () => {
  it("once the bots came home, where they came from goes, and nothing is said twice", async () => {
    const { dataDir, lines, ask } = cloud();
    await ask({ v: 1, computer: "MacBook Air" });
    lines.length = 0;
    const deps = { dataDir, store: { bot: (id: string) => (id === "scout" ? { threadId: "t-scout" } : undefined), appendMessage: (threadId: string, message: { text?: string; textCode?: string }) => { lines.push({ threadId, text: message.text, ...(message.textCode ? { textCode: message.textCode } : {}) }); return message; } } as never };
    const home = async (body: unknown, method = "POST") => {
      let answered: { status: number; body: any } | undefined;
      const handled = await homeRoute(deps, { path: "/api/cloud-send/home", method, req: { resume() {} } as never, res: {} as never, auth: {} as never, url: new URL("http://x/"),
        json: (_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }, readBody: async () => body } as never);
      return { handled, ...answered! };
    };
    expect((await home({ v: 2 })).status).toBe(400);
    expect(lines).toEqual([]);
    expect(await home({ v: 1 })).toEqual({ handled: true, status: 200, body: { v: 1, told: 0 } });
    expect(lines).toEqual([]);
    expect(movedFrom(dataDir), "where the bots came from no longer applies").toBeNull();
    expect((await home({ v: 1 })).body, "asked again: nothing twice").toEqual({ v: 1, told: 0 });
    expect(lines).toHaveLength(0);
    expect((await home({}, "GET")).status).toBe(405);
  });
});

describe("POST /api/cloud-send/automations-off", () => {
  /** My Cloud's waits, all on: two of one computer's and one made there. */
  function automations() {
    const on = new Map([["wait:a1", true], ["wait:b1", true], ["wait:a2", true]]);
    const deps = {
      waits: () => ({
        all: () => [...on].filter(([, open]) => open).map(([key]) => ({ id: key.slice(key.indexOf(":") + 1), botId: "b1" })),
        cancel: (id: string) => { const key = `wait:${id}`; if (!on.get(key)) return false; on.set(key, false); return true; },
      }),
    } as unknown as MoveAutomations;
    return { on, deps };
  }
  const ask = async (deps: MoveAutomations, body: unknown, { owner = true, method = "POST" } = {}) => {
    let answered: { status: number; body: any } | undefined;
    const handled = await automationsOffRoute({ automations: deps, owner: () => (owner ? { person: "p_owner", name: "Owner" } : null) }, { path: "/api/cloud-send/automations-off", method,
      req: { resume() {} } as never, res: {} as never, auth: {} as never, url: new URL("http://x/"),
      json: (_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }, readBody: async () => body } as never);
    return { handled, ...answered! };
  };

  it("stops exactly the waits a computer brought, and says which were on; the rest of My Cloud goes on", async () => {
    const { on, deps } = automations();
    expect(await ask(deps, { v: 1, keys: ["wait:a1", "wait:b1", "wait:gone"] }))
      .toEqual({ handled: true, status: 200, body: { v: 1, off: ["wait:a1", "wait:b1"] } });
    expect(Object.fromEntries(on)).toEqual({ "wait:a1": false, "wait:b1": false, "wait:a2": true });
    expect((await ask(deps, { v: 1, keys: ["wait:a1"] })).body, "asked again after a crash: nothing else changes").toEqual({ v: 1, off: [] });
  });

  it("only from My Cloud's owner, only by key, only POST", async () => {
    const { on, deps } = automations();
    expect((await ask(deps, { v: 1, keys: ["wait:b1"] }, { owner: false })).status).toBe(403);
    expect((await ask(deps, { v: 1, keys: ["bot:b1"] })).status).toBe(400);
    expect((await ask(deps, { v: 1, keys: ["wait:b1"] }, { method: "GET" })).status).toBe(405);
    expect([...on.values()].filter(Boolean)).toHaveLength(3);
  });
});

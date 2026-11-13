import { describe, expect, it } from "vitest";

import { aiSignInKey, rankAis } from "./ai-ranking.ts";

type Row = { id: string; driverKind: string; snapshot?: { freeFallback?: boolean } };
const row = (id: string, driverKind: string, snapshot?: Row["snapshot"]): Row => ({ id, driverKind, ...(snapshot ? { snapshot } : {}) });
const ids = (rows: readonly Row[]) => rows.map((entry) => entry.id);

const first = row("first", "customAcp");
const second = row("second", "customAcp");
const third = row("third", "customAcp");
const backup = row("backup", "customAcp", { freeFallback: true });

describe("one ranking of the AIs a new person has", () => {
  it("keeps the order it is given, and puts an AI with only free models last", () => {
    expect(ids(rankAis([first, second, third]))).toEqual(["first", "second", "third"]);
    expect(ids(rankAis([backup, second]))).toEqual(["second", "backup"]);
  });

  it("never reorders the list it is given", () => {
    const list = [first, second];
    rankAis(list);
    expect(ids(list)).toEqual(["first", "second"]);
    expect(rankAis([])).toEqual([]);
  });
});

describe("a sign-in, as a test result's key", () => {
  it("changes when the sign-in changes, and only then", () => {
    const signedIn = { state: "available", authenticated: true, account: { email: "a@example.test" } };
    expect(aiSignInKey(signedIn)).toBe(aiSignInKey({ ...signedIn, version: "2.0.0" }));
    expect(aiSignInKey(signedIn)).not.toBe(aiSignInKey({ ...signedIn, account: { email: "b@example.test" } }));
    expect(aiSignInKey(signedIn)).not.toBe(aiSignInKey({ ...signedIn, authenticated: false }));
    expect(aiSignInKey({ state: "available", authenticated: true, freeFallback: true }))
      .not.toBe(aiSignInKey({ state: "available", authenticated: true }));
  });
});

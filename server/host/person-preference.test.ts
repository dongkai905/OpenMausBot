import { describe, expect, it, vi } from "vitest";

import { createPersonPreference } from "./person-preference.ts";

type Turn = { threadId: string; generation: string; origin: "user" | "outside" };
const ADA = "p_ada0000000000000000000";
const scout = { id: "scout", name: "Scout" };

function make(team: boolean, requester: string | null) {
  const append = vi.fn((_text: string) => {});
  const preference = createPersonPreference<Turn>({
    team, aboutMe: { append }, requester: () => requester, userStarted: (turn) => turn.origin === "user",
    personName: (person) => (person === ADA ? "Ada" : undefined),
  });
  return { preference, append };
}

describe("whose About me a preference goes to", () => {
  it("on a Team Cloud, the person the turn acts for", () => {
    const { preference, append } = make(true, ADA);
    const target = preference.target({ threadId: "t1", generation: "g1", origin: "outside" }, scout)!;
    expect(target.person).toBe("Ada");
    expect(target.save("Reminders go to the task app")).toBeUndefined();
    expect(append).toHaveBeenCalledWith("Reminders go to the task app");
  });

  it("on a Team Cloud, no one when no one person's own words began the work", () => {
    expect(make(true, null).preference.target({ threadId: "t1", generation: "g1", origin: "user" }, scout)).toBeNull();
  });

  it("elsewhere, the one person, only when their own message began the work", () => {
    const { preference, append } = make(false, null);
    const target = preference.target({ threadId: "t1", generation: "g1", origin: "user" }, scout)!;
    expect(target.person).toBeUndefined();
    target.save("Replies in German");
    expect(append).toHaveBeenCalledWith("Replies in German");
    expect(preference.target({ threadId: "t2", generation: "g2", origin: "outside" }, scout), "an outside app").toBeNull();
  });
});

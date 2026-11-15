import { describe, expect, it } from "vitest";

import en from "../src/locales/en.json";
import {
  listNames, PLACE_EN, PLACE_STATES, PLACE_WORDS, placeRowText, placeRowView, placeState, placeView, placeViewOf,
  type PlaceFacts, type PlaceParams, type PlaceSource, type PlaceState,
} from "./place-view.ts";

/** Every param any line or action names, so a state always reads whole. */
const PARAMS: PlaceParams = {
  bot: "Scout", engine: "Claude", model: "Llama", computer: "Team desk",
  reason: "CUA Driver is not ready.", cause: "the Local VM is not ready",
};

const facts = (patch: Partial<PlaceFacts> = {}): PlaceFacts => ({
  place: "cloud", server: "my-cloud", bot: "Scout", role: "admin", browserOn: true,
  engine: { name: "Claude", model: "Claude Fable 5", computer: true, browser: true },
  ...patch,
});

describe("U1: one line and at most one action for every state", () => {
  it("words every state whole, for an Admin and for a User", () => {
    for (const state of PLACE_STATES) {
      for (const role of ["admin", "user"] as const) {
        const view = placeViewOf(state, PARAMS, { role, server: "my-cloud" });
        expect(view.short.trim(), state).not.toBe("");
        expect(view.line.trim(), state).not.toBe("");
        // one message: no second paragraph, no placeholder left unfilled
        expect(view.line, state).not.toMatch(/\n|\{\w+\}/);
        expect(view.short, state).not.toMatch(/\{\w+\}/);
        if (view.action) expect(view.action.label, state).not.toMatch(/^$|\{\w+\}/);
      }
    }
  });

  it("gives a User no action that changes a setting, and says who can", () => {
    for (const state of PLACE_STATES) {
      const admin = placeViewOf(state, PARAMS, { role: "admin", server: "my-cloud" });
      const user = placeViewOf(state, PARAMS, { role: "user", server: "my-cloud" });
      if (!admin.action || admin.action.id === "try-again" || admin.action.id === "clear-pin" || admin.action.id === "open-computer-panel") {
        expect(user, state).toEqual(admin);
        continue;
      }
      expect(user.action, state).toBeNull();
      expect(user.line, state).toBe(`${admin.line} Ask an Admin to change it.`);
    }
  });

  it("mirrors en.json exactly, key for key", () => {
    const catalog = en as Record<string, string>;
    for (const [key, value] of Object.entries(PLACE_EN)) expect(catalog[key], key).toBe(value);
    const mirrored = new Set(Object.keys(PLACE_EN));
    const inCatalog = Object.keys(catalog).filter((key) => /^place\.(view|action)\./.test(key) || key === "place.askAdmin" || key === "place.backOnAuto");
    expect(inCatalog.filter((key) => !mirrored.has(key))).toEqual([]);
  });

  it("keeps jargon out of what subscribers read", () => {
    // The hosted cloud computer is gone: no state names it, and none of its words survive.
    for (const state of PLACE_STATES) {
      const view = placeViewOf(state, PARAMS, { role: "admin", server: "my-cloud" });
      const words = `${view.short} ${view.line} ${view.action?.label ?? ""}`;
      expect(words, state).not.toMatch(/Boat|boat\.dev/);
      expect(words, state).not.toMatch(/\bbox\b|OMB|Hosted desktop|Cloud box|Works on to Auto|\btools?\b/i);
    }
    for (const [id, sentence] of Object.entries(PLACE_WORDS)) {
      expect(sentence, id).not.toMatch(/\bbox\b|OMB|Hosted desktop|Cloud box|Works on to Auto|\btools?\b/i);
      expect(sentence, id).not.toMatch(/Boat|boat\.dev/);
    }
  });

  it("uses the surviving copy for the places that are left", () => {
    const admin = { role: "admin" as const, server: "my-cloud" as const };
    expect(placeViewOf("vps", {}, admin)).toMatchObject({
      short: "Your own machine", line: "Uses your own Linux machine, connected over SSH.",
    });
    expect(placeViewOf("vm", {}, admin)).toMatchObject({
      short: "Separate from your screen", line: "A private Linux desktop on this device, separate from your own screen.",
      action: { id: "open-vm-settings", label: "Private desktop settings" },
    });
    expect(placeViewOf("auto", {}, admin)).toMatchObject({ short: "Chooses for you", action: null });
    expect(placeViewOf("auto-team", { computer: "Team desk" }, admin)).toMatchObject({
      short: "Shared", line: "Uses Team desk, the cloud desktop this department shares.", action: { id: "open-team-map", label: "Open Team map" },
    });
    expect(placeViewOf("browser-off", {}, admin)).toMatchObject({ action: { id: "turn-on-browser", label: "Turn on the browser" } });
    expect(placeViewOf("place-failed", { cause: "the Local VM is not ready" }, admin)).toMatchObject({
      short: "Didn't start", line: "the Local VM is not ready", action: { id: "open-computer-panel", label: "Open the Screen panel" },
    });
  });
});

describe("placeState", () => {
  it("reads the cloud desktop's facts in order: the model, then the place itself", () => {
    expect(placeState(facts({ engine: { name: "Llama", computer: false, browser: true } })).state).toBe("vm-cannot");
    expect(placeState(facts({ place: "vm", engine: { name: "Llama", computer: false, browser: true } })).state).toBe("vm-cannot");
    expect(placeState(facts({ place: "vm" })).state).toBe("vm");
    expect(placeState(facts({ place: "cloud" })).state).toBe("vps");
  });

  it("reads Auto, Off, the browser, this computer and a Local VM", () => {
    expect(placeState(facts({ place: "auto" })).state).toBe("auto");
    expect(placeState(facts({ place: "auto", teamComputer: "Team desk" }))).toEqual({ state: "auto-team", params: { bot: "Scout", computer: "Team desk" } });
    expect(placeState(facts({ place: "off" })).state).toBe("off");
    expect(placeState(facts({ place: "browser" })).state).toBe("browser");
    expect(placeState(facts({ place: "browser", browserOn: false })).state).toBe("browser-off");
    expect(placeState(facts({ place: "browser", engine: { name: "X", computer: true, browser: false } })).state).toBe("browser-cannot");
    expect(placeState(facts({ place: "local", local: { ready: false, reason: "Not yet." } }))).toEqual({
      state: "local-unavailable", params: { bot: "Scout", reason: "Not yet." },
    });
    expect(placeState(facts({ place: "vm", engine: { name: "X", computer: false, browser: true } })).state).toBe("vm-cannot");
  });

  it("words the Auto line for where this server runs", () => {
    expect(placeView(facts({ place: "auto" })).line).toMatch(/starts its cloud desktop by itself/);
    expect(placeView(facts({ place: "auto", server: "pc" })).line).not.toMatch(/Local VM/);
    expect(placeView(facts({ place: "auto", server: "linux" })).line).toMatch(/a running private desktop/);
    expect(placeView(facts({ place: "auto", server: "mac" })).line)
      .toBe("Uses the built-in browser, a private desktop on this computer, or this computer's screen, whichever the task needs.");
  });
});

describe("a failed place, by where it came from", () => {
  const row = (source: PlaceSource, state: PlaceState = "place-failed") => ({
    state, params: { bot: "Scout", cause: "the desktop did not start" }, source,
  });

  it("has its own way on per source for a passing cause", () => {
    const view = (source: PlaceSource, mode?: "simple" | "advanced") =>
      placeRowView(row(source), { role: "admin", mode, worksOnLabel: "Auto" });
    expect(view("works-on").action).toEqual({ id: "open-computer-panel", label: "Open the Screen panel" });
    expect(view("pin", "advanced").action).toEqual({ id: "clear-pin", label: "Clear this conversation's place" });
    expect(view("pin", "simple").action).toEqual({ id: "clear-pin", label: "Use Auto" });
    expect(view("auto-pin")).toMatchObject({ line: "the desktop did not start This conversation is back on Auto.", action: { id: "try-again" } });
    expect(view("routine").action).toEqual({ id: "change-routine", label: "Change where it runs" });
    expect(view("room").action).toBeNull();
  });

  it("keeps a cause's own fix whatever the source", () => {
    for (const source of ["works-on", "pin", "auto-pin", "routine", "room"] as const) {
      expect(placeRowView(row(source, "vm-cannot"), { role: "admin" }).action?.id, source).toBe("choose-model");
    }
  });

  it("stores the line and its action as words a phone can read", () => {
    expect(placeRowText({ state: "place-failed", params: { bot: "Scout", cause: "the Local VM is not ready" }, source: "works-on" }))
      .toBe("the Local VM is not ready Check it in the Screen panel.");
    expect(placeRowText(row("auto-pin")))
      .toBe("the desktop did not start This conversation is back on Auto. Send your message again.");
    expect(placeRowText(row("routine"))).toBe("the desktop did not start Change where this routine runs.");
    expect(placeRowText(row("room"))).toBe("the desktop did not start");
    expect(placeRowText({ state: "vm-cannot", params: { bot: "Scout", model: "Llama" }, source: "works-on" }))
      .toBe("Llama can't use a private desktop. Choose a model that can, such as Claude or ChatGPT. Choose another model in Scout's settings.");
  });
});

describe("names a list the way a sentence lists them", () => {
  it("joins them in the reader's language", () => {
    expect(listNames(["Ada", "Bo"])).toBe("Ada and Bo");
    expect(listNames(["Ada"])).toBe("Ada");
  });
});

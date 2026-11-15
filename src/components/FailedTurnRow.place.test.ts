// The phones read only the row's English words, so those carry the same line and action.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import { failedTurnCause, failedTurnTool } from "../../shared/failed-turn";
import { placeRowText, type PlaceRow } from "../../shared/place-view";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn(), advanced: false, ownerOrAdmin: null as boolean | null, bots: [] as Bot[], config: {} as Record<string, unknown> };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: fixture.config, instances: [] as InstanceInfo[], bots: fixture.bots },
    dispatch: fixture.dispatch, refreshInstances: vi.fn(), refreshModels: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "darwin" }, localComputer: { available: true } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => fixture.advanced,
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { FailedTurnRow } = await import("./ChatView");
const { placeRowViewFor } = await import("@/lib/place-view");


const stored = (place: PlaceRow): NonNullable<Message["tool"]> => failedTurnTool(placeRowText(place), { place });
/** A place the model cannot use: the one row a person can act on. */
const cannot: PlaceRow = { state: "vm-cannot", params: { bot: "Scout", model: "Claude" }, source: "works-on" };
/** A place that did not start, and where the conversation itself may retry. */
const failed: PlaceRow = { state: "place-failed", params: { bot: "Scout", cause: "It did not start." }, source: "auto-pin" };

function show(tool: NonNullable<Message["tool"]>, onRetry?: () => void) {
  const html = renderToStaticMarkup(createElement(FailedTurnRow, { tool, engine: undefined, botId: "scout", threadId: "thread-scout", onRetry }));
  const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
  return { html, buttons };
}

beforeEach(() => {
  fixture.dispatch = vi.fn();
  fixture.advanced = false;
  fixture.ownerOrAdmin = null;
  fixture.config = {};
  fixture.bots = [{ id: "scout", name: "Scout", computer: "cloud", modelSelection: { instanceId: "claude", model: "m" } } as Bot];
});

describe("J11: a failed place's row", () => {
  it("says the place cannot run, with one button: Choose a model", () => {
    const { html, buttons } = show(stored(cannot), vi.fn());
    expect(html).toContain("Claude can&#x27;t use a private desktop.");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain("Choose a model");
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("<details");
  });

  it("offers Try again only where the conversation can retry", () => {
    expect(show(stored(failed), vi.fn()).buttons).toHaveLength(1);
    expect(show(stored(failed), vi.fn()).buttons[0]).toContain("Try again");
    expect(show(stored(failed)).buttons).toHaveLength(0);
  });

  it("leads a person's pin back to the grid's choice in Simple, and to the composer's in Advanced", () => {
    const pinned = stored({ ...failed, source: "pin" });
    expect(show(pinned).buttons[0]).toContain("Use Cloud desktop");
    fixture.advanced = true;
    expect(show(pinned).buttons[0]).toContain("Clear this conversation&#x27;s place");
  });

  it("gives a User no button that changes a setting, and says who can", () => {
    fixture.ownerOrAdmin = false;
    const { html, buttons } = show(stored(cannot), vi.fn());
    expect(html).toContain("Ask an Admin to change it.");
    expect(buttons).toHaveLength(0);
  });

  it("reads the same row the way the app words it", () => {
    const seat = { server: "mac", role: "admin", mode: "simple" } as const;
    expect(placeRowViewFor(cannot, seat)).toMatchObject({
      state: "vm-cannot", line: "Claude can't use a private desktop. Choose a model that can, such as Claude or ChatGPT.", action: { id: "choose-model" },
    });
  });
});

describe("the phone row", () => {
  // What iOS and Android (ChatPreferences failedTurnCause) do with a row: drop "error:" and show the rest; they never
  // read `place`.
  const phoneCause = (name: string) => name.startsWith("error:") ? name.slice("error:".length).trim() : null;

  it("carries the line and its action in words, whole, for every source", () => {
    const rows: Array<[PlaceRow, string]> = [
      [cannot, "Claude can't use a private desktop. Choose a model that can, such as Claude or ChatGPT. Choose another model in Scout's settings."],
      [failed, "It did not start. This conversation is back on Auto. Send your message again."],
      [{ ...failed, source: "pin" }, "It did not start. Clear this conversation's place in the composer to continue."],
    ];
    for (const [place, words] of rows) {
      const tool = stored(place);
      const onPhone = JSON.parse(JSON.stringify(tool)) as { name: string };
      expect(phoneCause(onPhone.name)).toBe(words);
      expect(failedTurnCause(onPhone.name)).toBe(words);
    }
  });
});

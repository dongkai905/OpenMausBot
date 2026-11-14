// @vitest-environment happy-dom
// The engines' usage limits on screen: the usage bars in the model button with their card, and the reset markers the
// calendar shows.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineLimit } from "../../shared/limit-reset";
import { failedTurnTool } from "../../shared/failed-turn";
import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch, refreshInstances: vi.fn(), refreshModels: vi.fn() }),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "darwin" }, localComputer: { available: true } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => null }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { setLocale } = await import("@/lib/i18n");
const limits = await import("@/lib/limit-resets");
const { UsageAlert, UsageBars, UsageRows } = await import("./EngineUsage");
const { FailedTurnRow } = await import("./ChatView");

const NOW = new Date(2026, 9, 19, 10, 0, 0).getTime();
const RESET = new Date(2026, 9, 19, 15, 40, 0).getTime();
const MONDAY = new Date(2026, 9, 26, 9, 0, 0).getTime();
const HOVER_MS = 300;
const HOUR = 3_600_000;
const claude = (used: number, blocked = false): EngineLimit => ({ engine: "claude", name: "Claude", driver: "claude", window: "5-hour", usedPercent: used, resetsAt: RESET, blocked });
const bot = { id: "scout", name: "Scout", hidden: false, threadId: "t-main", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, tasks: [] } as unknown as Bot;

let root: Root | null = null;
function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(element));
  return container;
}
const button = (container: HTMLElement, label: string) => {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`no ${label} button in ${container.innerHTML}`);
  return found;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** What the app already knows and what the next poll answers. */
const serve = (engines: EngineLimit[]) => {
  fixture.api.mockImplementation(async () => ({ checkedAt: NOW, engines }));
  limits.rememberLimits({ checkedAt: NOW, engines });
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hover = (target: Element, pointerType: string) => flushSync(() => target.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType })));
const leave = (target: Element) => flushSync(() => target.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" })));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setLocale("en");
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async () => ({ checkedAt: NOW, engines: [claude(92)] }));
  fixture.state = { bots: [bot], instances: [] as InstanceInfo[], config: {}, groups: [] };
  limits.rememberLimits({ checkedAt: NOW, engines: [claude(92)] });
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the words", () => {
  it("say how full an engine is and when it resets", () => {
    expect(limits.limitLine(claude(92), NOW)).toBe("Claude: 92% used · resets 3:40 PM");
    expect(limits.limitLine(claude(100, true), NOW)).toBe("Claude: at its limit · resets 3:40 PM");
    expect(limits.nearLimitEngines([claude(89), { ...claude(90), engine: "agent-two" }]).map((limit) => limit.engine)).toEqual(["agent-two"]);
  });

  it("put each known reset in the calendar's range", () => {
    expect(limits.resetMarkers([claude(92), { ...claude(10), engine: "agent-two", name: "Codex", resetsAt: null }], NOW, NOW + 24 * HOUR, NOW))
      .toEqual([{ engine: "claude", name: "Claude", at: RESET }]);
    expect(limits.resetMarkers([claude(92)], RESET + 1, RESET + HOUR, NOW)).toEqual([]);
  });
});

describe("the bars", () => {
  const windows = (fiveHour: number, weekly: number, extra: Partial<EngineLimit> = {}): EngineLimit => ({
    ...claude(Math.max(fiveHour, weekly)), window: fiveHour >= weekly ? "5-hour" : "weekly",
    windows: [{ window: "5-hour", usedPercent: fiveHour, resetsAt: RESET }, { window: "weekly", usedPercent: weekly, resetsAt: MONDAY }], ...extra,
  });

  it("fill for the usage left, with one bar exactly while near the limit and none at it", () => {
    const bars = (used: number, blocked = false) => limits.usageBars({ usedPercent: used, blocked });
    expect([0, 29, 30, 31, 59, 60, 61, 89, 89.9, 90, 99, 100].map((used) => bars(used))).toEqual([4, 4, 3, 3, 3, 2, 2, 2, 2, 1, 1, 0]);
    expect(bars(40, true)).toBe(0);
    for (const used of [0, 45, 89, 90, 95, 100]) expect(bars(used) === 1).toBe(limits.nearLimit({ usedPercent: used, blocked: false }) && used < 100);
    expect([limits.usageTone({ usedPercent: 89, blocked: false }), limits.usageTone({ usedPercent: 90, blocked: false }), limits.usageTone({ usedPercent: 10, blocked: true })])
      .toEqual(["fine", "near", "out"]);
  });

  it("show nothing for an engine that reports no usage", () => {
    expect(limits.reportsUsage({ ...claude(0), usedPercent: null })).toBe(false);
    expect(limits.reportsUsage({ ...claude(0), usedPercent: null, blocked: true })).toBe(true);
    serve([{ ...claude(0), engine: "agent-two", name: "Codex", usedPercent: null, window: null, resetsAt: null }]);
    expect(mount(createElement(UsageBars, { engine: "agent-two" })).innerHTML).toBe("");
    expect(mount(createElement(UsageBars, { engine: "openai" })).innerHTML).toBe("");
  });

  it("list each window, or the deciding one alone from a server that sends no list", () => {
    expect(limits.usageRows(windows(38, 80))).toEqual([
      { window: "5-hour", left: 62, resetsAt: RESET, tone: "fine" }, { window: "weekly", left: 20, resetsAt: MONDAY, tone: "fine" },
    ]);
    expect(limits.usageRows(claude(92))).toEqual([{ window: "5-hour", left: 8, resetsAt: RESET, tone: "near" }]);
    expect(limits.usageRows({ ...claude(0), usedPercent: null })).toEqual([]);
  });

  it("put a blocked engine's deciding window at its limit until the engine's own reset", () => {
    const refused = windows(70, 20, { blocked: true, usedPercent: 100, resetsAt: RESET + HOUR });
    expect(limits.usageRows(refused)).toEqual([
      { window: "5-hour", left: 0, resetsAt: RESET + HOUR, tone: "out" }, { window: "weekly", left: 80, resetsAt: MONDAY, tone: "fine" },
    ]);
    expect(limits.usageRows({ ...claude(100, true), window: null, windows: [] })).toEqual([{ window: "other", left: 0, resetsAt: RESET, tone: "out" }]);
  });

  it("say the deciding window's use and reset to a screen reader, and draw a struck-through empty set at the limit", () => {
    serve([windows(38, 10)]);
    const fine = mount(createElement(UsageBars, { engine: "claude" }));
    expect(fine.querySelector("[data-usage-bars]")?.getAttribute("data-usage-bars")).toBe("fine");
    expect(fine.querySelector("[data-usage-glyph]")?.getAttribute("data-usage-glyph")).toBe("3");
    expect(fine.querySelector("[data-usage-warn]")).toBeNull();
    expect(fine.querySelector(".sr-only")?.textContent).toBe("Claude: 38% used, resets 3:40 PM");
    expect(fine.querySelector("svg path")).toBeNull();
    root!.unmount();
    serve([claude(100, true)]);
    const out = mount(createElement(UsageBars, { engine: "claude" }));
    expect(out.querySelector("[data-usage-glyph]")?.getAttribute("data-usage-glyph")).toBe("0");
    expect(out.querySelector("[data-usage-warn]")).not.toBeNull();
    expect(out.querySelector("svg path")).not.toBeNull();
    expect(out.querySelector(".sr-only")?.textContent).toBe("Claude: at its limit, resets 3:40 PM");
  });

  it("open every window in a card on a mouse hover, never on a touch, and keep the card's clicks from the model button", async () => {
    serve([windows(38, 80)]);
    const opened = vi.fn();
    const container = mount(createElement("button", { type: "button", onClick: opened }, createElement(UsageBars, { engine: "claude" })));
    const spot = container.querySelector("[data-usage-bars]")!;
    hover(spot, "touch");
    await wait(HOVER_MS);
    expect(document.querySelector("[data-usage-card]")).toBeNull();
    hover(spot, "mouse");
    await wait(HOVER_MS);
    const card = document.querySelector<HTMLElement>("[data-usage-card]")!;
    expect(card.querySelector("[data-usage-rows] > div")?.textContent).toBe("Claude usagechecked just now");
    expect([...card.querySelectorAll("[data-usage-row]")].map((row) => row.textContent)).toEqual(["5-hour62% left · resets 3:40 PM", "Weekly20% left · resets Mon 9:00 AM"]);
    expect([...card.querySelectorAll<HTMLElement>("[data-usage-track]")].map((track) => track.style.width)).toEqual(["38%", "80%"]);
    expect(card.textContent).not.toContain("Check again");
    leave(spot);
    await wait(HOVER_MS);
    expect(document.querySelector("[data-usage-card]")).toBeNull();

    flushSync(() => serve([windows(100, 80, { blocked: true })]));
    hover(spot, "mouse");
    await wait(HOVER_MS);
    const blocked = document.querySelector<HTMLElement>("[data-usage-card]")!;
    expect(blocked.querySelector('[data-usage-row="5-hour"]')?.textContent).toBe("5-hourAt its limit · resets 3:40 PM");
    expect(blocked.querySelector<HTMLElement>('[data-usage-row="5-hour"] [data-usage-track]')?.style.width).toBe("100%");
    expect(blocked.textContent).toContain("Clears by itself once Claude replies again.");
    fixture.api.mockClear();
    flushSync(() => blocked.querySelector<HTMLButtonElement>("[data-usage-check]")!.click());
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/limit-resets?refresh=1");
    expect(blocked.querySelector("[data-usage-release]"), "a full window: Try again now could not unblock it").toBeNull();
    leave(spot);
    await wait(HOVER_MS);

    flushSync(() => serve([windows(100, 80, { blocked: true, held: true })]));
    hover(spot, "mouse");
    await wait(HOVER_MS);
    const held = document.querySelector<HTMLElement>("[data-usage-card]")!;
    fixture.api.mockClear();
    fixture.api.mockImplementation(async () => ({ checkedAt: NOW, engines: [windows(100, 80)] }));
    // the check above keeps both buttons busy until its read settles
    await vi.waitFor(() => expect(held.querySelector<HTMLButtonElement>("[data-usage-release]")!.disabled).toBe(false));
    flushSync(() => held.querySelector<HTMLButtonElement>("[data-usage-release]")!.click());
    await settle();
    expect(fixture.api, "Try again now ends the hold (emails 1a1c2500, 1a1c136d)").toHaveBeenCalledWith("/api/limit-resets/release", { method: "POST", body: JSON.stringify({ engine: "claude" }) });
    expect(opened).not.toHaveBeenCalled();
  });

  it("say how long ago the usage was read", () => {
    limits.rememberLimits({ checkedAt: NOW - 3 * 60_000, engines: [windows(38, 80)] });
    expect(mount(createElement(UsageRows, { limit: windows(38, 80) })).querySelector("[data-usage-checked]")?.textContent).toBe("checked 3 min ago");
  });

  it("read limits on their own as a background poll, so a sleeping Cloud home stays asleep", async () => {
    fixture.api.mockClear();
    mount(createElement(UsageBars, { engine: "claude" }));
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/limit-resets", { background: true });
    expect(fixture.api).not.toHaveBeenCalledWith("/api/limit-resets");
  });

  it("stand alone in a phone's header only while near or at the limit, and open the bot's model there", () => {
    const alert = mount(createElement(UsageAlert, { engine: "claude" })).querySelector<HTMLButtonElement>("[data-usage-alert]")!;
    expect(alert.getAttribute("aria-label")).toBe("Claude: 92% used, resets 3:40 PM");
    flushSync(() => alert.click());
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "toggleSettings", open: true, section: "model" }));
    root!.unmount();
    serve([claude(60)]);
    expect(mount(createElement(UsageAlert, { engine: "claude" })).innerHTML).toBe("");
  });
});

describe("the chat", () => {
  it("offers Retry as before once the reset has passed, or when the engine named no reset", () => {
    const passed = mount(createElement(FailedTurnRow, { tool: failedTurnTool("limit", { limitResetsAt: NOW - 1 }), engine: undefined, botId: "scout", threadId: "t-1", onRetry: vi.fn() }));
    expect(passed.textContent).toContain("Retry");
    expect(passed.textContent).not.toContain("Continue at");
  });
});


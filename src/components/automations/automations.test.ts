// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppTrigger } from "@/lib/app-triggers";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));

const { NewAutomation, defaultBot } = await import("./NewAutomation");
const { TriggersPage } = await import("../TriggersPage");
const { applyAppTriggerSnapshot } = await import("@/lib/app-triggers");

const now = Date.now();
const botA = { id: "bot-a", name: "Scout", threadId: "thread-a", hidden: false, messages: [{ id: "m1", at: now - 5_000 }] } as unknown as Bot;
const botB = { id: "bot-b", name: "Ledger", threadId: "thread-b", hidden: false, messages: [{ id: "m2", at: now - 50_000 }] } as unknown as Bot;
const trigger = (overrides: Partial<AppTrigger> = {}): AppTrigger => ({
  id: "acme", name: "Acme replies", prompt: "Draft a follow-up for the lead.", botId: "bot-a", runOn: "maus", enabled: true,
  app: "gmail", appName: "Gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", eventName: "New Gmail message", delivery: "poll", accountId: "ca_1",
  config: {}, filter: { from: "Acme" }, remote: { triggerId: "ti_1", state: "active" }, received: 0, filtered: 0, createdAt: now, updatedAt: now, ...overrides,
});

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
beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({});
  fixture.state = { hydrated: true, bots: [botA, botB], selectedId: "" };
  applyAppTriggerSnapshot({ triggers: [trigger()], attempts: [], service: { available: true } });
});
afterEach(() => { root?.unmount(); root = null; document.body.innerHTML = ""; });

describe("+ New", () => {
  it("talks to the bot open now, else the one most recently talked to", () => {
    expect(defaultBot([botA, botB], "bot-b")?.id).toBe("bot-b");
    expect(defaultBot([botB, botA], "")?.id).toBe("bot-a");
  });

  it("sends what should happen to that bot as a normal chat message and opens the conversation", () => {
    const onClose = vi.fn();
    const container = mount(createElement(NewAutomation, { initialText: "when a lead writes, draft a reply", onClose, onSetUpYourself: vi.fn() }));
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("e.g. every morning at 9, send me a summary of my inbox");
    expect(container.querySelector('select[aria-label="Who should do it?"]')).not.toBeNull();
    flushSync(() => button(container, "Set it up").click());
    expect(fixture.dispatch).toHaveBeenNthCalledWith(1, { type: "select", id: "bot-a" });
    expect(fixture.dispatch).toHaveBeenNthCalledWith(2, { type: "send", botId: "bot-a", text: "when a lead writes, draft a reply", threadId: "thread-a" });
    expect(onClose).toHaveBeenCalled();
  });

  it("asks no bot question with one bot, and does nothing until something is written", () => {
    fixture.state.bots = [botA];
    const container = mount(createElement(NewAutomation, { onClose: vi.fn(), onSetUpYourself: vi.fn() }));
    expect(container.querySelector("select")).toBeNull();
    expect(button(container, "Set it up").hasAttribute("disabled")).toBe(true);
  });

  it("lets a person set it up themselves: when something happens in an app", () => {
    const onSetUpYourself = vi.fn();
    const container = mount(createElement(NewAutomation, { onClose: vi.fn(), onSetUpYourself }));
    flushSync(() => button(container, "Set it up yourself").click());
    flushSync(() => button(container, "When something happens in an app").click());
    flushSync(() => button(container, "Continue").click());
    expect(onSetUpYourself).toHaveBeenCalledWith("app", "bot-a");
  });
});

describe("the Automations list", () => {
  let container: HTMLElement;
  /** The page, re-rendered from the store each time it changes, as the app's provider would. */
  function mountPage() {
    container = mount(createElement(TriggersPage, { onBack: vi.fn() }));
  }
  const toggle = (name: string) => container.querySelector<HTMLButtonElement>(`[role=switch][aria-label="Turn “${name}” on or off"]`)!;
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-automation="${id}"]`)!;

  it("turns an app-event automation off and back on, showing each answer at once", async () => {
    mountPage();
    fixture.api.mockImplementation(async (_path: unknown, init: unknown) => (init as { body?: string } | undefined)?.body ? { trigger: trigger({ enabled: JSON.parse((init as { body: string }).body).enabled }) } : {});
    expect(toggle("Acme replies").getAttribute("aria-checked")).toBe("true");
    flushSync(() => toggle("Acme replies").click());
    await vi.waitFor(() => expect(row("acme").dataset.automationStatus).toBe("paused"));
    expect(row("acme").textContent).toContain("Paused");
    await vi.waitFor(() => expect(toggle("Acme replies").disabled).toBe(false));
    flushSync(() => toggle("Acme replies").click());
    await vi.waitFor(() => expect(toggle("Acme replies").getAttribute("aria-checked")).toBe("true"));
    expect(row("acme").dataset.automationStatus).toBe("working");
    const writes = fixture.api.mock.calls.filter(([, init]) => (init as { body?: string } | undefined)?.body);
    expect(writes.map(([calledPath, init]) => [calledPath, JSON.parse((init as { body: string }).body)])).toEqual([
      ["/api/app-triggers/acme", { enabled: false }],
      ["/api/app-triggers/acme", { enabled: true }],
    ]);
  });

  it("says why beside the automation when turning it back on is refused, and keeps it off", async () => {
    applyAppTriggerSnapshot({ triggers: [trigger({ enabled: false })], attempts: [], service: { available: true } });
    mountPage();
    fixture.api.mockRejectedValue(new Error("The assigned bot no longer exists"));
    flushSync(() => toggle("Acme replies").click());
    await vi.waitFor(() => expect(row("acme").querySelector("[role=alert]")?.textContent).toBe("The assigned bot no longer exists"));
  });

  it("labels each automation by its name, with what it does beneath, and by what it does when it has no name", () => {
    applyAppTriggerSnapshot({ triggers: [trigger(), trigger({ id: "unnamed", name: " " })], attempts: [], service: { available: true } });
    mountPage();
    expect(row("acme").querySelector("button")!.textContent).toBe("Acme replies");
    expect(row("acme").textContent).toContain("drafts a follow-up for the lead");
    expect(row("unnamed").querySelector("button")!.textContent).toContain("drafts a follow-up for the lead");
  });

  it("lists no automation whose bot is gone", () => {
    applyAppTriggerSnapshot({ triggers: [trigger({ id: "orphan", botId: "deleted-bot" })], attempts: [], service: { available: true } });
    mountPage();
    expect(row("orphan")).toBeNull();
  });
});

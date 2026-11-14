// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type Message } from "@/state/store";

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

const { ApprovalCard } = await import("./ApprovalCard");

const now = Date.now();
const bot = { id: "bot-1", name: "Scout", hidden: false };
const trigger = {
  id: "acme", name: "Acme replies", prompt: "Draft a reply for the order.", botId: "bot-1", runOn: "maus", enabled: true,
  app: "gmail", appName: "Gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", eventName: "New Gmail message", delivery: "poll",
  accountId: "ca_1", config: {}, filter: { from: "Acme" }, remote: { triggerId: "ti_1", state: "active" },
  received: 1, filtered: 0, createdAt: now, updatedAt: now,
};
const base = { version: 1 as const, requestId: "request-1", botId: "bot-1", threadId: "thread-1", createdAt: now };
function card(extra: Partial<NonNullable<Message["card"]>>): Message {
  return {
    id: "card-1", role: "bot", kind: "options", at: now,
    card: { title: "Trigger", subtitle: "", options: [], answered: "allow", dismissed: true, autoApplied: true, requestId: "request-1", ...extra },
  };
}
const appCard = card({ tool: "create_trigger", appTriggerRequest: { ...base, resultId: "acme", operation: { action: "create", trigger: {
  name: "Acme replies", instructions: trigger.prompt, app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE",
} }, undo: { name: "Acme replies" } } });

const render = (message: Message) => renderToStaticMarkup(createElement(ApprovalCard, { bot: { name: "Scout" }, message, threadId: "thread-1" }));
let root: Root | null = null;
/** Mounts the card for real and clicks the button with this label, so the click runs through React as a person's would. */
function click(message: Message, label: string) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(ApprovalCard, { bot: { name: "Scout" }, message, threadId: "thread-1" })));
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`no ${label} button in ${container.innerHTML}`);
  flushSync(() => button.click());
}
afterEach(() => { root?.unmount(); root = null; document.body.innerHTML = ""; });

beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => path.startsWith("/api/app-triggers")
    ? { triggers: [trigger], attempts: [], service: null }
    : {});
  fixture.state = { bots: [bot], groups: [], sections: [] };
});

describe("the chat card a bot-made automation leaves", () => {
  const sentence = "When you get an email from Acme, Scout drafts a reply for the order";

  it("says what was set up in one sentence, and offers Pause, Edit and Undo — never a confirmation", () => {
    const html = render(appCard);
    expect(html).toContain('data-trigger-card="acme"');
    expect(html).toContain(`Set up: ${sentence}`);
    for (const label of ["Pause", "Edit", "Undo"]) expect(html).toContain(`${label}</button>`);
    expect(html).not.toMatch(/TRIGGER ON|Trigger on|Open in Triggers|Confirm/);
  });

  it("pauses through the app-event route and says Paused with Resume once paused", async () => {
    click(appCard, "Pause");
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/app-triggers/acme", expect.objectContaining({ method: "PATCH" })));
  });

  it("undoes through the conversation's undo route with the card's request id", () => {
    click(appCard, "Undo");
    expect(fixture.api).toHaveBeenCalledWith("/api/threads/thread-1/undo", { method: "POST", body: JSON.stringify({ requestId: "request-1" }) });
  });

  it("opens the automation's panel on the Automations page from the sentence itself", () => {
    click(appCard, `Set up: ${sentence}`);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showAutomations", id: "acme" });
  });

  it("collapses to one muted line once undone, or when the automation is gone", () => {
    expect(render({ ...appCard, card: { ...appCard.card!, undone: true } })).toContain("Automation removed · undone");
    fixture.api.mockImplementation(async () => ({}));
    const gone = render(appCard);
    expect(gone).toContain("This automation no longer exists");
    expect(gone).not.toContain("Pause</button>");
  });

  it("never shows an automation whose bot was deleted", () => {
    fixture.state.bots = [];
    expect(render(appCard)).toContain("This automation no longer exists");
  });
});

describe("the chat card a wait with a follow-up leaves", () => {
  const waiting = card({ tool: "wait_until", requestId: "wait-1", waitRequest: { waitId: "wait-1", label: "the build", followUp: "Deploy it." } });
  const cancelShown = () => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Cancel");

  it("cancels through the undo route, and says what to do next when that fails", async () => {
    fixture.api.mockRejectedValueOnce(new ApiError("disk full", 500));
    click(waiting, "Cancel");
    expect(fixture.api).toHaveBeenCalledWith("/api/threads/thread-1/undo", { method: "POST", body: JSON.stringify({ requestId: "wait-1" }) });
    await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent).toBe("Couldn't cancel the wait. Try again, or ask Scout to stop it."));
  });

  it("shows no error when the wait had already ended: its card says how it ended", async () => {
    fixture.api.mockRejectedValueOnce(new ApiError("This wait has already ended.", 409));
    click(waiting, "Cancel");
    await vi.waitFor(() => expect(cancelShown()).toBe(true));
    expect(document.querySelector("[role=alert]")).toBeNull();
  });
});

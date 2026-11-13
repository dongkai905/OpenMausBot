import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_INTENT_ASKED } from "./cloud-setup";
import { EMPTY_ONBOARDING, type OnboardingStatus } from "./onboarding";

const owner = { hosted: false, canSave: true, cloudHome: true };
const record = (extra: Partial<OnboardingStatus> = {}): OnboardingStatus => ({ ...EMPTY_ONBOARDING, ...extra });
const facts = (extra: Record<string, unknown> = {}) => ({ viewer: owner, connected: true, enginesKnown: true, onboarding: record(), reopened: false, ...extra });

async function load(stored: string | null = null) {
  const saved = new Map<string, string>(stored ? [["omb.cloudIntent.pending", stored]] : []);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
    removeItem: (key: string) => { saved.delete(key); },
  });
  vi.resetModules();
  return { module: await import("./cloud-intent"), saved };
}

beforeEach(() => { vi.unstubAllGlobals(); });

describe("cloudIntentDue", () => {
  it("never asks by itself: a new Cloud opens on its welcome, which brings this computer's bots over before any chat exists", async () => {
    const { module } = await load();
    expect(module.cloudIntentDue(facts())).toBe(false);
    expect(module.cloudIntentDue(facts({ onboarding: record({ hintsSeen: [CLOUD_INTENT_ASKED] }) }))).toBe(false);
    expect(module.cloudIntentDue(facts({ onboarding: record({ firstTurnAt: "2026-09-30T08:00:00.000Z" }) }))).toBe(false);
  });

  it("asks when asked for again, only on the owner's own Cloud home, once the Cloud has answered", async () => {
    const { module } = await load();
    expect(module.cloudIntentDue(facts({ reopened: true }))).toBe(true);
    expect(module.cloudIntentDue(facts({ reopened: true, onboarding: record({ hintsSeen: [CLOUD_INTENT_ASKED] }) }))).toBe(true);
    expect(module.cloudIntentDue(facts({ reopened: true, viewer: { hosted: false, canSave: true } }))).toBe(false);
    expect(module.cloudIntentDue(facts({ reopened: true, viewer: { ...owner, canSave: false } }))).toBe(false);
    expect(module.cloudIntentDue(facts({ reopened: true, connected: false }))).toBe(false);
    expect(module.cloudIntentDue(facts({ reopened: true, enginesKnown: false }))).toBe(false);
    expect(module.cloudIntentDue(facts({ reopened: true, onboarding: undefined }))).toBe(false);
  });
});

describe("the waiting job", () => {
  it("is sent as a /setup request", async () => {
    const { module } = await load();
    expect(module.setupMessage("  every morning, the news  ")).toBe("/setup every morning, the news");
  });

  it("waits on this device until an engine can run it, and steps the question aside meanwhile", async () => {
    const { module, saved } = await load();
    const snapshot = () => ({ pending: null, reopened: false, dismissed: false, sent: null });
    expect(module.cloudIntentShown(true, snapshot())).toBe(true);
    module.setPendingIntent("  watch my page  ");
    expect(saved.get("omb.cloudIntent.pending")).toBe("watch my page");
    expect(module.cloudIntentShown(true, { ...snapshot(), pending: "watch my page" })).toBe(false);
    module.setPendingIntent(null);
    expect(saved.has("omb.cloudIntent.pending")).toBe(false);
    const again = await load("watch my page");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    function Probe() { return again.module.useCloudIntent().pending; }
    expect(renderToStaticMarkup(createElement(Probe))).toBe("watch my page");
  });

  it("Skip for now steps aside at once; Give it a job asks again", async () => {
    const { module } = await load();
    expect(module.cloudIntentShown(true, { pending: null, reopened: false, dismissed: true, sent: null })).toBe(false);
    expect(module.cloudIntentShown(false, { pending: null, reopened: true, dismissed: false, sent: null })).toBe(true);
    expect(module.cloudIntentShown(false, { pending: "x", reopened: true, dismissed: false, sent: null })).toBe(true);
  });
});

describe("the job once sent", () => {
  it("is the bot's: it stops waiting in the same step, and the bot is remembered on this device", async () => {
    const { module, saved } = await load("watch my page");
    module.markIntentSent("b2", 1_000_000);
    expect(saved.has("omb.cloudIntent.pending")).toBe(false);
    expect(JSON.parse(saved.get("omb.cloudIntent.sent")!)).toEqual({ botId: "b2", at: 1_000_000 });
  });
});

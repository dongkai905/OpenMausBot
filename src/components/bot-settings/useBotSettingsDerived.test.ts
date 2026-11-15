import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  instances: [] as unknown[],
  config: null as unknown,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, instances: fixture.instances, config: fixture.config }, dispatch: vi.fn() }),
  };
});
vi.mock("../DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: { packaged: false } } }) }));

const { useBotSettingsDerived } = await import("./useBotSettingsDerived");

const bot = { id: "bot-1", threadId: "t", name: "Scout", title: "Scout", description: "", notifications: false, color: "green", unread: false, modelSelection: { instanceId: "engine", model: "m" }, messages: [] } as unknown as Bot;
const engine = (capabilities: Record<string, boolean>) => [{ instanceId: "engine", capabilities } as unknown as InstanceInfo];

function derive() {
  let derived!: ReturnType<typeof useBotSettingsDerived>;
  function Capture() { derived = useBotSettingsDerived(bot); return null; }
  renderToStaticMarkup(createElement(Capture));
  return derived;
}

beforeEach(() => { vi.stubGlobal("window", {}); fixture.instances = []; fixture.config = null; });
afterEach(() => vi.unstubAllGlobals());

describe("connected apps in bot settings", () => {
  it("lets the engine use the workspace's apps through its own app mount", () => {
    fixture.instances = engine({ emailMcp: true });
    expect(derive().canUseConnectedApps).toBe(true);
    fixture.instances = engine({ dataMcp: true });
    expect(derive().canUseConnectedApps).toBe(false);
    fixture.instances = [];
    expect(derive().canUseConnectedApps).toBe(false);
  });

  it("reads the bot's own switch, which is off only when it says so", () => {
    expect(derive().connectedAppsEnabled).toBe(true);
    const off = { ...bot, apps: false };
    let derived!: ReturnType<typeof useBotSettingsDerived>;
    function Capture() { derived = useBotSettingsDerived(off as unknown as Bot); return null; }
    renderToStaticMarkup(createElement(Capture));
    expect(derived.connectedAppsEnabled).toBe(false);
  });
});

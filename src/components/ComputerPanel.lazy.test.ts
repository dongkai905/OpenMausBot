// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  vps: { configured: true, ready: true, container: "running", managed: true, imageMatches: true, problem: null } as Record<string, unknown>,
  posts: [] as string[],
  advanced: true,
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ padClass: undefined }),
  useDesktopCapabilities: () => ({
    ready: true,
    capabilities: {
      host: { platform: "darwin", label: "Host", session: "unknown", packaged: true, homeDir: "/Users/me" },
      windowChrome: "native",
      screenPreview: { available: false, interaction: "none" },
      dictation: { available: false, engine: "none", onDevice: false },
      localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
    },
  }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
// The owner: starting a desktop early is an Admin's shortcut.
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./CloudScreenPreview", () => ({
  CloudScreenPreview: () => createElement("div", { "data-live-screen": "" }),
}));
vi.mock("./AndroidDevicePanel", () => ({ AndroidDevicePanel: () => null, useAndroidUsbDevices: () => ({ devices: [] }) }));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => null }));
vi.mock("./CloudBackendPicker", () => ({ CloudBackendPicker: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") fixture.posts.push(path.split("?")[0]!);
    if (path.startsWith("/api/bots/scout/computer/provision")) {
      fixture.vps = { ...fixture.vps, ready: true, container: "running" };
      return { ready: true, container: "running" };
    }
    if (path.startsWith("/api/bots/scout/computer/screenshot")) return { png: "FRAME", format: "jpeg" };
    if (path.startsWith("/api/bots/scout/computer/control")) return { held: false, helpReason: null };
    if (path.startsWith("/api/bots/scout/computer?")) {
      return { surface: "cloud", backend: "vps", ...fixture.vps };
    }
    return {};
  },
}));

const { ComputerPanel } = await import("./ComputerPanel");
const { BotEditorStore, initialState } = await import("@/state/store");

const engine = {
  instanceId: "claude", driverKind: "customAcp", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  capabilities: { computerMcp: true, browserMcp: true },
} as InstanceInfo;
const makeBot = (patch: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "thread", name: "Scout", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "claude", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
  ...patch,
}) as unknown as Bot;

let root: Root | null = null;
const value = (): Parameters<typeof BotEditorStore>[0]["value"] => ({
  state: { ...initialState, instances: [engine], config: { vps: { configured: true, sshAlias: "alpha" } } as AppState["config"] } as AppState,
  dispatch: vi.fn(),
  flushBotPatches: async () => null,
  refreshInstances: async () => {},
  refreshModels: async () => {},
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const open = async (bot: Bot) => {
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  flushSync(() => root!.render(createElement(BotEditorStore, { value: value(), children: createElement(ComputerPanel, { bot }) })));
  await settle();
};
const text = () => document.body.textContent ?? "";
const spinning = () => document.querySelector(".animate-spin") !== null;
const button = (label: string) => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);

beforeAll(() => {
  vi.stubGlobal("ogb", undefined);
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  fixture.posts.length = 0;
  fixture.vps = { configured: true, ready: true, container: "running", managed: true, imageMatches: true, problem: null };
  fixture.advanced = true;
  vi.useRealTimers();
});

describe("Computer panel on the desktop on your own machine", () => {
  it("shows a running desktop and starts nothing", async () => {
    await open(makeBot({ computer: "cloud" }));
    expect(document.querySelector("[data-live-screen]")).not.toBeNull();
    expect(text()).toContain("Uses your own Linux machine, connected over SSH.");
    expect(fixture.posts.filter((path) => !path.endsWith("/screenshot"))).toEqual([]);
  });

  it("prepares the desktop when the bot manages it and it is not running yet", async () => {
    fixture.vps = { configured: true, ready: false, container: "missing", managed: true, imageMatches: true, problem: null };
    await open(makeBot({ computer: "cloud" }));
    expect(fixture.posts.filter((path) => !path.endsWith("/screenshot"))).toEqual(["/api/bots/scout/computer/provision"]);
    expect(document.querySelector("[data-live-screen]")).not.toBeNull();
  });

  it("says a machine with no alias is not set up, and starts nothing", async () => {
    fixture.vps = { configured: false, ready: false, container: "missing", managed: false, imageMatches: false, problem: null };
    await open(makeBot({ computer: "cloud" }));
    expect(text()).toContain("Add your VPS's SSH alias");
    expect(button("Open VPS settings")).toBeDefined();
    expect(fixture.posts.filter((path) => !path.endsWith("/screenshot"))).toEqual([]);
  });

  it("shows the screen of a desktop a turn moved this conversation to", async () => {
    await open(makeBot({ tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask", surface: "cloud", surfaceAuto: true }] } as Partial<Bot>));
    expect(document.querySelector("[data-live-screen]")).not.toBeNull();
    expect(fixture.posts.filter((path) => !path.endsWith("/screenshot"))).toEqual([]);
  });

  it("in Simple mode too: a running desktop shows its screen and starts nothing", async () => {
    fixture.advanced = false;
    await open(makeBot({ computer: "cloud" }));
    expect(document.querySelector("[data-live-screen]")).not.toBeNull();
    expect(fixture.posts.filter((path) => !path.endsWith("/screenshot"))).toEqual([]);
  });

  it("keeps a chat that is only chatting off the desktop, with no spinner", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await open(makeBot({ computer: "cloud", busy: true }));
    expect(text()).not.toContain("Your bot is using this computer right now");
    expect(spinning()).toBe(false);
    expect(fixture.posts.filter((path) => !path.endsWith("/screenshot"))).toEqual([]);
  });
});

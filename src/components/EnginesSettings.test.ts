import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { EnginesSettings } from "./EnginesSettings";

const fixture = vi.hoisted(() => ({ instances: [] as InstanceInfo[], bots: [] as Bot[], config: undefined as Record<string, unknown> | undefined }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture, refreshInstances: async () => {}, refreshModels: async () => {} }),
}));
afterEach(() => vi.unstubAllGlobals());

const engine = (instanceId: string, driverKind: string, authenticated: boolean, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind, displayName: instanceId, cliDefault: instanceId,
  snapshot: { state: "available", authenticated }, models: { default: "model", options: [] }, ...extra,
});

describe("Settings → Engines", () => {
  it("lists every engine, ready or not, on a card of its own", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    fixture.instances = [engine("first", "customAcp", true), engine("second", "customAcp", false)];
    const html = renderToStaticMarkup(createElement(EnginesSettings));
    expect(html).toContain('data-engine-card="first"');
    expect(html).toContain('data-engine-card="second"');
    expect(html).toContain("Ready");
    expect(html).toContain("Needs setup");
  });

  it("shows the setup card for an engine that is not ready yet", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    fixture.instances = [{ ...engine("second", "customAcp", false), snapshot: { state: "unavailable", reason: "`agent` CLI not found" } }];
    const html = renderToStaticMarkup(createElement(EnginesSettings));
    expect(html).toContain("agent CLI not found");
    expect(html).toContain("Set CLI");
  });

  it("preserves one-click server installs and updates inside engine cards", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    fixture.instances = [{
      instanceId: "agent", displayName: "My Agent", driverKind: "customAcp", cliDefault: "agent",
      snapshot: { state: "unavailable" }, models: { default: "model", options: [] },
      install: { server: { package: "agent-fixture" }, command: { linux: "npm install -g agent-fixture" } },
    }];
    expect(renderToStaticMarkup(createElement(EnginesSettings))).toContain("Install My Agent here");
    fixture.instances[0].snapshot = {
      state: "available", authenticated: true,
      update: { title: "My Agent update available", message: "A newer version is available.", command: "npm install -g agent-fixture@latest" },
    };
    const html = renderToStaticMarkup(createElement(EnginesSettings));
    expect(html).toContain("Update My Agent here");
    expect(html).not.toContain("Install My Agent here");
  });

  it("shows a standing warning from the snapshot without a command to run", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    fixture.instances = [{
      instanceId: "agent", displayName: "My Agent", driverKind: "customAcp", cliDefault: "agent",
      snapshot: {
        state: "available", authenticated: true,
        warning: { title: "Bots inherit this machine's agent setup", message: "OMB_AGENT_INHERIT_USER_CONFIG=1 is set." },
      },
      models: { default: "model", options: [] },
    }];
    const html = renderToStaticMarkup(createElement(EnginesSettings));
    expect(html).toContain("data-engine-warning-notice");
    expect(html).toContain("Bots inherit this machine&#x27;s agent setup");
    expect(html).toContain("OMB_AGENT_INHERIT_USER_CONFIG=1 is set.");
    expect(html).not.toContain("data-engine-update-notice");
    delete fixture.instances[0].snapshot.warning;
    expect(renderToStaticMarkup(createElement(EnginesSettings))).not.toContain("data-engine-warning-notice");
  });

  it("keeps an API-key engine listed after its key is saved, with the key masked and Replace beside it", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    const openai = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
      instanceId: "openai", displayName: "OpenAI", driverKind: "openai", access: "api",
      snapshot, models: { default: "gpt-5", options: [] },
    });
    fixture.instances = [openai({ state: "unavailable", reason: "No API key" })];
    const before = renderToStaticMarkup(createElement(EnginesSettings));
    expect(before).toContain("OpenAI needs an API key");
    expect(before).toContain('data-key-row="openai"');
    expect(before).toContain('placeholder="sk-…"');
    expect(before).not.toContain("data-key-replace");

    fixture.instances = [openai({ state: "available", authenticated: true, version: null })];
    fixture.config = { openai: { configured: true, last4: "a1b2" } };
    const saved = renderToStaticMarkup(createElement(EnginesSettings));
    expect(saved).toContain('data-engine-card="openai"');
    expect(saved).toContain('data-engine-setup-api-key="configured"');
    expect(saved).toContain("OpenAI uses your API key");
    expect(saved).toContain("••••••••a1b2");
    expect(saved).toContain("data-key-replace");
    expect(saved).not.toContain("OpenAI needs an API key");

    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    const remote = renderToStaticMarkup(createElement(EnginesSettings));
    expect(remote).toContain("open Settings → API keys on the computer running MausBot");
    expect(remote).not.toContain("data-key-row");

    vi.stubGlobal("window", {});
    fixture.instances = [{ ...openai({ state: "available", authenticated: true, version: null }), managed: { organizationId: "org", organizationName: "Acme" } }];
    expect(renderToStaticMarkup(createElement(EnginesSettings))).not.toContain("data-key-row");
    fixture.config = undefined;
  });
});

describe("Settings → AI in Simple mode", () => {
  const simple = (open = false) => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    return renderToStaticMarkup(createElement(EnginesSettings, { simple: true, more: { id: "ai-more", open, onToggle: () => {} } }));
  };
  const rows = (html: string) => [...html.matchAll(/data-simple-engine="([^"]+)"/g)].map((match) => match[1]);

  it("lists each ready provider as a row with Manage, and each one to set up with Set up", () => {
    fixture.instances = [
      engine("first", "customAcp", true),
      engine("second", "customAcp", false),
    ];
    const html = simple();
    expect(html).toContain(">Providers</h3>");
    expect(rows(html)).toEqual(["first", "second"]);
    expect(html).toMatch(/data-simple-engine="first"[\s\S]*?>Manage<\/button>/);
    expect(html).toMatch(/data-simple-engine="second"[\s\S]*?>Set up<\/button>/);
  });

  it("folds every other provider under More providers, in the same card, with the count", () => {
    fixture.instances = [engine("first", "customAcp", true), engine("second", "customAcp", false), engine("third", "customAcp", false)];
    expect(simple()).toMatch(/aria-expanded="false"[^>]*>[\s\S]*?More providers[\s\S]*?>2</);
    expect(simple()).not.toContain('data-simple-engine="second"');
    expect(simple(true)).toContain('data-simple-engine="second"');
  });
});

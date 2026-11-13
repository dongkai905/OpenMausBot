import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineSetup, EngineUpdateNotice, installCommandFor, needsCli, needsSignIn } from "./EngineSetup";
import { engineStatus } from "./ModelPickerFull";
import { StoreProvider, type InstanceInfo } from "@/state/store";

afterEach(() => vi.unstubAllGlobals());

it("chooses the server installer even when the client has a different OS", () => {
  vi.stubGlobal("window", { ogb: { platform: "win32" } });
  expect(installCommandFor({ platform: "linux", command: { linux: "linux-install", win32: "windows-install" } })).toBe("linux-install");
  expect(installCommandFor({ platform: "linux", command: { win32: "windows-only" } })).toBeNull();
});

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "kimi",
    driverKind: "customAcp",
    displayName: "Kimi",
    models: { default: "kimi-code/k3", options: [] },
    snapshot,
  };
}

describe("needsCli / needsSignIn", () => {
  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`kimi` CLI not found" });
    expect(needsCli(missing)).toBe(true);
    expect(needsSignIn(missing)).toBe(false);
  });

  it("lets Custom inject run when the CLI is installed but unsigned-in", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(needsCli(unsigned)).toBe(false);
    expect(needsSignIn(unsigned)).toBe(true);
  });

  it("is ready for inject when the CLI is present", () => {
    const ready = instance({ state: "available", authenticated: true, version: "0.36.1" });
    expect(needsCli(ready)).toBe(false);
    expect(needsSignIn(ready)).toBe(false);
  });
});

describe("an engine's setup errors", () => {
  function cliEngine(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
    return {
      ...instance(snapshot),
      instanceId: "agent-four",
      driverKind: "customAcp",
      displayName: "Fixture engine",
      install: {
        command: { linux: "npm install -g @example/fixture-engine", darwin: "npm install -g @example/fixture-engine", win32: "npm install -g @example/fixture-engine" },
      },
    };
  }

  function render(engine: InstanceInfo): string {
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
  }

  it("shows profile failures without claiming the runtime is missing", () => {
    const reason = "Cannot write the fixture engine profile settings (EACCES).";
    const engine = cliEngine({ state: "unavailable", reason });
    const markup = render(engine);
    expect(markup).toContain(reason);
    expect(markup).toContain('role="alert"');
    expect(engineStatus(engine)).toBe("Setup required");
    expect(markup).not.toMatch(/CLI not found|Not installed/);
  });

  it("renders an initialization failure reported by the snapshot", () => {
    const engine = cliEngine({ state: "unavailable", reason: "initialize timed out." });
    expect(render(engine)).toContain("initialize timed out.");
    expect(engineStatus(engine)).toBe("Setup required");
  });

  it("keeps an installed engine's sign-in step, with the command that signs it in", () => {
    const engine: InstanceInfo = {
      ...instance({ state: "available", authenticated: false, version: "1.1.1" }),
      install: {
        command: { linux: "npm install -g kimi-fixture", darwin: "npm install -g kimi-fixture", win32: "npm install -g kimi-fixture" },
        signInCommand: "kimi login",
      },
    };
    const markup = render(engine);
    expect(engineStatus(engine)).toBe("Sign-in required");
    expect(markup).toContain("Sign in to Kimi");
    expect(markup).toContain("kimi login");
    expect(markup).toContain("Check again");
    expect(markup).not.toContain("Install Kimi here");
  });
});

describe("engines set up with a key in Settings", () => {
  it("opens Settings → API keys instead of offering a terminal command", () => {
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    const engine: InstanceInfo = {
      ...instance({ state: "unavailable", reason: "No API key — open Settings → API keys." }),
      instanceId: "local-server",
      driverKind: "customAcp",
      displayName: "Custom agent",
      install: { docsUrl: "https://openrouter.ai/keys", settings: "connections" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
    expect(markup).toContain("Custom agent needs an API key");
    expect(markup).toContain("Open AI › Other services");
    expect(markup).not.toContain("Open install in Terminal");
    expect(markup).not.toContain("config.json");
  });

  it("still offers the install when a key engine's own CLI is missing, and the key in Settings once it is installed", () => {
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    const harness = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
      ...instance(snapshot),
      instanceId: "harness",
      driverKind: "customAcp",
      displayName: "Harness CLI",
      install: {
        command: { linux: "npm install -g @example/harness-cli", darwin: "npm install -g @example/harness-cli", win32: "npm install -g @example/harness-cli" },
        docsUrl: "https://example.test/harness-cli",
        needsNode: true,
        settings: "connections",
      },
    });
    const missing = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: harness({ state: "unavailable", reason: "harness not found" }) })));
    expect(missing).toContain("npm install -g @example/harness-cli");
    expect(missing).not.toContain("needs an API key");
    const keyless = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: harness({ state: "available", authenticated: false, version: "0.2.1" }) })));
    expect(keyless).toContain("Harness CLI needs an API key");
    expect(keyless).toContain("Open AI › Other services");
    expect(keyless).not.toContain("Terminal");
    // No key is saved, so nothing was rejected.
    expect(keyless).not.toContain("rejected the saved key");
  });
});

describe("install from Settings on the server", () => {
  function npmEngine(snapshot: InstanceInfo["snapshot"], server = true): InstanceInfo {
    return {
      ...instance(snapshot),
      install: {
        command: { linux: "npm install -g kimi-fixture", darwin: "npm install -g kimi-fixture", win32: "npm install -g kimi-fixture" },
        needsNode: true,
        signInCommand: "kimi login",
        ...(server ? { server: { package: "kimi-fixture" } } : {}),
      },
    };
  }
  function render(engine: InstanceInfo): string {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
  }

  it("offers one click on the server and keeps the terminal command behind a disclosure", () => {
    const markup = render(npmEngine({ state: "unavailable", reason: "`kimi` CLI not found" }));
    expect(markup).toContain("Install Kimi here");
    expect(markup).toContain("as its own user");
    expect(markup).toContain("Prefer a terminal?");
    expect(markup).toContain("npm install -g kimi-fixture");
    expect(markup).not.toContain("needs");
  });

  it("keeps a quiet setup's probe reason behind Details, in plain grey, never as an alert", () => {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    const reason = "`kimi` isn't installed, or isn't on this app's PATH.";
    const engine = npmEngine({ state: "unavailable", reason });
    const quiet = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine, quiet: true })));
    expect(quiet).toMatch(/<details data-engine-setup-reason="true" class="[^"]*text-ink-tertiary"><summary[^>]*>Details<\/summary><p[^>]*>`kimi` isn&#x27;t installed/);
    expect(quiet).not.toContain('role="alert"');
    expect(quiet).not.toContain("text-danger");
    expect(quiet).toContain("Install Kimi here");
    expect(render(engine)).toMatch(/role="alert" class="[^"]*text-danger">`kimi` isn&#x27;t installed/);
  });

  it("falls back to the terminal command when the server cannot install", () => {
    const markup = render(npmEngine({ state: "unavailable", reason: "`kimi` CLI not found" }, false));
    expect(markup).not.toContain("Install Kimi here");
    expect(markup).toContain("npm install -g kimi-fixture");
  });

  it("offers the vendor's own build on a machine without Node.js, and drops the Node.js line", () => {
    const opencode = (server?: NonNullable<InstanceInfo["install"]>["server"]): InstanceInfo => ({
      ...instance({ state: "unavailable", reason: "`opencode` CLI not found" }),
      instanceId: "opencode",
      driverKind: "customAcp",
      displayName: "OpenCode",
      install: {
        command: { linux: "npm install -g opencode-ai", darwin: "npm install -g opencode-ai", win32: "npm install -g opencode-ai" },
        needsNode: true,
        ...(server ? { server } : {}),
      },
    });
    const standalone = render(opencode({ standalone: { version: "1.19.4", downloadBytes: 79_667_571 } }));
    expect(standalone).toContain("Install OpenCode here");
    expect(standalone).not.toContain("Requires Node.js");
    // No npm on the server, so no npm command to paste into a terminal.
    expect(standalone).not.toContain("npm install -g opencode-ai");
    // Decimal megabytes, as macOS and Windows show file sizes: 79,667,571 bytes is about 80 MB.
    expect(standalone).toContain("About 80 MB download");
    expect(render(opencode({ standalone: { version: "1.19.4", downloadBytes: 64_291_659 } }))).toContain("About 64 MB download");
    const withNpm = render(opencode({ standalone: { version: "1.19.4", downloadBytes: 79_667_571 }, package: "opencode-ai" }));
    expect(withNpm).toContain("Prefer a terminal?");
    expect(withNpm).toContain("npm install -g opencode-ai");
    const neither = render(opencode());
    expect(neither).not.toContain("Install OpenCode here");
    expect(neither).toContain("Requires Node.js");
  });

  it("signs the app's own copy in on the computer that runs it, and installs it again when it breaks", () => {
    const appCopy = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
      ...instance(snapshot),
      instanceId: "agent-three",
      driverKind: "customAcp",
      displayName: "Fixture agent",
      install: {
        command: { linux: "npm install -g fixture-agent", darwin: "npm install -g fixture-agent", win32: "npm install -g fixture-agent" },
        needsNode: true,
        docsUrl: "https://example.test/agent/",
        server: { standalone: { version: "1.19.4", downloadBytes: 64_291_659 } },
        appCopy: true,
      },
    });
    const markup = render(appCopy({ state: "available", authenticated: false, version: "1.19.4" }));
    expect(markup).toContain("Sign in to Fixture agent");
    expect(markup).toContain("Check again");
    expect(markup).toContain("View setup guide");
    // A remote client's Settings has no keys, so it names the computer instead of offering the button.
    vi.stubGlobal("window", { ogb: { platform: "linux", remoteClient: { active: true } } });
    const remote = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: appCopy({ state: "available", authenticated: false, version: "1.19.4" }) })));
    expect(remote).toContain("on the computer running MausBot");
    // Missing or broken, the app's copy is installed again from here.
    expect(render(appCopy({ state: "unavailable", reason: "`fixture-agent` version check failed." }))).toContain("Install Fixture agent here");
  });

  it("never offers an install when only sign-in is missing", () => {
    const markup = render(npmEngine({ state: "available", authenticated: false, version: "1.0.0" }));
    expect(markup).not.toContain("Install Kimi here");
    expect(markup).toContain("kimi login");
  });

  it("turns the update notice into a button when the server can update", () => {
    const update = { title: "Kimi update available", message: "Newer models need it.", command: "npm install -g kimi-fixture@latest" };
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    const withServer = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineUpdateNotice, { update, instance: npmEngine({ state: "available", authenticated: true }) })));
    expect(withServer).toContain("Update Kimi here");
    expect(withServer).toContain("Prefer a terminal?");
    const without = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineUpdateNotice, { update, instance: npmEngine({ state: "available", authenticated: true }, false) })));
    expect(without).not.toContain("Update Kimi here");
    expect(without).toContain("npm install -g kimi-fixture@latest");
  });
});

describe("server device-code sign-in", () => {
  it("explains unavailable hosted plan auth without offering a broken login or install", () => {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    const engine: InstanceInfo = {
      ...instance({ state: "unavailable", authenticated: false, chatgptPlan: true, authenticationUnavailableReason: "Hosted ChatGPT plan access requires approval." }),
      instanceId: "chatgpt", displayName: "ChatGPT plan", driverKind: "customAcp",
      authentication: { method: "browser-pkce" }, install: { command: { linux: "npm install -g @openai/second" }, signInCommand: "second login" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
    expect(markup).toContain("Hosted ChatGPT plan access requires approval.");
    expect(markup).not.toContain("Continue with ChatGPT");
    expect(markup).not.toContain("npm install");
    expect(markup).not.toContain("second login");
  });

  it("does not ask to sign in when installing a CLI for local-model injection", () => {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    const engine: InstanceInfo = {
      ...instance({ state: "available", authenticated: false }),
      authentication: { method: "device-code" },
      install: { command: { linux: "npm install -g @openai/second" }, signInCommand: "second login" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine, intent: "inject" })));
    expect(markup).not.toContain("Connect ChatGPT");
    expect(markup).toContain("npm install");
  });
});

describe("API-key engine setup", () => {
  function keyEngine(instanceId: string, snapshot: InstanceInfo["snapshot"]): InstanceInfo {
    return { ...instance(snapshot), instanceId, driverKind: "customAcp", displayName: "Model provider", access: "api", install: { docsUrl: "https://example.test/keys" } };
  }
  const render = (engine: InstanceInfo, ogb: Record<string, unknown> = { platform: "darwin" }) => {
    vi.stubGlobal("window", { ogb });
    return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
  };

  it("takes a missing key in place, in the same key row as Settings, not in a config file", () => {
    const html = render(keyEngine("openai", { state: "unavailable", reason: "No API key — open Settings → API keys." }));
    expect(html).toContain("data-engine-setup-api-key");
    expect(html).toContain("Model provider needs an API key");
    expect(html).toContain("Paste it here. It saves and checks itself");
    expect(html).toContain('data-key-row="openai"');
    expect(html).not.toContain("Open AI › Other services");
    expect(html).not.toContain("config.json");
  });

  it("says so in the key row when the provider rejected the saved key", () => {
    const html = render(keyEngine("openai", { state: "available", authenticated: false, reason: "The provider rejected this key." }));
    expect(html).toContain("data-engine-setup-api-key");
    expect(html).toContain("Didn&#x27;t work: The provider rejected this key.");
    expect(render(keyEngine("openai", { state: "unavailable" }))).not.toContain("rejected");
  });

  it("still sends an engine with no key row of its own to Settings → API keys", () => {
    const html = render(keyEngine("local-server", { state: "unavailable" }));
    expect(html).toContain("Open AI › Other services");
    expect(html).not.toContain("data-key-row");
  });

  it("has no button on a remote client, whose settings hide the keys", () => {
    const html = render(keyEngine("local-server", { state: "unavailable" }), { platform: "darwin", remoteClient: { active: true } });
    expect(html).toContain("on the computer running MausBot");
    expect(html).not.toContain("Open AI › Other services");
  });

  it("leaves CLI engines on their install card", () => {
    expect(render(instance({ state: "unavailable", reason: "`kimi` CLI not found" }))).not.toContain("data-engine-setup-api-key");
  });
});

// The harness side of the agents tool bridge (drivers/agents-bridge.ts): the
// switch, the one decision for a turn, and what the prompt builder says on
// the strength of it. What the proxy then lists and runs is
// drivers/agents-bridge.test.ts and drivers/agents-proxy.test.ts; its bytes
// are drivers/agents-bridge-wire.test.ts; the mounts that start it unbridged
// are agents-bridge-gates.test.ts; a real turn is agents-bridge.e2e.test.ts.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  AGENTS_PROXY_ENV,
  TOOL_BRIDGE_ENV,
  agentsProxyLaunch,
  agentsToolBridgeEnabled,
  agentsToolBridgeEnv,
  agentsToolBridgeRefusal,
  applyAgentsBridge,
  bridgedAgents,
  bridgedToolTitle,
  engineBridgeRefusal,
  turnEngine,
  type BridgeEngine,
} from "./agents-bridge-switch.ts";
import { parseConfigPatch, parseStoredConfig } from "./config.ts";
import { BRIDGE_HOT_TOOL_NAMES, FIND_TOOL, USE_TOOL } from "./drivers/agents-bridge.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { availableTools } from "./drivers/agents-catalog.ts";
import { WATCHER_OPTIONS_CARD_BOT_ID } from "../shared/options-card.ts";
import { AGENTS_TOOL_BRIDGE_PROMPT, buildSystemPrompt, type PromptPart } from "./system-prompt.ts";

const ON = { features: { agentsToolBridge: true } };
/** The engine a turn runs on. */
const ENGINE: BridgeEngine = { driverKind: "customAcp", version: "1.0.0", cwd: "/tmp/engine" };
const off = { [TOOL_BRIDGE_ENV]: "0" };
// as much of a bot record as the decision reads: one with no tool selection
const bot: { id: string; toolScope?: unknown } = { id: "bot-1" };

describe("the agents tool bridge switch", () => {
  it("is off unless switched on", () => {
    expect(agentsToolBridgeEnabled({}, {})).toBe(false);
    expect(agentsToolBridgeEnabled({ features: {} }, {})).toBe(false);
    expect(agentsToolBridgeEnabled({ features: { agentsToolBridge: false } }, {})).toBe(false);
    expect(agentsToolBridgeEnabled(parseStoredConfig({ features: { skillAuthoring: true, sharedComputers: true } }), {})).toBe(false);
  });

  it("is switched on by the config key or by OMB_AGENTS_TOOL_BRIDGE=1", () => {
    expect(agentsToolBridgeEnabled(ON, {})).toBe(true);
    expect(agentsToolBridgeEnabled({}, { OMB_AGENTS_TOOL_BRIDGE: "1" })).toBe(true);
    expect(TOOL_BRIDGE_ENV).toBe("OMB_AGENTS_TOOL_BRIDGE");
  });

  it("lets the environment override the saved setting either way, and ignores any other value", () => {
    expect(agentsToolBridgeEnabled(ON, { OMB_AGENTS_TOOL_BRIDGE: "0" })).toBe(false);
    expect(agentsToolBridgeEnabled({ features: { agentsToolBridge: false } }, { OMB_AGENTS_TOOL_BRIDGE: "1" })).toBe(true);
    for (const value of ["", "true", "yes", "on", "2"]) {
      expect(agentsToolBridgeEnabled({}, { OMB_AGENTS_TOOL_BRIDGE: value }), value).toBe(false);
      expect(agentsToolBridgeEnabled(ON, { OMB_AGENTS_TOOL_BRIDGE: value }), value).toBe(true);
    }
  });

  it("is a saved setting like the other feature flags: kept by a patch and by the stored file, a boolean only", () => {
    expect(parseConfigPatch({ features: { agentsToolBridge: true } })).toEqual({ features: { agentsToolBridge: true } });
    expect(parseStoredConfig({ features: { agentsToolBridge: true, browser: true } })).toEqual({ features: { agentsToolBridge: true, browser: true } });
    expect(agentsToolBridgeEnabled(parseStoredConfig({ features: { agentsToolBridge: true } }), {})).toBe(true);
    expect(() => parseConfigPatch({ features: { agentsToolBridge: "yes" } })).toThrow("features.agentsToolBridge");
    // the other flags are still read beside it, and an unknown one still drops
    expect(parseConfigPatch({ features: { agentsToolBridge: false, showToolCalls: true, skillRecorder: true } })).toEqual({ features: { agentsToolBridge: false, showToolCalls: true } });
  });
});

describe("which engines a turn is bridged on", () => {
  // The default is no bridge: an engine is bridged only where the harness
  // pre-approves the whole agents server, and the engine left in this build
  // keeps its own permissions.
  it("is no engine: the surviving one keeps its own tool permissions", () => {
    expect(engineBridgeRefusal(ENGINE)).toBe("this engine keeps its own tool permissions");
    expect(agentsToolBridgeRefusal(ON, bot, ENGINE, {})).toBe("this engine keeps its own tool permissions");
    expect(agentsToolBridgeEnv(ON, bot, ENGINE, {})).toEqual(off);
  });

  it("is no engine at all", () => {
    expect(engineBridgeRefusal(undefined)).toBe("no engine");
    expect(agentsToolBridgeEnv(ON, bot, undefined, {})).toEqual(off);
  });

  it("is the switch, whatever the engine", () => {
    expect(agentsToolBridgeRefusal({}, bot, ENGINE, {})).toBe("the switch is off");
    expect(agentsToolBridgeRefusal({}, bot, ENGINE, { OMB_AGENTS_TOOL_BRIDGE: "0" })).toBe("the switch is off");
  });

  it("is never a bot with a tool selection", () => {
    expect(agentsToolBridgeRefusal(ON, { toolScope: { deny: ["mcp:agents:vm_exec"] } }, ENGINE, {})).toBe("the bot has a tool selection");
    expect(agentsToolBridgeEnv(ON, { toolScope: { deny: ["mcp:agents:vm_exec"] } }, ENGINE, {})).toEqual(off);
  });

  it("starts the agents proxy with the bridge off", () => {
    expect(AGENTS_PROXY_ENV[TOOL_BRIDGE_ENV]).toBe("0");
    expect(agentsProxyLaunch()).toEqual({ command: process.execPath, args: [SPAWNED_PROXIES.agents] });
  });
});

describe("the name a bridged call is given", () => {
  const agents = () => ({ command: "node", args: [] as string[], env: { OMB_BOT_ID: "bot-1" } as Record<string, string> });

  it("is its own: no turn is bridged, so a use_tool row is never renamed", () => {
    bridgedAgents("thread", agents(), ON, bot, ENGINE, {});
    const call = { name: "list_triggers", arguments: {} };
    for (const title of ["use_tool", "mcp__agents__use_tool", "agents_use_tool"]) {
      expect(bridgedToolTitle("thread", title, call), title).toBe(title);
    }
    expect(bridgedToolTitle("thread", "mcp__agents__use_tool", { name: "vm_exec" })).toBe("mcp__agents__use_tool");
  });

  it("writes the decision into the turn's integrations", () => {
    const integrations = { agents: agents() };
    applyAgentsBridge("thread", integrations, ON, bot, ENGINE, {});
    expect(integrations.agents.env[TOOL_BRIDGE_ENV]).toBe("0");
  });
});

describe("the engine a turn runs on", () => {
  it("is the live instance, its configs, its last snapshot and its folder", () => {
    expect(turnEngine({ instanceId: "any", driverKind: "customAcp" }, { any: { config: { cli: "echo" }, environment: { HOME: "/tmp" } } }, { version: "1.0.0" }, "/tmp/turn")).toEqual({
      driverKind: "customAcp",
      instanceId: "any",
      config: { cli: "echo" },
      environment: { HOME: "/tmp" },
      version: "1.0.0",
      cwd: "/tmp/turn",
    });
  });

  it("leaves out what is not there", () => {
    expect(turnEngine({ instanceId: "any", driverKind: "customAcp" }, {}, undefined, undefined)).toEqual({ driverKind: "customAcp", instanceId: "any" });
  });
});

describe("what the prompt builder and the Activity log load", () => {
  it("is no engine driver: the rule's text and the question of whether a turn is bridged need none", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const loaded = async (entry: string) => {
      const result = await build({ entryPoints: [join(here, entry)], bundle: true, platform: "node", format: "esm", write: false, metafile: true, logLevel: "silent", packages: "external" });
      return Object.keys(result.metafile.inputs);
    };
    const engineDrivers = /server\/drivers\/(claude|codex|pi|openai-chat|muse-code)\.ts$|server\/drivers\/acp\//;
    for (const entry of ["system-prompt.ts", "activity.ts", "agents-bridge-names.ts", "mcp-gate.ts", "drivers/agents-proxy.ts", "agents-bridge-switch.ts"]) {
      const inputs = await loaded(entry);
      expect(inputs.filter((input) => engineDrivers.test(input)), entry).toEqual([]);
    }
  }, 60_000);
});

describe("the prompt of a bridged turn", () => {
  const parts: PromptPart[] = [
    { id: "routine", label: "Routines", text: " If the user explicitly asks to schedule routines, use list_triggers and create_trigger." },
    { id: "memory", label: "Memory", text: "\nMEMORY: the deploy script lives in scripts/." },
    { id: "credential", label: "Credentials", text: " Use request_credential for a missing key." },
  ];
  const bridged = { env: { OMB_AGENTS_TOOL_BRIDGE: "1", OMB_BOT_ID: "bot-1" } };

  it("is unchanged, to the byte, without the bridge", () => {
    const plain = buildSystemPrompt("You are Kiwi.", "Be brief.", parts);
    expect(buildSystemPrompt("You are Kiwi.", "Be brief.", parts, undefined)).toEqual(plain);
    expect(buildSystemPrompt("You are Kiwi.", "Be brief.", parts, { env: { OMB_AGENTS_TOOL_BRIDGE: "0" } })).toEqual(plain);
    expect(buildSystemPrompt("You are Kiwi.", "Be brief.", parts, { env: {} })).toEqual(plain);
    expect(buildSystemPrompt("You are Kiwi.", "Be brief.", parts, {})).toEqual(plain);
    expect(plain.text).not.toContain(FIND_TOOL);
    expect(plain.sections.map((section) => section.id)).toEqual(["persona", "soul", "routine", "memory", "credential", "reply-habits"]);
  });

  it("has the section only when this turn was asked to bridge, once, right after the soul", () => {
    const built = buildSystemPrompt("You are Kiwi.", "Be brief.", parts, bridged);
    expect(built.sections.map((section) => section.id)).toEqual(["persona", "soul", "tool-bridge", "routine", "memory", "credential", "reply-habits"]);
    const section = built.sections.find((entry) => entry.id === "tool-bridge")!;
    expect(section.text).toBe(AGENTS_TOOL_BRIDGE_PROMPT);
    expect(section.bytes).toBe(Buffer.byteLength(AGENTS_TOOL_BRIDGE_PROMPT, "utf8"));
    expect(built.text.split(AGENTS_TOOL_BRIDGE_PROMPT)).toHaveLength(2);
    // every other section is exactly what it was
    const plain = buildSystemPrompt("You are Kiwi.", "Be brief.", parts);
    expect(built.sections.filter((entry) => entry.id !== "tool-bridge")).toEqual(plain.sections);
    expect(built.text.replace(AGENTS_TOOL_BRIDGE_PROMPT, "")).toBe(plain.text);
    // the decision's own output is what switches it, and it is off for every turn of this build
    for (const [agents, has] of [
      [{ env: { OMB_AGENTS_TOOL_BRIDGE: "1" } }, true],
      [{ env: agentsToolBridgeEnv(ON, bot, ENGINE, {}) }, false],
      [{ env: agentsToolBridgeEnv(ON, { toolScope: { deny: ["mcp:agents:vm_exec"] } }, ENGINE, {}) }, false],
      [{ env: agentsToolBridgeEnv({}, bot, ENGINE, {}) }, false],
    ] as const) {
      expect(buildSystemPrompt("You are Kiwi.", "", parts, agents).sections.some((entry) => entry.id === "tool-bridge")).toBe(has);
    }
  });

  it("never names a tool the bridge may have hidden, so it cannot send a bot to call one directly", () => {
    const everyTool = availableTools({ skillAuthoring: true, sharedComputers: true, voiceNotes: true, cloudHome: false, chief: true, botId: WATCHER_OPTIONS_CARD_BOT_ID }).map((tool) => tool.name);
    expect(everyTool.length).toBeGreaterThan(BRIDGE_HOT_TOOL_NAMES.size);
    for (const tool of everyTool) expect(AGENTS_TOOL_BRIDGE_PROMPT, tool).not.toContain(tool);
  });

  it("reads true when the bridge tools are not in the turn's list after all", () => {
    // A tool selection saved after the prompt was built gives the turn an
    // unbridged proxy at its mount. So nothing is said about find_tool or
    // use_tool except on the condition that they are listed, and what is
    // said without that condition is true of every turn.
    const sentences = AGENTS_TOOL_BRIDGE_PROMPT.trim().split(/(?<=\.)\s+/);
    const aboutTheBridge = sentences.filter((sentence) => sentence.includes(FIND_TOOL) || sentence.includes(USE_TOOL));
    expect(aboutTheBridge).toHaveLength(1);
    expect(aboutTheBridge[0]!.startsWith(`If ${FIND_TOOL} and ${USE_TOOL} are in your tool list, `)).toBe(true);
    expect(sentences.filter((sentence) => !aboutTheBridge.includes(sentence))).toEqual(["A tool that is in your tool list is always called directly."]);
    // one sentence-run, joined to its neighbours like every other section
    expect(AGENTS_TOOL_BRIDGE_PROMPT.startsWith(" ")).toBe(true);
    expect(AGENTS_TOOL_BRIDGE_PROMPT).not.toMatch(/\n/);
  });

  it("sits in the stable half, so a warm engine is not relaunched by it turn after turn", () => {
    const first = buildSystemPrompt("You are Kiwi.", "Be brief.", parts, bridged);
    const later = buildSystemPrompt("You are Kiwi.", "Be brief.", parts.map((part) => part.id === "memory" ? { ...part, text: "\nMEMORY: the deploy script moved to tools/." } : part), bridged);
    expect(first.stable).toContain(AGENTS_TOOL_BRIDGE_PROMPT);
    expect(first.volatile).not.toContain(FIND_TOOL);
    expect(later.stable).toBe(first.stable);
    expect(later.volatile).not.toBe(first.volatile);
    // and it is the same text for every bot and every turn that has it
    expect(buildSystemPrompt("You are Pip.", "", [], { env: { OMB_AGENTS_TOOL_BRIDGE: "1", OMB_CHIEF_OF_STAFF: "1" } }).sections.find((entry) => entry.id === "tool-bridge")!.text).toBe(AGENTS_TOOL_BRIDGE_PROMPT);
  });
});

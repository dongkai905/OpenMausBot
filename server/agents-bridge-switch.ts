// Whether a turn's agents proxy lists its tools through the tool bridge.
// Security invariant: the default is no bridge. A use_tool call reaches the host and the engine as
// use_tool, so a turn is bridged only when nothing judges an agents tool by its own name: the bot has
// no tool selection and its engine pre-approves the whole agents server.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parseToolScope } from "../shared/tool-scope.ts";

import { bridgedCallName } from "./agents-bridge-names.ts";
import { TOOL_BRIDGE_ENV } from "./drivers/agents-bridge.ts";
import { decodeInjectId } from "./drivers/local-inject.ts";
import { onThisNetwork } from "./drivers/openai-compat.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "./proxy-paths.ts";

export { TOOL_BRIDGE_ENV };

/** The command that starts a turn's agents proxy. */
export const agentsProxyLaunch = () => ({ command: process.execPath, args: [SPAWNED_PROXIES.agents] });

/** Every agents proxy's starting environment. The bridge is always set, never inherited: an engine may
 * hand its MCP children this server's environment, where OMB_AGENTS_TOOL_BRIDGE=1 is the operator switch. */
export const AGENTS_PROXY_ENV = { ...AGENTS_NODE_FLAG, [TOOL_BRIDGE_ENV]: "0" } as const;

type BridgeConfig = { features?: { agentsToolBridge?: boolean; claudeUserMcp?: boolean } };

/** The workspace switch: `{"features": {"agentsToolBridge": true}}` in ~/.openmausbot/config.json, or
 * OMB_AGENTS_TOOL_BRIDGE set to exactly "1" or "0", which wins over the saved setting. */
export function agentsToolBridgeEnabled(cfg: BridgeConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env[TOOL_BRIDGE_ENV];
  if (override === "1") return true;
  if (override === "0") return false;
  return cfg.features?.agentsToolBridge === true;
}

/** A model on this machine or network reads the whole list on every turn, out of a small window and at laptop speed:
 * about 15,000 tokens before the person has said anything. OMB_AGENTS_TOOL_BRIDGE=0 still wins. */
function runsLocalModel(bot: { modelSelection?: { model?: unknown } } | null | undefined, engine: BridgeEngine | null | undefined): boolean {
  const model = bot?.modelSelection?.model;
  if (typeof model === "string" && decodeInjectId(model)) return true;
  const url = (engine?.config as { url?: unknown } | undefined)?.url;
  return engine?.driverKind === "openai-compat" && typeof url === "string" && onThisNetwork(url);
}

/** The engine a turn runs on, as far as the decision reads it. */
export interface BridgeEngine {
  driverKind: string;
  instanceId?: string;
  config?: unknown;
  environment?: Record<string, string | undefined>;
  /** The engine CLI's version from the instance's last snapshot; absent before the first one. */
  version?: string | null;
  /** The turn's launch folder; absent when the engine falls back to its default. */
  cwd?: string;
}

/** A turn's engine from its live instance, the instance configs, its last snapshot and its folder. */
export function turnEngine(
  instance: { instanceId: string; driverKind: string },
  configs: Record<string, { config?: unknown; environment?: Record<string, string> } | undefined>,
  snapshot: { version?: string | null } | undefined,
  cwd: string | undefined,
): BridgeEngine {
  const { config, environment } = configs[instance.instanceId] ?? {};
  return {
    driverKind: instance.driverKind,
    instanceId: instance.instanceId,
    ...(config !== undefined ? { config } : {}),
    ...(environment !== undefined ? { environment } : {}),
    ...(snapshot?.version != null ? { version: snapshot.version } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

/** The person's home and managed Claude Code policy files; passed in so a test never reads the real ones. */
export interface EngineHost {
  home: string;
  managedPolicyFiles: readonly string[];
}

const CHAT_RUNTIME_DRIVERS: ReadonlySet<string> = new Set<string>([]);

/** Whether text may name the agents server: it contains `mcp__agents` (a server merely starting so counts
 * too) or `mcp__` then a wildcard. Security: plain substring tests; no pattern is ever built from config text. */
function namesAgentsServer(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("mcp__agents") || lower.includes("mcp__*") || lower.includes("mcp__?");
}

/** Whether a permission rule has a wildcard in its tool name. The Claude CLI globs a deny or ask rule's
 * whole tool name, so `mcp__a*__x` or `*` reaches an agents tool called directly and misses it as use_tool.
 * A wildcard in parentheses is the rule's specifier (`Bash(git *)`); "inside" is one flag set at `(` and
 * cleared at `)`, as the CLI splits a `--disallowedTools` list. */
function wildcardInToolName(rule: string): boolean {
  let inside = false;
  for (const char of rule) {
    if (char === "(") inside = true;
    else if (char === ")") inside = false;
    else if (!inside && (char === "*" || char === "?")) return true;
  }
  return false;
}

/** Why this engine's turns are not bridged, or null. An engine qualifies only when the harness
 * pre-approves the whole agents server and everything the engine reads that could name an agents tool
 * can be read here: Claude Code (claudeRefusal) and the chat runtime, which never asks for an agents
 * tool and reads no per-tool configuration. Left out:
 *   Pi          loads the extensions in the person's home, and an extension's tool_call handler can
 *               block a call by the name it sees.
 *   ACP agents  keep their own permissions: one "always allow" for use_tool would cover every hidden
 *               tool, hidden reads would lose their read-only marks, and Grok has a native use_tool.
 *   the rest    have not been shown to qualify. */
export function engineBridgeRefusal(
  cfg: BridgeConfig,
  engine: BridgeEngine | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  host: EngineHost = { home: homedir(), managedPolicyFiles: [] },
): string | null {
  if (!engine) return "no engine";
  const { driverKind } = engine;
  if (CHAT_RUNTIME_DRIVERS.has(driverKind)) return null;
  return "this engine keeps its own tool permissions";
}

/** Why a turn of `bot` on `engine` is not bridged, or null: the one decision. Security: anything thrown
 * means no bridge, and the log names only the error's class and code, never its message (it may hold a
 * path or file content). */
export function agentsToolBridgeRefusal(
  cfg: BridgeConfig,
  bot: { toolScope?: unknown; modelSelection?: { model?: unknown } } | null | undefined,
  engine: BridgeEngine | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  host?: EngineHost,
): string | null {
  try {
    if (!agentsToolBridgeEnabled(cfg, env) && (env[TOOL_BRIDGE_ENV] === "0" || !runsLocalModel(bot, engine))) return "the switch is off";
    // Security: selection gates match the name in the call, so any selection, even one that permits
    // everything or cannot be read, means no bridge.
    const selection = bot ? parseToolScope(bot.toolScope) : undefined;
    if (selection?.ok !== true || selection.scope !== undefined) return "the bot has a tool selection";
    return engineBridgeRefusal(cfg, engine, env, host);
  } catch (error) {
    const kind = logWord(() => (error instanceof Error ? error.name : typeof error));
    const code = logWord(() => (error as { code?: unknown } | null)?.code, true);
    console.warn(`[agents] the tool bridge decision failed (${kind}${code === null ? "" : ` ${code}`}); the turn is not bridged`);
    return "the decision failed";
  }
}

/** A thrown value's `name` or `code` if it is a short safe word, else "unknown"; with `absent`, a missing value is null. */
function logWord(read: () => unknown, absent = false): string | null {
  try {
    const value = read();
    if (absent && (value === undefined || value === null)) return null;
    return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "unknown";
  } catch {
    return "unknown";
  }
}

/** The decision as the agents proxy's environment entry: "1" or "0", never left out. */
export function agentsToolBridgeEnv(
  cfg: BridgeConfig,
  bot: { toolScope?: unknown; modelSelection?: { model?: unknown } } | null | undefined,
  engine: BridgeEngine | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  host?: EngineHost,
): { [TOOL_BRIDGE_ENV]: "1" | "0" } {
  return { [TOOL_BRIDGE_ENV]: agentsToolBridgeRefusal(cfg, bot, engine, env, host) === null ? "1" : "0" };
}

/** Caps the bridged-thread marks so the set cannot grow with every thread ever bridged. */
export const BRIDGED_THREADS_MAX = 5_000;

/** Threads whose turn in flight was asked to bridge, oldest first; a still-running turn whose mark was
 * dropped shows its rows as use_tool. */
const BRIDGED_THREADS = new Set<string>();

/** A turn's agents integration with its bridge decision written in; no agents tools clears the thread's mark. */
export function bridgedAgents<Agents extends { env: Record<string, string> }>(
  threadId: string,
  agents: Agents | undefined,
  cfg: BridgeConfig,
  bot: { toolScope?: unknown; modelSelection?: { model?: unknown } } | null | undefined,
  engine: BridgeEngine | null | undefined,
  env?: NodeJS.ProcessEnv,
  host?: EngineHost,
): Agents | undefined {
  BRIDGED_THREADS.delete(threadId);
  if (!agents) return undefined;
  const decided = agentsToolBridgeEnv(cfg, bot, engine, env, host);
  if (decided[TOOL_BRIDGE_ENV] === "1") {
    BRIDGED_THREADS.add(threadId);
    if (BRIDGED_THREADS.size > BRIDGED_THREADS_MAX) BRIDGED_THREADS.delete(BRIDGED_THREADS.values().next().value!);
  }
  return { ...agents, env: { ...agents.env, ...decided } };
}

/** Decides a turn and writes the decision into its integrations in place; call once the turn's folder is
 * known and before its prompt is built. */
export function applyAgentsBridge<Agents extends { env: Record<string, string> }>(
  threadId: string,
  integrations: { agents?: Agents },
  cfg: BridgeConfig,
  bot: { toolScope?: unknown; modelSelection?: { model?: unknown } } | null | undefined,
  engine: BridgeEngine | null | undefined,
  env?: NodeJS.ProcessEnv,
  host?: EngineHost,
): void {
  const agents = bridgedAgents(threadId, integrations.agents, cfg, bot, engine, env, host);
  if (agents !== undefined) integrations.agents = agents;
}

/** A tool call's row name: on a bridged turn an agents use_tool naming a catalog tool reads as that tool.
 * Elsewhere use_tool may be another server's (Grok's native one, or one on Codex, whose events omit the server). */
export function bridgedToolTitle(threadId: string, title: string, input: unknown): string {
  return BRIDGED_THREADS.has(threadId) ? bridgedCallName(title, input) : title;
}

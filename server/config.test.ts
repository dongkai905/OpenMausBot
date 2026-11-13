import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { botThreadLimitText, defaultBotThreads, maxConcurrentBotThreads, maxConcurrentChildThreads } from "./bot-thread-limits.ts";
import type { JsonValue } from "./schema.ts";
import { imageSlots } from "./image-generation.ts";

import {
  cacheUntilConfigChanges,
  changedInstanceIds,
  customMcpServers,
  engineLaunches,
  DATA_DIR,
  ensureDirs,
  instanceConfigs,
  isValidSshAlias,
  loadBrowserProfileIdAliases,
  loadConfig,
  localVmIdleTimeoutMinutes,
  localVmMaxInstances,
  localVmMode,
  parseConfigPatch,
  parseStoredConfig,
  persistableInstanceConfigs,
  roomTurnTimeoutMinutes,
  mcpCallTimeoutMinutes,
  threadEventLogMaxBytes,
  threadEventLogRetentionDays,
  showToolCallsEnabled,
  saveConfig,
  skillAuthoringEnabled,
  sharedComputersEnabled,
  builtInBrowserEnabled,
  browserProfilePartitionId,
  browserProfilePartitionTarget,
  browserProfileReplacementConflict,
  browserProfileRoutingConflict,
  stripControlPlaneEnv,
  stripWorkspaceCredentialEnv,
  syncCredentialEnv,
  vpsSshAlias,
  browserEngineAttachCdpUrl,
  withInstanceCli,
  WORKSPACE_CREDENTIAL_ENV,
  type AppConfig,
} from "./config.ts";

const reloaded = (patch: object, cfg: AppConfig = {}) =>
  changedInstanceIds(engineLaunches(instanceConfigs(cfg), {}), engineLaunches(instanceConfigs({ ...cfg, ...patch } as AppConfig), {}));

describe("configuration boundaries", () => {
  it("requires an explicit backup to opt into automatic recovery without reloading engines", () => {
    expect(parseStoredConfig({}).automaticRecovery).toBeUndefined();
    expect(parseConfigPatch({ automaticRecovery: { enabled: false } })).toEqual({ automaticRecovery: { enabled: false } });
    const automaticRecovery = { enabled: true, backup: { instanceId: "codex", model: "backup", effort: "high" } };
    expect(parseStoredConfig({ automaticRecovery }).automaticRecovery).toEqual(automaticRecovery);
    expect(parseConfigPatch({ automaticRecovery }).automaticRecovery).toEqual(automaticRecovery);
    expect(reloaded({ automaticRecovery })).toEqual([]);
    const invalidSettings: JsonValue[] = [{ enabled: true }, { backup: { instanceId: "codex", model: "m" } },
      { enabled: "true" }, { enabled: true, backup: { instanceId: "", model: "m" } },
      { enabled: true, backup: { instanceId: "codex", model: "m", effort: "high", variant: "v" } },
      { enabled: false, maxRetries: 2 }];
    for (const invalid of invalidSettings) {
      expect(() => parseConfigPatch({ automaticRecovery: invalid })).toThrow("automaticRecovery");
    }
  });
  it("accepts shared user context, including clearing, without reloading providers", () => {
    const profile = { aboutMe: "I prefer short answers.\nMy time zone is Europe/Berlin." };
    expect(parseConfigPatch({ profile })).toEqual({ profile });
    expect(parseStoredConfig({ profile })).toEqual({ profile });
    expect(parseConfigPatch({ profile: { aboutMe: "" } })).toEqual({ profile: { aboutMe: "" } });
    expect(reloaded({ profile })).toEqual([]);
    expect(() => parseConfigPatch({ profile: { aboutMe: "x".repeat(24_001) } })).toThrow();
  });
  it("accepts rules for every bot next to About me, including clearing, without reloading providers", () => {
    const everyBotRules = "Answer in British English.\nNever book anything without asking.";
    expect(parseConfigPatch({ everyBotRules })).toEqual({ everyBotRules });
    expect(parseStoredConfig({ everyBotRules })).toEqual({ everyBotRules });
    expect(parseConfigPatch({ everyBotRules: "" })).toEqual({ everyBotRules: "" });
    expect(reloaded({ everyBotRules })).toEqual([]);
    expect(() => parseConfigPatch({ everyBotRules: "x".repeat(24_001) })).toThrow();
  });
  it("keeps the profile photo to a stored attachment picture, never an outside address or SVG", () => {
    const avatarUrl = "/api/attachments/5f0c2b1e-8a43-4c1d-9e7a-2b6f1d3c4e5a.webp";
    expect(parseConfigPatch({ profile: { avatarUrl } })).toEqual({ profile: { avatarUrl } });
    expect(parseStoredConfig({ profile: { name: "Ada", avatarUrl } })).toEqual({ profile: { name: "Ada", avatarUrl } });
    expect(parseConfigPatch({ profile: { avatarUrl: "" } })).toEqual({ profile: { avatarUrl: "" } });
    for (const outside of ["https://tracker.example/me.png", "/api/attachments/me.svg", "javascript:alert(1)", "/api/attachments/../config.json", "data:image/png;base64,AAAA"]) {
      expect(() => parseConfigPatch({ profile: { avatarUrl: outside } }), outside).toThrow();
    }
  });
  it("validates context budgets and keeps changes independent of provider reload", () => {
    const context = { autoCompact: false, compactAt: 0.7, rebuildBytes: 32_000 };
    expect(parseStoredConfig({ context })).toEqual({ context });
    expect(parseConfigPatch({ context })).toEqual({ context });
    expect(reloaded({ context })).toEqual([]);
    for (const value of [0, -1, "10", null, Infinity]) {
      expect(() => parseConfigPatch({ context: { compactAt: value } })).toThrow();
    }
    for (const value of [512, 1_024.1, 1_000_001]) {
      expect(() => parseConfigPatch({ context: { rebuildBytes: value } })).toThrow();
    }
  });
  it("accepts the replay tool-history switch as a boolean, without reloading providers", () => {
    for (const replayToolHistory of [true, false]) {
      const context = { replayToolHistory };
      expect(parseStoredConfig({ context })).toEqual({ context });
      expect(parseConfigPatch({ context })).toEqual({ context });
      expect(reloaded({ context })).toEqual([]);
    }
    for (const value of ["1", 1, "true", null]) {
      expect(() => parseConfigPatch({ context: { replayToolHistory: value } })).toThrow();
    }
  });
  it("keeps Fish Audio and ElevenLabs voice credentials separate", () => {
    const parsed = parseConfigPatch({
      tts: { provider: "fish", key: "eleven-key", fishKey: "fish-key", voice: "fish-voice" },
    });
    expect(parsed.tts).toEqual({
      provider: "fish",
      key: "eleven-key",
      fishKey: "fish-key",
      voice: "fish-voice",
    });
    expect(() => parseConfigPatch({ tts: { provider: "unknown" } })).toThrow("provider");
  });

  it("stores OpenAI readout without changing live-call settings or enabling readout", () => {
    const patch = { tts: { provider: "openai", voice: "marin" }, openai: { key: "fixture-key" } };
    expect(parseConfigPatch(patch)).toEqual(patch);
    expect(parseStoredConfig(patch)).toEqual(patch);
  });

  it("accepts only known Fish Audio speech models", () => {
    for (const fishModel of ["s2.1-pro", "s2.1-pro-free"]) {
      expect(parseConfigPatch({ tts: { fishModel } }).tts).toEqual({ fishModel });
    }
    expect(() => parseConfigPatch({ tts: { fishModel: "s1" } })).toThrow("fishModel");
  });

  it("defaults to what each host holds, and a saved number wins except over a plan's limit", () => {
    const GB = 1024 ** 3;
    const desktop = (gb: number) => ({ memoryGate: false, totalBytes: gb * GB, oneThreadPerBot: false });
    for (const [gb, threads] of [[2, 3], [4, 3], [8, 4], [16, 8], [26, 13], [32, 16], [128, 16]] as const) expect(maxConcurrentBotThreads({}, desktop(gb))).toBe(threads);
    expect(maxConcurrentBotThreads({}, desktop(15.8)), "a 16 GB machine reports a little less").toBe(8);
    for (const gb of [2, 8]) expect(maxConcurrentBotThreads({}, { memoryGate: true, totalBytes: gb * GB, oneThreadPerBot: false }), "the memory gate decides").toBe(16);
    expect(maxConcurrentBotThreads({ threads: { maxConcurrentPerBot: 2 } }, desktop(64))).toBe(2);
    expect(maxConcurrentBotThreads({ threads: { maxConcurrentPerBot: 2 } }, { memoryGate: true, totalBytes: 8 * GB, oneThreadPerBot: false })).toBe(2);
    const starter = { memoryGate: true, totalBytes: 2 * GB, oneThreadPerBot: true };
    expect(maxConcurrentBotThreads({}, starter)).toBe(1);
    expect(maxConcurrentBotThreads({ threads: { maxConcurrentPerBot: 8 } }, starter), "a plan's limit is not a preference").toBe(1);
    expect(maxConcurrentChildThreads({}, starter), "a bot's own turn is never held behind itself").toBe(16);
    expect(maxConcurrentChildThreads({ threads: { maxConcurrentPerBot: 2 } }, desktop(64)), "only a plan's limit lets children through").toBe(2);
    expect(botThreadLimitText({}, starter)).toContain("Starter runs one thread at a time per bot");
    expect(botThreadLimitText({ threads: { maxConcurrentPerBot: 5 } }, desktop(16))).toBe("this bot has reached its limit of 5 parallel threads — wait for one to finish");
    expect(parseStoredConfig({ threads: { maxConcurrentPerBot: 16 } })).toEqual({ threads: { maxConcurrentPerBot: 16 } });
    expect(maxConcurrentBotThreads(parseConfigPatch({ threads: { maxConcurrentPerBot: 1 } }))).toBe(1);
    for (const value of [0, -1, 17, 1.5, "10", null]) {
      expect(() => parseConfigPatch({ threads: { maxConcurrentPerBot: value } })).toThrow("threads.maxConcurrentPerBot");
    }
  });

  it("caps per-thread event logs only when a size is configured", () => {
    expect(threadEventLogMaxBytes({})).toBeNull();
    expect(threadEventLogMaxBytes({ threads: { maxConcurrentPerBot: 3 } })).toBeNull();
    const parsed = parseStoredConfig({ threads: { maxConcurrentPerBot: 3, eventLogMaxBytes: 50 * 1024 * 1024 } });
    expect(threadEventLogMaxBytes(parsed)).toBe(50 * 1024 * 1024);
    expect(parseConfigPatch({ threads: { eventLogMaxBytes: 50 * 1024 * 1024 } })).toEqual({ threads: { eventLogMaxBytes: 50 * 1024 * 1024 } });
    expect(parseConfigPatch({ threads: { eventLogMaxBytes: null } })).toEqual({ threads: { eventLogMaxBytes: null } });
    for (const value of [0, -1, 256 * 1024 - 1, 1.5, "1000"]) {
      expect(() => parseConfigPatch({ threads: { maxConcurrentPerBot: 3, eventLogMaxBytes: value } })).toThrow("threads.eventLogMaxBytes");
    }
  });

  it("keeps thread event logs forever unless a retention window is configured", () => {
    expect(threadEventLogRetentionDays({})).toBeNull();
    expect(threadEventLogRetentionDays(parseStoredConfig({ threads: { maxConcurrentPerBot: 2 } }))).toBeNull();
    const configured = parseStoredConfig({ threads: { maxConcurrentPerBot: 2, eventLogRetentionDays: 30 } });
    expect(threadEventLogRetentionDays(configured)).toBe(30);
    expect(parseConfigPatch({ threads: { eventLogRetentionDays: 30 } })).toEqual({ threads: { eventLogRetentionDays: 30 } });
    expect(parseConfigPatch({ threads: { eventLogRetentionDays: null } })).toEqual({ threads: { eventLogRetentionDays: null } });
    for (const value of [0, -1, 1.5, "30", 3660]) {
      expect(() => parseConfigPatch({ threads: { maxConcurrentPerBot: 2, eventLogRetentionDays: value } })).toThrow("threads.eventLogRetentionDays");
    }
  });

  it("keeps avatar providers and credentials separate, normalizing a router endpoint", () => {
    const parsed = parseConfigPatch({ imageGen: {
      provider: "custom", key: "openai-kept", customApiKey: "router-only",
      customUrl: "http://127.0.0.1:4000/v1/", customModel: " local/image ",
    } });
    expect(parsed.imageGen).toEqual({ primary: { provider: "custom" }, customModel: "local/image", key: "openai-kept", customApiKey: "router-only", customUrl: "http://127.0.0.1:4000/v1" });
    expect(parseStoredConfig({ imageGen: { key: "legacy" } }).imageGen).toEqual({ key: "legacy" });
    expect(() => parseConfigPatch({ imageGen: { provider: "unknown" } })).toThrow("provider");
    expect(parseConfigPatch({ imageGen: { primary: { provider: "gemini", model: " gemini-2.5-flash-image " }, fallback: null, maxPerTurn: 3 } }).imageGen)
      .toEqual({ primary: { provider: "gemini", model: "gemini-2.5-flash-image" }, fallback: null, maxPerTurn: 3 });
    expect(() => parseConfigPatch({ imageGen: { primary: { provider: "cursor" } } })).toThrow("primary");
    expect(() => parseConfigPatch({ imageGen: { maxPerTurn: 11 } })).toThrow("maxPerTurn");
    expect(parseConfigPatch({ imageGen: { provider: "openai" } }).imageGen).toEqual({ primary: { provider: "openai" } });
    for (const pasted of ["sk-or-v1-0123456789abcdef0123456789abcdef", "sk-proj-abcdefghijklmnop", "AIzaSyA-abcdefghijklmnopqrstuvwxyz012"]) {
      expect(() => parseConfigPatch({ imageGen: { primary: { provider: "openrouter", model: pasted } } })).toThrow("API key");
      expect(() => parseConfigPatch({ imageGen: { fallback: { provider: "openai", model: pasted } } })).toThrow("API key");
      expect(() => parseConfigPatch({ imageGen: { provider: "custom", customModel: pasted } })).toThrow("API key");
    }
    expect(parseConfigPatch({ imageGen: { primary: { provider: "openrouter", model: "openai/gpt-image-2" } } }).imageGen).toEqual({ primary: { provider: "openrouter", model: "openai/gpt-image-2" } });
    expect(() => parseConfigPatch({ imageGen: { customUrl: "https://user:secret@router.example/v1" } })).toThrow("customUrl");
    const childEnv = { OMB_CUSTOM_IMAGE_KEY: "must-not-reach-bot" };
    stripWorkspaceCredentialEnv(childEnv);
    expect(childEnv).not.toHaveProperty("OMB_CUSTOM_IMAGE_KEY");
  });
  it("persists a custom domain but excludes it from generic config patches", () => {
    expect(parseStoredConfig({ customDomain: "https://bots.example.com" })).toEqual({ customDomain: "https://bots.example.com" });
    expect(parseConfigPatch({ customDomain: "https://unverified.example.com", language: "en" })).toEqual({ language: "en" });
    expect(parseStoredConfig({ customDomain: "" })).toEqual({ customDomain: "" });
  });
  it("keeps supported stored settings and drops unrelated top-level data", () => {
    expect(
      parseStoredConfig({
        profile: { name: "Ada", email: "ada@example.com" },
        instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
        unrelated: { secret: "not part of the config contract" },
      }),
    ).toEqual({
      profile: { name: "Ada", email: "ada@example.com" },
      instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
    });
  });

  it("loads a config that still has the removed cloud-overflow and idle-release keys, and drops them", () => {
    const stored = {
      language: "en",
      features: { browser: true, computerClaimIdleRelease: true, cloudOverflow: true },
      cloudOverflow: { perSecondCostUsd: 0.0004, idleStopMs: 300_000, allowlistedThreads: ["t1"] },
    };
    expect(parseStoredConfig(stored)).toEqual({ language: "en", features: { browser: true } });
    expect(parseConfigPatch(stored)).toEqual({ language: "en", features: { browser: true } });
  });

  it("loads a config that still switches on chief escalations, and drops the switch", () => {
    const stored = { language: "en", features: { browser: true, chiefEscalations: true } };
    expect(parseStoredConfig(stored)).toEqual({ language: "en", features: { browser: true } });
    expect(parseConfigPatch(stored)).toEqual({ language: "en", features: { browser: true } });
  });

  it("rejects malformed stored instances and API patches", () => {
    expect(() => parseStoredConfig({ instances: { claude: { driver: 42 } } })).toThrow("instances.claude.driver");
    expect(() => parseStoredConfig({ browserProfiles: [{ id: "../evil", name: "Unsafe" }] })).toThrow(
      "browserProfiles.0.id",
    );
    expect(() => parseConfigPatch({ tts: { fishModel: "not-a-voice" } })).toThrow("tts.fishModel");
    expect(() => parseConfigPatch({ profile: [] })).toThrow("profile");
  });

  it("accepts and normalizes a default model selection", () => {
    const input = { defaultModelSelection: { instanceId: " codex ", model: " chosen-model ", effort: "high" } };
    const expected = { defaultModelSelection: { instanceId: "codex", model: "chosen-model", effort: "high" } };
    expect(parseStoredConfig(input)).toEqual(expected);
    expect(parseConfigPatch(input)).toEqual(expected);
  });

  it("accepts a new-bot effort default and clears it with null", () => {
    expect(parseStoredConfig({ newBots: { effort: "medium" } })).toEqual({ newBots: { effort: "medium" } });
    expect(parseConfigPatch({ newBots: { effort: "medium" } })).toEqual({ newBots: { effort: "medium" } });
    expect(parseConfigPatch({ newBots: { effort: null } })).toEqual({ newBots: { effort: null } });
    expect(() => parseConfigPatch({ newBots: { effort: "turbo" } })).toThrow("newBots");
    expect(() => parseConfigPatch({ newBots: { approvalMode: "full" } })).toThrow("newBots");
  });

  it("round-trips an opaque model variant without converting omission to none", () => {
    const defaultModelSelection = { instanceId: "opencodeGo", model: "provider/model", variant: "minimal" };
    expect(parseConfigPatch({ defaultModelSelection })).toEqual({ defaultModelSelection });
    expect(parseStoredConfig({ defaultModelSelection })).toEqual({ defaultModelSelection });
    expect(parseConfigPatch({ defaultModelSelection: { instanceId: "opencodeGo", model: "provider/model" } }))
      .toEqual({ defaultModelSelection: { instanceId: "opencodeGo", model: "provider/model" } });
  });

  it.each<JsonValue>([
    null,
    "codex/model",
    {},
    { instanceId: "codex" },
    { instanceId: "", model: "model" },
    { instanceId: "codex", model: "   " },
    { instanceId: "codex", model: 42 },
    { instanceId: "codex", model: "model", effort: "turbo" },
    { instanceId: "opencodeGo", model: "model", variant: "" },
    { instanceId: "opencodeGo", model: "model", variant: " low " },
    { instanceId: "opencodeGo", model: "model", variant: "low", effort: "high" },
  ])("rejects an invalid default model selection: %j", (defaultModelSelection) => {
    expect(() => parseStoredConfig({ defaultModelSelection })).toThrow("defaultModelSelection");
    expect(() => parseConfigPatch({ defaultModelSelection })).toThrow("defaultModelSelection");
  });


  it("canonicalizes legacy browser profile ids without dropping other stored settings", () => {
    expect(parseStoredConfig({
      profile: { name: "Ada", email: "ada@example.com" },
      rooms: { turnTimeoutMinutes: 20 },
      features: { browser: true },
      browserProfiles: [
        { id: "Work", name: " Work " },
        { id: "Work", name: "Second workspace" },
      ],
      instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
    })).toEqual({
      profile: { name: "Ada", email: "ada@example.com" },
      rooms: { turnTimeoutMinutes: 20 },
      features: { browser: true },
      browserProfiles: [
        { id: "work", name: "Work", partitionId: "Work" },
        { id: "work-2", name: "Second workspace" },
      ],
      instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
    });
  });

  it("preserves an unambiguous uppercase profile's exact durable partition", () => {
    const config = parseStoredConfig({
      browserProfiles: [{ id: "ClientA", name: "Client A" }],
    });
    expect(config.browserProfiles).toEqual([
      { id: "clienta", name: "Client A", partitionId: "ClientA" },
    ]);
    expect(browserProfilePartitionId(config.browserProfiles![0]!)).toBe("ClientA");
    expect(browserProfilePartitionTarget(config, "clienta")).toEqual({
      profileId: "clienta",
      partitionId: "ClientA",
    });
  });

  it("isolates case-colliding legacy profiles instead of sharing an account", () => {
    const config = parseStoredConfig({
      browserProfiles: [
        { id: "Work", name: "Uppercase" },
        { id: "work", name: "Canonical" },
      ],
    });
    expect(config.browserProfiles).toEqual([
      { id: "work-2", name: "Uppercase" },
      { id: "work", name: "Canonical" },
    ]);
    const partitions = config.browserProfiles!.map(browserProfilePartitionId);
    expect(new Set(partitions.map((id) => id.toLowerCase())).size).toBe(partitions.length);
  });

  it("reserves explicit suffix ids while isolating a case collision", () => {
    const config = parseStoredConfig({
      browserProfiles: [
        { id: "Work", name: "Uppercase" },
        { id: "work", name: "Canonical" },
        { id: "work-2", name: "Explicit suffix" },
      ],
    });
    expect(config.browserProfiles).toEqual([
      { id: "work-3", name: "Uppercase" },
      { id: "work", name: "Canonical" },
      { id: "work-2", name: "Explicit suffix" },
    ]);
    const partitions = config.browserProfiles!.map(browserProfilePartitionId);
    expect(new Set(partitions.map((id) => id.toLowerCase())).size).toBe(3);
  });

  it("round-trips migrated partition aliases idempotently", () => {
    const once = parseStoredConfig({
      browserProfiles: [
        { id: "ClientA", name: "Client A" },
        { id: "Personal", name: "Personal" },
      ],
    });
    expect(parseStoredConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("keeps explicit suffix partitions owned by their own canonical profile", () => {
    const once = parseStoredConfig({
      browserProfiles: [
        { id: "Foo", name: "Case collision" },
        { id: "FOO-2", name: "Explicit suffix" },
        { id: "foo", name: "Canonical" },
      ],
    });
    expect(once.browserProfiles).toEqual([
      { id: "foo-3", name: "Case collision" },
      { id: "foo-2", name: "Explicit suffix", partitionId: "FOO-2" },
      { id: "foo", name: "Canonical" },
    ]);
    const profiles = once.browserProfiles!;
    for (const [index, profile] of profiles.entries()) {
      const partition = browserProfilePartitionId(profile).toLowerCase();
      expect(
        profiles.some((candidate, candidateIndex) => candidateIndex !== index && candidate.id === partition),
      ).toBe(false);
    }
    expect(parseStoredConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("keeps legacy Guest isolated from an explicit Guest-2 profile", () => {
    const once = parseStoredConfig({
      browserProfiles: [
        { id: "Guest", name: "Legacy guest account" },
        { id: "Guest-2", name: "Explicit guest suffix" },
      ],
    });
    expect(once.browserProfiles).toEqual([
      { id: "guest-3", name: "Legacy guest account", partitionId: "Guest" },
      { id: "guest-2", name: "Explicit guest suffix", partitionId: "Guest-2" },
    ]);
    expect(parseStoredConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("repairs a prior cross-mapped partition without moving either exact legacy account", () => {
    const path = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({
      browserProfiles: [
        { id: "foo-2", name: "First", partitionId: "foo-2-2" },
        { id: "foo-2-2", name: "Second", partitionId: "FOO-2" },
        { id: "foo", name: "Canonical" },
      ],
    }));
    try {
      const once = loadConfig();
      expect(once.browserProfiles).toEqual([
        { id: "foo-2-3", name: "First", partitionId: "foo-2-2" },
        { id: "foo-2-2-2", name: "Second", partitionId: "FOO-2" },
        { id: "foo", name: "Canonical" },
      ]);
      const aliases = loadBrowserProfileIdAliases();
      const first = browserProfilePartitionTarget(once, aliases.get("foo-2")!);
      const second = browserProfilePartitionTarget(once, aliases.get("foo-2-2")!);
      expect(first).toEqual({ profileId: "foo-2-3", partitionId: "foo-2-2" });
      expect(second).toEqual({ profileId: "foo-2-2-2", partitionId: "FOO-2" });
      // bots.json may be migrated before config.json is rewritten: a second hydration must leave migrated references fixed.
      expect(aliases.get(first!.profileId) ?? first!.profileId).toBe(first!.profileId);
      expect(aliases.get(second!.profileId) ?? second!.profileId).toBe(second!.profileId);
      expect(parseStoredConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("keeps chained partition aliases fixed across repeated raw-config hydration", () => {
    const path = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({
      browserProfiles: [
        { id: "foo", name: "First", partitionId: "Bar" },
        { id: "bar", name: "Second", partitionId: "Baz" },
      ],
    }));
    try {
      const once = loadConfig();
      expect(once.browserProfiles).toEqual([
        { id: "foo", name: "First", partitionId: "Bar" },
        { id: "bar-2", name: "Second", partitionId: "Baz" },
      ]);
      const aliases = loadBrowserProfileIdAliases();
      const hydrate = (id: string) => aliases.get(id) ?? id;
      expect(hydrate("foo")).toBe("foo");
      expect(hydrate(hydrate("foo"))).toBe("foo");
      expect(hydrate("bar")).toBe("bar-2");
      expect(hydrate(hydrate("bar"))).toBe("bar-2");

      const first = browserProfilePartitionTarget(once, hydrate("foo"));
      const second = browserProfilePartitionTarget(once, hydrate("bar"));
      expect(first).toEqual({ profileId: "foo", partitionId: "Bar" });
      expect(second).toEqual({ profileId: "bar-2", partitionId: "Baz" });
      expect(parseStoredConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("blocks a new logical id from claiming another profile's retained partition", () => {
    const profiles = [
      { id: "client-repaired", name: "Existing", partitionId: "Client" },
      { id: "client", name: "New account" },
    ];
    expect(browserProfileRoutingConflict(profiles)).toMatch(/already used by another durable session/i);
  });

  it("blocks same-write reuse of a legacy partition that is being erased", () => {
    expect(browserProfileReplacementConflict(
      [{ id: "legacy-client", name: "Legacy", partitionId: "Client" }],
      [{ id: "client", name: "New account" }],
    )).toMatch(/delete it first, then add/i);
  });

  it("truncates 40-character collision suffixes without stealing an explicit id", () => {
    const base = "a".repeat(40);
    const explicitSuffix = `${"a".repeat(38)}-2`;
    const once = parseStoredConfig({
      browserProfiles: [
        { id: base.toUpperCase(), name: "Case collision" },
        { id: explicitSuffix.toUpperCase(), name: "Explicit suffix" },
        { id: base, name: "Canonical" },
      ],
    });
    expect(once.browserProfiles).toEqual([
      { id: `${"a".repeat(38)}-3`, name: "Case collision" },
      { id: explicitSuffix, name: "Explicit suffix", partitionId: explicitSuffix.toUpperCase() },
      { id: base, name: "Canonical" },
    ]);
    expect(once.browserProfiles!.every((profile) => profile.id.length <= 40)).toBe(true);
    expect(parseStoredConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("accepts only a simple VPS SSH config alias and exposes no credentials", () => {
    expect(isValidSshAlias("production-vps")).toBe(true);
    expect(isValidSshAlias("prod; reboot")).toBe(false);
    expect(() => parseConfigPatch({ vps: { sshAlias: "prod; reboot" } })).toThrow("vps.sshAlias");
    expect(parseConfigPatch({ vps: { sshAlias: "production-vps" } })).toEqual({
      vps: { sshAlias: "production-vps" },
    });
    expect(vpsSshAlias({ vps: { sshAlias: "production-vps" } })).toBe("production-vps");
    expect(vpsSshAlias({ vps: { sshAlias: "-bad" } })).toBeNull();
  });

  it("validates browserEngine.attachCdpUrl as a bare CDP port or an http(s)/ws(s) URL, and forwards it only when configured", () => {
    expect(parseStoredConfig({})).toEqual({});
    expect(browserEngineAttachCdpUrl({})).toBeNull();
    for (const value of ["9333", "1", "65535", "http://127.0.0.1:9333", "https://cdp.internal:9333/", "ws://127.0.0.1:9333/devtools/browser/abc"]) {
      expect(parseStoredConfig({ browserEngine: { attachCdpUrl: value } })).toEqual({ browserEngine: { attachCdpUrl: value } });
      expect(parseConfigPatch({ browserEngine: { attachCdpUrl: value } })).toEqual({ browserEngine: { attachCdpUrl: value } });
      expect(browserEngineAttachCdpUrl({ browserEngine: { attachCdpUrl: value } })).toBe(value);
    }
    for (const value of ["0", "70000", "not-a-url", "ftp://127.0.0.1:9333", "javascript:alert(1)"]) {
      expect(() => parseConfigPatch({ browserEngine: { attachCdpUrl: value } })).toThrow("browserEngine.attachCdpUrl");
    }
    expect(parseConfigPatch({ browserEngine: { attachCdpUrl: "" } })).toEqual({ browserEngine: { attachCdpUrl: "" } });
    expect(browserEngineAttachCdpUrl({ browserEngine: { attachCdpUrl: "" } })).toBeNull();
  });

  it("takes browserEngine.idleTimeoutMinutes as whole minutes up to the engine's own hour", () => {
    for (const value of [1, 10, 60]) {
      expect(parseStoredConfig({ browserEngine: { idleTimeoutMinutes: value } })).toEqual({ browserEngine: { idleTimeoutMinutes: value } });
      expect(parseConfigPatch({ browserEngine: { idleTimeoutMinutes: value } })).toEqual({ browserEngine: { idleTimeoutMinutes: value } });
    }
    for (const value of [0, 61, 2.5, -1, "10"]) expect(() => parseConfigPatch({ browserEngine: { idleTimeoutMinutes: value } })).toThrow();
    expect(parseConfigPatch({ browserEngine: { attachCdpUrl: "9333", idleTimeoutMinutes: 5 } })).toEqual({ browserEngine: { attachCdpUrl: "9333", idleTimeoutMinutes: 5 } });
  });

  it("keeps a browser profile's My Chrome choice through saving, loading and migration, and nothing else", () => {
    const mine = { id: "profile-mine", name: "Mine", browser: "chrome" };
    expect(parseConfigPatch({ browserProfiles: [mine, { id: "profile-work", name: "Work" }] })).toEqual({ browserProfiles: [mine, { id: "profile-work", name: "Work" }] });
    expect(parseStoredConfig({ browserProfiles: [mine] }).browserProfiles).toEqual([mine]);
    expect(parseStoredConfig({ browserProfiles: [{ id: "Mine", name: "Mine", browser: "chrome" }] }).browserProfiles)
      .toEqual([{ id: "mine", name: "Mine", browser: "chrome", partitionId: "Mine" }]);
    for (const browser of ["edge", "firefox", "", true]) {
      expect(() => parseConfigPatch({ browserProfiles: [{ ...mine, browser }] })).toThrow("browserProfiles.0.browser");
    }
  });

  it("accepts a persisted global room turn timeout and supplies the legacy default", () => {
    expect(parseStoredConfig({ rooms: { turnTimeoutMinutes: 20 } })).toEqual({
      rooms: { turnTimeoutMinutes: 20 },
    });
    expect(roomTurnTimeoutMinutes({ rooms: { turnTimeoutMinutes: 20 } })).toBe(20);
    expect(roomTurnTimeoutMinutes({})).toBe(5);
  });

  it.each([0, 1.5, 1441, "20", null])(
    "rejects an invalid room turn timeout: %j",
    (turnTimeoutMinutes) => {
      expect(() => parseConfigPatch({ rooms: { turnTimeoutMinutes } })).toThrow(
        "rooms.turnTimeoutMinutes",
      );
    },
  );

  it("accepts a persisted MCP call timeout and supplies the legacy default", () => {
    expect(parseStoredConfig({ mcp: { callTimeoutMinutes: 30 } })).toEqual({
      mcp: { callTimeoutMinutes: 30 },
    });
    expect(mcpCallTimeoutMinutes({ mcp: { callTimeoutMinutes: 30 } })).toBe(30);
    expect(mcpCallTimeoutMinutes({})).toBe(10);
  });

  it.each([0, 0.5, 61, 1440, "20", null])(
    "rejects an invalid MCP call timeout: %j",
    (callTimeoutMinutes) => {
      expect(() => parseConfigPatch({ mcp: { callTimeoutMinutes } })).toThrow(
        "mcp.callTimeoutMinutes",
      );
    },
  );

  it("rejects unknown keys under the mcp config section", () => {
    expect(() => parseConfigPatch({ mcp: { callTimeoutMinutes: 10, surprise: 1 } })).toThrow("mcp");
  });

  it("preserves shared Local VM behavior by default and accepts bounded per-bot mode", () => {
    expect(localVmMode({})).toBe("shared");
    expect(localVmMaxInstances({})).toBe(2);
    expect(parseConfigPatch({ localVm: { mode: "per-bot", maxInstances: 4 } })).toEqual({
      localVm: { mode: "per-bot", maxInstances: 4 },
    });
    expect(parseConfigPatch({ localVm: { maxInstances: 5 } })).toEqual({
      localVm: { maxInstances: 5 },
    });
    expect(parseConfigPatch({ localVm: { mode: "per-bot", maxInstances: 8 } })).toEqual({
      localVm: { mode: "per-bot", maxInstances: 8 },
    });
    expect(localVmMode({ localVm: { mode: "per-bot" } })).toBe("per-bot");
    expect(localVmMaxInstances({ localVm: { maxInstances: 3 } })).toBe(3);
  });

  it("accepts pool mode with the same bounded seat count", () => {
    expect(parseConfigPatch({ localVm: { mode: "pool", maxInstances: 4 } })).toEqual({
      localVm: { mode: "pool", maxInstances: 4 },
    });
    expect(localVmMode({ localVm: { mode: "pool" } })).toBe("pool");
    expect(localVmMode({})).toBe("shared");
  });

  it("keeps skill authoring on by default with an explicit opt-out, and the browser off by default", () => {
    expect(skillAuthoringEnabled({})).toBe(true);
    expect(skillAuthoringEnabled({ features: {} })).toBe(true);
    expect(skillAuthoringEnabled({ features: { skillAuthoring: true } })).toBe(true);
    expect(parseConfigPatch({ features: { skillAuthoring: false } })).toEqual({
      features: { skillAuthoring: false },
    });
    expect(skillAuthoringEnabled({ features: { skillAuthoring: false } })).toBe(false);
    expect(parseConfigPatch({ features: { skillRecorder: true } })).toEqual({ features: {} });
    expect(builtInBrowserEnabled({})).toBe(true);
    expect(builtInBrowserEnabled({ features: { skillAuthoring: true } })).toBe(true);
    expect(parseConfigPatch({ features: { browser: false } })).toEqual({ features: { browser: false } });
    expect(builtInBrowserEnabled({ features: { browser: false } })).toBe(false);
    expect(builtInBrowserEnabled({ features: { browser: true } })).toBe(true);
    const cloudHome = { OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93" };
    expect(builtInBrowserEnabled({}, { OMB_PUBLIC_URL: "https://selfhosted.example.test" })).toBe(true);
    expect(builtInBrowserEnabled({}, cloudHome)).toBe(true);
    expect(builtInBrowserEnabled({ features: { browser: false } }, cloudHome)).toBe(false);
    expect(parseConfigPatch({ browserProfiles: [{ id: "work", name: " Work " }] })).toEqual({
      browserProfiles: [{ id: "work", name: "Work" }],
    });
    expect(() => parseConfigPatch({ browserProfiles: [{ id: "../evil", name: "x" }] })).toThrow(/browserProfiles.*id/i);
    expect(() => parseConfigPatch({ browserProfiles: [{ id: "Work", name: "Work" }] })).toThrow(/browserProfiles.*id/i);
    expect(() => parseConfigPatch({
      browserProfiles: [{ id: "work", name: "Work", partitionId: "OtherAccount" }],
    })).toThrow(/browserProfiles/i);
    expect(() => parseConfigPatch({ browserProfiles: [{ id: "ok", name: "" }] })).toThrow(/browserProfiles.*name/i);
    expect(() => parseConfigPatch({
      browserProfiles: [{ id: "work", name: "Work" }, { id: "work", name: "Work again" }],
    })).toThrow(/browserProfiles.*id.*duplicated/i);
    expect(() => parseConfigPatch({ features: { skillAuthoring: "yes" } })).toThrow(
      "features.skillAuthoring",
    );
  });

  it("accepts only off, ask and auto for sharing learned skills", () => {
    expect(parseConfigPatch({ features: { shareLearnedSkills: "off" } })).toEqual({ features: { shareLearnedSkills: "off" } });
    expect(() => parseConfigPatch({ features: { shareLearnedSkills: "always" } })).toThrow("features.shareLearnedSkills");
  });

  it("keeps computer sharing off unless config.json explicitly turns it on", () => {
    expect(sharedComputersEnabled({})).toBe(false);
    expect(sharedComputersEnabled({ features: {} })).toBe(false);
    expect(sharedComputersEnabled({ features: { skillAuthoring: true } })).toBe(false);
    expect(sharedComputersEnabled({ features: { sharedComputers: false } })).toBe(false);
    expect(sharedComputersEnabled({ features: { sharedComputers: true } })).toBe(true);
    expect(parseConfigPatch({ features: { sharedComputers: true } })).toEqual({
      features: { sharedComputers: true },
    });
    expect(() => parseConfigPatch({ features: { sharedComputers: "yes" } })).toThrow(
      "features.sharedComputers",
    );
  });

  it("drops the retired routines-in-conversation switch instead of refusing the config", () => {
    expect(parseConfigPatch({ features: { routinesInConversation: true, showToolCalls: true } })).toEqual({
      features: { showToolCalls: true },
    });
  });

  it("keeps tool-call chips off by default and accepts an explicit opt-in", () => {
    expect(showToolCallsEnabled({})).toBe(false);
    expect(parseConfigPatch({ features: { showToolCalls: true } })).toEqual({
      features: { showToolCalls: true },
    });
    expect(showToolCallsEnabled({ features: { showToolCalls: true } })).toBe(true);
  });

  it.each([0, 1.5, 9, "2", null])("rejects an invalid per-bot VM limit: %j", (maxInstances) => {
    expect(() => parseConfigPatch({ localVm: { maxInstances } })).toThrow("localVm.maxInstances");
  });

  it("keeps the 8-hour Local VM idle timeout by default and accepts a bounded override", () => {
    expect(localVmIdleTimeoutMinutes({})).toBe(480);
    expect(localVmIdleTimeoutMinutes({ localVm: { mode: "per-bot" } })).toBe(480);
    expect(parseStoredConfig({ localVm: { mode: "per-bot", maxInstances: 3 } })).toMatchObject({
      localVm: { mode: "per-bot", maxInstances: 3 },
    });
    for (const idleTimeoutMinutes of [5, 30, 1_440]) {
      expect(parseConfigPatch({ localVm: { idleTimeoutMinutes } })).toEqual({ localVm: { idleTimeoutMinutes } });
      expect(localVmIdleTimeoutMinutes({ localVm: { idleTimeoutMinutes } })).toBe(idleTimeoutMinutes);
    }
    expect(parseStoredConfig({ localVm: { idleTimeoutMinutes: 30 } })).toMatchObject({ localVm: { idleTimeoutMinutes: 30 } });
  });

  it.each([0, 4, 1.5, 1_441, "30", null])("rejects an invalid Local VM idle timeout: %j", (idleTimeoutMinutes) => {
    expect(() => parseConfigPatch({ localVm: { idleTimeoutMinutes } })).toThrow("localVm.idleTimeoutMinutes");
    expect(() => parseStoredConfig({ localVm: { idleTimeoutMinutes } })).toThrow("localVm.idleTimeoutMinutes");
  });

  it.each(["one-per-bot", "windows", 1, null])("rejects an invalid Local VM mode: %j", (mode) => {
    expect(() => parseConfigPatch({ localVm: { mode } })).toThrow("localVm.mode");
  });
});

describe("a config.json saved with a byte order mark", () => {
  // Windows PowerShell's Set-Content -Encoding UTF8 and Notepad's "UTF-8 with
  // BOM" put U+FEFF before the first brace, which JSON.parse refuses.
  const bom = "\uFEFF";

  it("loads instead of being ignored", () => {
    const path = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, bom + JSON.stringify({ budgets: { monthlyUsd: 25, warnAtPercent: 70 } }, null, 2));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(loadConfig().budgets).toEqual({ monthlyUsd: 25, warnAtPercent: 70 });
      expect(warn.mock.calls.some(([line]) => String(line).includes("ignoring"))).toBe(false);
    } finally {
      warn.mockRestore();
      rmSync(path, { force: true });
    }
  });

  it("keeps every other key when a setting is saved", () => {
    const path = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, bom + JSON.stringify({
      openrouter: { key: "openrouter-fixture" },
      mcpServers: { notes: { command: "npx", args: ["notes-mcp"] } },
    }, null, 2));
    try {
      saveConfig({ budgets: { monthlyUsd: 25, warnAtPercent: 70 } });
      const disk = JSON.parse(readFileSync(path, "utf8"));
      expect(disk).toMatchObject({
        openrouter: { key: "openrouter-fixture" },
        mcpServers: { notes: { command: "npx", args: ["notes-mcp"] } },
        budgets: { monthlyUsd: 25, warnAtPercent: 70 },
      });
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("keeps the browser's allow-list when the owner flips its local-sites switch", () => {
    const path = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({ browserEngine: { engine: "chrome", egress: { allow: ["10.0.0.5"] } } }));
    try {
      saveConfig({ browserEngine: { egress: { localNetwork: true } } });
      expect(JSON.parse(readFileSync(path, "utf8")).browserEngine).toEqual({ engine: "chrome", egress: { allow: ["10.0.0.5"], localNetwork: true } });
      saveConfig({ browserEngine: { egress: { localNetwork: false } } });
      expect(JSON.parse(readFileSync(path, "utf8")).browserEngine).toEqual({ engine: "chrome", egress: { allow: ["10.0.0.5"], localNetwork: false } });
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("loadConfig between changes", () => {
  it("hands every caller its own copy, and sees a save or an edit made outside the app", () => {
    const path = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    const settle = () => { const past = new Date(Date.now() - 60_000); utimesSync(path, past, past); };
    writeFileSync(path, JSON.stringify({ budgets: { monthlyUsd: 10, warnAtPercent: 50 } }));
    settle();
    try {
      const first = loadConfig();
      first.budgets!.monthlyUsd = 999;
      expect(loadConfig().budgets).toEqual({ monthlyUsd: 10, warnAtPercent: 50 });
      saveConfig({ budgets: { monthlyUsd: 20, warnAtPercent: 50 } });
      settle();
      expect(loadConfig().budgets).toEqual({ monthlyUsd: 20, warnAtPercent: 50 });
      writeFileSync(path, JSON.stringify({ budgets: { monthlyUsd: 30, warnAtPercent: 50 } }));
      settle();
      expect(loadConfig().budgets).toEqual({ monthlyUsd: 30, warnAtPercent: 50 });
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("saving the image providers", () => {
  it("keeps the model typed for Custom when the base moves to another provider and comes back", () => {
    const path = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({}));
    try {
      saveConfig(parseConfigPatch({ imageGen: { primary: { provider: "custom", model: "local/image" } } }));
      saveConfig(parseConfigPatch({ imageGen: { primary: { provider: "openai" } } }));
      saveConfig(parseConfigPatch({ imageGen: { primary: { provider: "custom" } } }));
      expect(imageSlots(JSON.parse(readFileSync(path, "utf8"))).primary).toEqual({ provider: "custom", model: "local/image" });
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("drops a model that was a key once that key is replaced, and refuses a model equal to a saved key", () => {
    const path = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({ imageGen: { customApiKey: "gateway-old", customUrl: "http://127.0.0.1:4000/v1", customModel: "gateway-old",
      primary: { provider: "custom", model: "gateway-old" }, fallback: { provider: "openai", model: "gateway-old" } } }));
    try {
      saveConfig(parseConfigPatch({ imageGen: { customApiKey: "gateway-new" } }));
      const saved = readFileSync(path, "utf8");
      expect(saved).not.toContain("gateway-old");
      expect(imageSlots(JSON.parse(saved)).primary.model).not.toBe("gateway-old");
      expect(() => saveConfig(parseConfigPatch({ imageGen: { primary: { provider: "custom", model: "gateway-new" } } }))).toThrow("API key");
      expect(() => saveConfig(parseConfigPatch({ imageGen: { fallback: { provider: "openrouter", model: "gateway-new" } } }))).toThrow("API key");
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("keeps the base and the keys when the backup is cleared", () => {
    const path = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({ imageGen: { key: "openai-fixture", primary: { provider: "openai" } } }));
    try {
      saveConfig(parseConfigPatch({ imageGen: { fallback: { provider: "openrouter" } } }));
      expect(JSON.parse(readFileSync(path, "utf8")).imageGen).toEqual({ key: "openai-fixture", primary: { provider: "openai" }, fallback: { provider: "openrouter" } });
      saveConfig(parseConfigPatch({ imageGen: { fallback: null } }));
      saveConfig(parseConfigPatch({ imageGen: { fallback: null } }));
      expect(JSON.parse(readFileSync(path, "utf8")).imageGen).toEqual({ key: "openai-fixture", primary: { provider: "openai" } });
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("saving the newer sections", () => {
it("clears a thread event-log knob with null while other keys survive", () => {
    const path = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({}));
    try {
      saveConfig({ threads: { maxConcurrentPerBot: 3, eventLogRetentionDays: 30, eventLogMaxBytes: 50 * 1024 * 1024 } });
      saveConfig({ threads: { eventLogRetentionDays: null } });
      let disk = JSON.parse(readFileSync(path, "utf8"));
      expect(disk.threads).toEqual({ maxConcurrentPerBot: 3, eventLogMaxBytes: 50 * 1024 * 1024 });
      saveConfig({ threads: { eventLogMaxBytes: null } });
      disk = JSON.parse(readFileSync(path, "utf8"));
      expect(disk.threads).toEqual({ maxConcurrentPerBot: 3 });
      expect(parseStoredConfig(disk).threads).toEqual({ maxConcurrentPerBot: 3 });
      expect(threadEventLogRetentionDays(parseStoredConfig(disk))).toBeNull();
      expect(threadEventLogMaxBytes(parseStoredConfig(disk))).toBeNull();
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("seeds what this machine holds when the first threads save is an event-log knob, so an older version can still read the file", () => {
    const path = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({}));
    try {
      saveConfig({ threads: { eventLogRetentionDays: 30 } });
      const disk = JSON.parse(readFileSync(path, "utf8"));
      expect(disk.threads).toEqual({ maxConcurrentPerBot: defaultBotThreads(), eventLogRetentionDays: 30 });
      expect(parseStoredConfig(disk).threads).toEqual({ maxConcurrentPerBot: defaultBotThreads(), eventLogRetentionDays: 30 });
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("default fleet", () => {
  it.each(["openai", "openrouter", "openaiCompat", "claudeApi"])("preserves a custom driver's own routing when its id is %s", (id) => {
    const map = instanceConfigs({
      instances: {
        [id]: { driver: "mistral", config: { url: "https://custom.example.test/v1" }, environment: { MISTRAL_API_KEY: "mistral-own" } },
      },
    });
    expect(map[id].driver).toBe("mistral");
    expect(map[id].config).toEqual({ url: "https://custom.example.test/v1" });
    expect(map[id].environment).toEqual({ MISTRAL_API_KEY: "mistral-own" });
  });

  it.each([
    ["openai", "OMB_OPENAI_API_KEY", "https://api.openai.com/v1"],
    ["openrouter", "OMB_OPENROUTER_API_KEY", "https://openrouter.ai/api/v1"],
  ])("respects same-driver endpoint and credential overrides for %s", (id, keyEnv, defaultUrl) => {
    const workspace = { openai: { key: "openai-WORKSPACE" }, openrouter: { key: "openrouter-WORKSPACE" } };
    for (const config of [
      { url: "https://third-party.example.test/v1" },
      { key: "instance-own" },
      { apiKeyEnv: "INSTANCE_OWN_KEY" },
    ]) {
      const map = instanceConfigs({ ...workspace, instances: { [id]: { driver: "openai-compat", config } } });
      expect(map[id].environment, JSON.stringify(config)).toEqual({});
    }
    const keyed = instanceConfigs({
      ...workspace,
      instances: { [id]: { driver: "openai-compat", environment: { [keyEnv]: "instance-own" } } },
    });
    expect(keyed[id].environment).toEqual({ [keyEnv]: "instance-own" });

    const inherited = instanceConfigs({
      ...workspace,
      instances: { [id]: { driver: "openai-compat", config: { url: `${defaultUrl}/`, apiKeyEnv: keyEnv } } },
    });
    expect(inherited[id].environment).toEqual({ [keyEnv]: workspace[id as "openai" | "openrouter"].key });
  });

it("preserves a per-instance OpenAI-compatible URL override", () => {
    const map = instanceConfigs({
      instances: {
        custom: {
          driver: "openai-compat",
          config: { url: "https://instance.example.test/v1", apiKeyEnv: "CUSTOM_KEY" },
        },
      },
    });
    expect(map.custom.config).toEqual({
      url: "https://instance.example.test/v1",
      apiKeyEnv: "CUSTOM_KEY",
    });
  });

it("does not expand a one-off shadow fleet", () => {
    const map = instanceConfigs({ instances: { ghost: { driver: "not-a-real-driver" } } });
    expect(Object.keys(map)).toEqual(["ghost"]);
  });
});

describe("Instance CLI override", () => {
  it("sets, replaces, and clears config.cli on a default-fleet instance", () => {
    const cfg: AppConfig = {};
    const set = withInstanceCli(cfg, "openai", "/opt/openai/bin/openai");
    expect(set.ok).toBe(true);
    expect(set.config.instances!.openai.config).toEqual({ cli: "/opt/openai/bin/openai" });

    const replaced = withInstanceCli(set.config, "openai", "~/bin/openai");
    expect(replaced.config.instances!.openai.config).toEqual({ cli: "~/bin/openai" });

    const cleared = withInstanceCli(replaced.config, "openai", "");
    expect(cleared.config.instances!.openai.config).toBeUndefined();
  });

  it("preserves sibling config keys when clearing only cli", () => {
    const cfg: AppConfig = {
      instances: { claude: { driver: "claudeAgent", config: { cli: "/x/claude", permissionMode: "bypassPermissions" } } },
    };
    const cleared = withInstanceCli(cfg, "claude", "");
    expect(cleared.config.instances!.claude.config).toEqual({ permissionMode: "bypassPermissions" });
  });

  it("leaves the original config untouched and rejects unknown instances", () => {
    const cfg: AppConfig = { instances: { codex: { driver: "codex" } } };
    const result = withInstanceCli(cfg, "codex", "/new/codex");
    expect(result.config.instances!.codex.config).toEqual({ cli: "/new/codex" });
    expect(cfg.instances!.codex.config).toBeUndefined();

    expect(withInstanceCli(cfg, "nope", "/x").ok).toBe(false);
  });

  it("never persists the credential env instanceConfigs injects", () => {
    const cfg: AppConfig = {
      box: { token: "SECRET-BOAT" },
      instances: {
        claude: { driver: "claudeAgent" },
        grokApi: { driver: "grok" },
        opencode: { driver: "opencodeGo" },
      },
    };
    const set = withInstanceCli(cfg, "claude", "/opt/claude");
    expect(set.ok).toBe(true);
    for (const entry of Object.values(set.config.instances!)) {
      expect(entry.environment ?? {}).toEqual({});
    }
    const custom = { instances: { claude: { driver: "claudeAgent", environment: { MY_FLAG: "1" } } } };
    const kept = withInstanceCli(custom, "claude", "/x");
    expect(kept.config.instances!.claude.environment).toEqual({ MY_FLAG: "1" });
  });

  it("preserves explicit instance credentials even when workspace injection shadows them", () => {
    const cfg: AppConfig = {
      openai: { key: "fixture-shared-openai" },
      instances: {
        ownKey: { driver: "openai-compat", environment: { OMB_OPENAI_API_KEY: "fixture-instance-openai", MY_FLAG: "1" } },
        sameCredential: { driver: "openai-compat", environment: { OMB_OPENAI_API_KEY: "fixture-shared-openai" } },
        openai: { driver: "openai-compat" },
      },
    };
    const instances = persistableInstanceConfigs(cfg);
    expect(instances.ownKey.environment).toEqual({ OMB_OPENAI_API_KEY: "fixture-instance-openai", MY_FLAG: "1" });
    expect(instances.sameCredential.environment).toEqual({ OMB_OPENAI_API_KEY: "fixture-shared-openai" });
    expect(instances.openai.environment).toBeUndefined();
    instances.ownKey.environment!.MY_FLAG = "changed";
    expect(cfg.instances!.ownKey.environment!.MY_FLAG).toBe("1");
  });

});

describe("credential env narrowing", () => {
it("hands no credential to any default-fleet CLI engine, and the Boat key to none at all", () => {
    const cfg: AppConfig = { box: { token: "SECRET-BOAT" } };
    const instances = instanceConfigs(cfg);
    for (const entry of Object.values(instances)) {
      expect(entry.environment).toEqual({});
    }
  });

it("keeps the built-in routing of a provider instance in a saved fleet", () => {
    const instances = instanceConfigs({
      instances: { claude: { driver: "claudeAgent" }, openai: { driver: "openai-compat", displayName: "OpenAI" } },
    });
    expect(instances.openai.config).toEqual({ url: "https://api.openai.com/v1", apiKeyEnv: "OMB_OPENAI_API_KEY", catalog: "openai" });
    expect(instances.openai.environment).toEqual({});
  });

});

describe("legacy feature flag migration", () => {
  const path = join(DATA_DIR, "config.json");
  const readDisk = () => JSON.parse(readFileSync(path, "utf8"));

  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(path, { force: true });
  });
  afterEach(() => {
    rmSync(path, { force: true });
  });

  it("carries a legacy skillRecorder opt-in over to skillAuthoring once, at startup", () => {
    writeFileSync(path, JSON.stringify({ profile: { name: "Ada" }, features: { skillRecorder: true, browser: false } }));
    ensureDirs();
    expect(readDisk()).toEqual({ profile: { name: "Ada" }, features: { browser: false, skillAuthoring: true } });
    expect(skillAuthoringEnabled(loadConfig())).toBe(true);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const written = readFileSync(path, "utf8");
    ensureDirs();
    expect(readFileSync(path, "utf8")).toBe(written);
  });

  it("keeps a legacy opt-out off and removes the old key", () => {
    writeFileSync(path, JSON.stringify({ features: { skillRecorder: false } }));
    ensureDirs();
    expect(readDisk()).toEqual({ features: { skillAuthoring: false } });
    expect(skillAuthoringEnabled(loadConfig())).toBe(false);
  });

  it("lets an explicit skillAuthoring value win over the legacy key", () => {
    writeFileSync(path, JSON.stringify({ features: { skillRecorder: true, skillAuthoring: false } }));
    ensureDirs();
    expect(readDisk()).toEqual({ features: { skillAuthoring: false } });
    expect(skillAuthoringEnabled(loadConfig())).toBe(false);
  });

  it("treats a non-boolean legacy value as off and a null features block as absent", () => {
    writeFileSync(path, JSON.stringify({ features: { skillRecorder: "yes" } }));
    ensureDirs();
    expect(readDisk()).toEqual({ features: { skillAuthoring: false } });
    const nulled = JSON.stringify({ features: null });
    writeFileSync(path, nulled);
    ensureDirs();
    expect(readFileSync(path, "utf8")).toBe(nulled);
  });

  it("leaves a config without the legacy key untouched", () => {
    for (const disk of [{ profile: { name: "Ada" } }, { features: {} }, { features: { skillAuthoring: true } }]) {
      const raw = JSON.stringify(disk);
      writeFileSync(path, raw);
      ensureDirs();
      expect(readFileSync(path, "utf8")).toBe(raw);
    }
  });

  it("does not create a config file or throw on a fresh or unreadable install", () => {
    ensureDirs();
    expect(() => readFileSync(path, "utf8")).toThrow();
    writeFileSync(path, "{not json");
    expect(() => ensureDirs()).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });
});

describe("credential env preference", () => {
  const VARS = [
    "XAI_API_KEY",
    "OMB_GROQ_API_KEY",
    "OMB_META_API_KEY",
    "OPENAI_COMPAT_API_KEY",
    "OPENAI_COMPAT_URL",
    "OPENAI_COMPAT_MODEL",
    "OPENAI_COMPAT_PROVIDER",
    "BOX_TOKEN",
    "OPENCODE_API_KEY",
    "OMB_TTS_KEY",
    "OMB_FISH_AUDIO_API_KEY",
    "OMB_OPENAI_IMAGE_KEY",
    "COMPOSIO_API_KEY",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
    for (const name of VARS) delete process.env[name];
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });
  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });

it("uses a preset voice only when the person has not chosen one or another provider", () => {
    process.env.OMB_TTS_DEFAULT_VOICE = " preset-voice ";
    expect(loadConfig().tts?.voice).toBe("preset-voice");
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ tts: { voice: "chosen" } }));
    expect(loadConfig().tts?.voice).toBe("chosen");
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ tts: { provider: "system" } }));
    expect(loadConfig().tts?.voice).toBeUndefined();
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ tts: { provider: "elevenlabs" } }));
    expect(loadConfig().tts?.voice).toBe("preset-voice");
  });

  it("never takes Cloud Pro's included tokens for the person's own keys, in config or an engine's environment", () => {
    const included = {
      OMB_CLOUD_BOAT_URL: "https://cloud.example.test/api/cloud/services/boat/api/box/v1",
      OMB_CLOUD_BOAT_TOKEN: "box_omb_included-relay-token",
      OMB_CLOUD_VOICE_URL: "https://cloud.example.test/api/cloud/services/voice/v1",
      OMB_CLOUD_VOICE_TOKEN: "omb_voice_included-relay-token",
      OMB_CLOUD_DECIDER_URL: "https://cloud.example.test/api/cloud/services/decider",
      OMB_CLOUD_DECIDER_TOKEN: "omb_decide_included-relay-token",
    };
    for (const [name, value] of Object.entries(included)) vi.stubEnv(name, value);
    try {
      const cfg = loadConfig();
      expect(cfg.box?.token).toBeUndefined();
      expect(cfg.tts?.key).toBeUndefined();
      expect(cfg.decider?.key).toBeUndefined();
      for (const entry of Object.values(instanceConfigs(cfg))) {
        for (const value of Object.values(entry.environment ?? {})) expect(Object.values(included)).not.toContain(value);
      }
      saveConfig({ tts: { voice: "chosen" }, box: { token: "" }, decider: { enabled: true, jobs: { roomRouting: true } } });
      const disk = readFileSync(join(DATA_DIR, "config.json"), "utf8");
      const runtime = JSON.stringify([loadConfig(), instanceConfigs(loadConfig()), persistableInstanceConfigs(loadConfig())]);
      for (const token of [included.OMB_CLOUD_BOAT_TOKEN, included.OMB_CLOUD_VOICE_TOKEN, included.OMB_CLOUD_DECIDER_TOKEN]) {
        expect(disk).not.toContain(token);
        expect(runtime).not.toContain(token);
      }
      process.env.BOX_TOKEN = "box_own";
      process.env.OMB_TTS_KEY = "sk-own";
      expect(loadConfig()).toMatchObject({ box: { token: "box_own" }, tts: { key: "sk-own" } });
      expect(JSON.stringify(instanceConfigs(loadConfig()))).not.toContain("box_own");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("saves and removes the verified domain without replacing existing settings", () => {
    saveConfig({ profile: { name: "Workspace owner" }, customDomain: "https://bots.example.com" });
    expect(loadConfig().customDomain).toBe("https://bots.example.com");
    saveConfig({ language: "en" });
    expect(loadConfig().customDomain).toBe("https://bots.example.com");
    saveConfig({ customDomain: "" });
    expect(loadConfig()).toMatchObject({ customDomain: "", language: "en", profile: { name: "Workspace owner" } });
  });

  it("saves, trims and clears the computer name a paired phone shows", () => {
    expect(parseConfigPatch({ computerName: "  AdamPC  " })).toEqual({ computerName: "AdamPC" });
    expect(() => parseConfigPatch({ computerName: "x".repeat(64) })).toThrow();
    saveConfig({ profile: { name: "Workspace owner" }, computerName: "AdamPC" });
    expect(loadConfig()).toMatchObject({ computerName: "AdamPC", profile: { name: "Workspace owner" } });
    saveConfig({ computerName: "" });
    expect(loadConfig()).toMatchObject({ computerName: "", profile: { name: "Workspace owner" } });
  });

  it("merges onboarding progress like any other section", () => {
    saveConfig({ onboarding: { completedAt: "2026-09-09T10:00:00.000Z", version: 1 } });
    saveConfig({ onboarding: { hintsSeen: ["computer"] } });
    expect(loadConfig().onboarding).toEqual({
      completedAt: "2026-09-09T10:00:00.000Z",
      version: 1,
      hintsSeen: ["computer"],
    });
    expect(() => parseConfigPatch({ onboarding: { hintsSeen: ["x".repeat(61)] } })).toThrow();
    expect(() => parseConfigPatch({ onboarding: { unknown: true } })).toThrow();
  });

  it("replaces automatic recovery atomically, clears an omitted backup and keeps unrelated settings", () => {
    const backup = { instanceId: "codex", model: "backup", effort: "high" as const };
    saveConfig({ automaticRecovery: { enabled: true, backup }, profile: { name: "Recovery fixture" } });
    expect(loadConfig().automaticRecovery).toEqual({ enabled: true, backup });
    saveConfig({ automaticRecovery: { enabled: true, backup: { instanceId: "claude", model: "other" } } });
    expect(loadConfig().automaticRecovery).toEqual({ enabled: true, backup: { instanceId: "claude", model: "other" } });
    expect(() => saveConfig({ automaticRecovery: { enabled: true } })).toThrow();
    expect(loadConfig().automaticRecovery?.backup?.model).toBe("other");
    saveConfig({ automaticRecovery: { enabled: false } });
    expect(loadConfig().automaticRecovery).toEqual({ enabled: false });
    expect(loadConfig().profile).toEqual({ name: "Recovery fixture" });
  });

  it("persists a context change without losing the other context preferences", () => {
    saveConfig({ context: { rebuildBytes: 32_000, autoCompact: false } });
    saveConfig({ context: { compactAt: 0.75 } });
    expect(loadConfig().context).toEqual({ rebuildBytes: 32_000, autoCompact: false, compactAt: 0.75 });
  });

  it("persists the replay tool-history switch beside the other context preferences", () => {
    saveConfig({ context: { rebuildBytes: 32_000 } });
    expect(loadConfig().context?.replayToolHistory).toBeUndefined();
    saveConfig({ context: { replayToolHistory: true } });
    expect(loadConfig().context).toEqual({ rebuildBytes: 32_000, replayToolHistory: true });
  });

  it("falls back to the config file when the env var is unset (dev mode)", () => {
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({ tts: { key: "file-tts" }, imageGen: { key: "file-image" } }),
    );
    const cfg = loadConfig();
    expect(cfg.tts?.key).toBe("file-tts");
    expect(cfg.imageGen?.key).toBe("file-image");
  });

  it("persists a default selection without changing the fleet or unrelated settings", () => {
    const path = join(DATA_DIR, "config.json");
    const existing = {
      profile: { name: "Ada" },
      instances: { customCodex: { driver: "codex", config: { cli: "/opt/custom-codex" } } },
      openaiCompat: { key: "fixture-key", url: "https://models.example.test/v1" },
      futureSetting: { keep: true },
    };
    writeFileSync(path, JSON.stringify(existing));
    const selection = { instanceId: "customCodex", model: "fixture-model", effort: "high" as const };

    saveConfig({ defaultModelSelection: selection });
    expect(loadConfig().defaultModelSelection).toEqual(selection);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...existing, defaultModelSelection: selection });

    saveConfig({ profile: { email: "ada@example.com" } });
    expect(loadConfig().defaultModelSelection).toEqual(selection);

    const replacement = { instanceId: "claude", model: "different-model" };
    saveConfig({ defaultModelSelection: replacement });
    expect(loadConfig().defaultModelSelection).toEqual(replacement);
    expect(loadConfig().profile).toEqual({ name: "Ada", email: "ada@example.com" });
    expect(loadConfig().instances).toEqual(existing.instances);
  });

  it("rejects oversized default model changes before writing the template", () => {
    saveConfig({ newBotDefaults: { profile: { modelSelection: { instanceId: "codex", model: "valid" } }, memory: {}, skills: [], routines: [] } });
    const path = join(DATA_DIR, "config.json");
    const before = readFileSync(path, "utf8");
    for (const selection of [{ instanceId: "x".repeat(201), model: "valid" }, { instanceId: "codex", model: "x".repeat(501) }]) {
      expect(() => saveConfig({ defaultModelSelection: selection })).toThrow();
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(loadConfig().newBotDefaults?.profile.modelSelection?.model).toBe("valid");
    }
  });

  it("rejects a valid model selection that would overflow the complete defaults template", () => {
    const defaults = { profile: { modelSelection: { instanceId: "codex", model: "valid" } },
      memory: { "memory/a.md": "a".repeat(225_000), "memory/b.md": "b".repeat(225_000),
        "memory/c.md": "c".repeat(225_000), "memory/d.md": "" }, skills: [], routines: [] };
    defaults.memory["memory/d.md"] = "d".repeat(899_990 - Buffer.byteLength(JSON.stringify(defaults), "utf8"));
    saveConfig({ newBotDefaults: defaults });
    const path = join(DATA_DIR, "config.json");
    const before = readFileSync(path, "utf8");
    expect(() => saveConfig({ defaultModelSelection: { instanceId: "codex", model: "m".repeat(500) } })).toThrow("900 KB");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(loadConfig().newBotDefaults).toEqual(defaults);
  });

  it("replaces instance membership and known settings while preserving retained extension fields", () => {
    const path = join(DATA_DIR, "config.json");
    writeFileSync(path, JSON.stringify({
      instances: {
        retained: {
          driver: "fixture-future-driver",
          displayName: "Old label",
          environment: { FIXTURE_TOKEN: "fixture-stored-token" },
          config: { cli: "/fixture/old-cli" },
          futureSetting: { keep: true },
        },
        removed: { driver: "fixture-removed-driver", futureSetting: { remove: true } },
      },
    }));
    const instances = persistableInstanceConfigs(loadConfig());
    delete instances.removed;
    delete instances.retained.displayName;
    delete instances.retained.environment;
    delete instances.retained.config;

    saveConfig({ instances }, { replaceInstances: true });
    expect(JSON.parse(readFileSync(path, "utf8")).instances).toEqual({
      retained: { driver: "fixture-future-driver", futureSetting: { keep: true } },
    });

    saveConfig({ instances: {} }, { replaceInstances: true });
    expect(JSON.parse(readFileSync(path, "utf8")).instances).toEqual({});
  });

  it("preserves explicit instance URLs on unrelated saves", () => {
    const path = join(DATA_DIR, "config.json");
    const entry = { driver: "openai-compat", config: { url: "https://explicit.example.test/v1" } };
    writeFileSync(path, JSON.stringify({ instances: { openaiCompat: entry } }));
    saveConfig({ openai: { key: "fixture-replacement" }, profile: { name: "Fixture" } });
    expect(JSON.parse(readFileSync(path, "utf8")).instances.openaiCompat).toEqual(entry);
  });

  it("loads legacy browser profiles without resetting config and canonicalizes them on the next write", () => {
    const path = join(DATA_DIR, "config.json");
    writeFileSync(path, JSON.stringify({
      postiz: { key: "file-postiz", url: "https://api.example.test/v1" },
      profile: { name: "Ada" },
      features: { browser: true },
      browserProfiles: [
        { id: "Client", name: "Client one" },
        { id: "Client", name: "Client two" },
      ],
      futureSetting: { keep: true },
    }));

    expect(loadConfig()).toMatchObject({
      profile: { name: "Ada" },
      features: { browser: true },
      browserProfiles: [
        { id: "client", name: "Client one", partitionId: "Client" },
        { id: "client-2", name: "Client two" },
      ],
    });

    saveConfig({ features: { showToolCalls: true } });
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    expect(persisted).toMatchObject({
      postiz: { key: "file-postiz", url: "https://api.example.test/v1" },
      profile: { name: "Ada" },
      features: { browser: true, showToolCalls: true },
      browserProfiles: [
        { id: "client", name: "Client one", partitionId: "Client" },
        { id: "client-2", name: "Client two" },
      ],
      futureSetting: { keep: true },
    });

    saveConfig({ browserProfiles: [
      { id: "client", name: "Renamed client" },
      { id: "client-2", name: "Client two" },
    ] });
    const renamed = JSON.parse(readFileSync(path, "utf8"));
    expect(renamed.browserProfiles).toEqual([
      { id: "client", name: "Renamed client", partitionId: "Client" },
      { id: "client-2", name: "Client two" },
    ]);
  });

  it("treats a blanked file field as absent when env supplies the secret", () => {
    // The desktop shell may leave "" behind (a key cleared mid-session); the env-injected value must still win.
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ composio: { apiKey: "" } }));
    process.env.COMPOSIO_API_KEY = "env-composio";
    expect(loadConfig().composio?.apiKey).toBe("env-composio");
  });

  it("syncCredentialEnv keeps process.env in step with a credential save", () => {
    process.env.BOX_TOKEN = "boot-injected";
    process.env.COMPOSIO_API_KEY = "boot-injected";
    syncCredentialEnv({
      composio: { apiKey: "ak_just_saved" },
      box: { token: "" },
      profile: { name: "Ada" },
    });
    expect(process.env.COMPOSIO_API_KEY).toBe("ak_just_saved");
    expect(process.env.BOX_TOKEN).toBeUndefined();
    expect(process.env.OMB_TTS_KEY).toBeUndefined();
    expect(process.env.OMB_FISH_AUDIO_API_KEY).toBeUndefined();
  });

it("syncCredentialEnv updates Fish Audio without replacing ElevenLabs", () => {
    process.env.OMB_TTS_KEY = "eleven-kept";
    process.env.OMB_FISH_AUDIO_API_KEY = "fish-old";
    syncCredentialEnv({ tts: { fishKey: "fish-new" } });
    expect(process.env.OMB_TTS_KEY).toBe("eleven-kept");
    expect(process.env.OMB_FISH_AUDIO_API_KEY).toBe("fish-new");
  });

});

describe("workspace credential env strip", () => {
  it("removes every workspace credential from a child env in place", () => {
    const env = {
      PATH: "/usr/bin",
      MY_FLAG: "1",
      ...Object.fromEntries(WORKSPACE_CREDENTIAL_ENV.map((name) => [name, "secret"])),
    };
    stripWorkspaceCredentialEnv(env);
    expect(env).toEqual({ PATH: "/usr/bin", MY_FLAG: "1" });
  });

  it("keeps a hosted tenant's control-plane secrets out of every child env, and only those", () => {
    // What a hosting control plane and a fleet put in the server's env; OMB_CLOUD_FUTURE_SECRET stands for a name added later.
    const operator = {
      OMB_CLOUD_READY_TOKEN: "ready", OMB_CLOUD_BOOTSTRAP: "bootstrap", OMB_CLOUD_GATEWAY_TOKEN: "gateway",
      OMB_CLOUD_MODELS: "models", OMB_CLOUD_REVISION: "revision", OMB_CLOUD_FUTURE_SECRET: "later",
      OMB_LICENSE_KEY: "license", OMB_INSTALLATION_CREDENTIAL: "fleet", omb_cloud_ready_token: "windows-spelling",
    };
    // What an engine deliberately receives (the hosted model token as its provider key), plus look-alike names.
    const engine = {
      PATH: "/usr/bin", ANTHROPIC_API_KEY: "hosted-token", ANTHROPIC_AUTH_TOKEN: "hosted-token",
      ANTHROPIC_BASE_URL: "https://admin.example.test/api/gateway/w/anthropic", OPENMAUSBOT_COMPANY_API_KEY: "hosted-token",
      OMB_MANAGED_CODEX_TOKEN: "hosted-token", CODEX_HOME: "/data/codex", OMB_HOOK_TOKEN_FILE: "/data/hook-tokens/a.token",
      OMB_CLOUDFLARED_PATH: "/usr/local/bin/cloudflared", OMB_CLOUD: "not-prefixed", MY_OMB_CLOUD_NOTE: "user",
    };
    for (const strip of [stripControlPlaneEnv, stripWorkspaceCredentialEnv]) {
      const env: Record<string, string | undefined> = { ...operator, ...engine };
      strip(env);
      expect(env).toEqual(engine);
    }
  });

  it("covers in-process secrets and private app-state paths", () => {
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("BOX_TOKEN");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_TTS_KEY");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_CLOUD_BOAT_TOKEN");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_CLOUD_VOICE_TOKEN");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_CLOUD_DECIDER_TOKEN");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_CLOUD_AI_TOKEN");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_FISH_AUDIO_API_KEY");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_OPENAI_IMAGE_KEY");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_BROWSER_CONNECTION");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_USER_DATA");
  });
});

describe("customMcpServers", () => {
  const cfg = (mcpServers: Record<string, unknown>) =>
    ({ mcpServers }) as Parameters<typeof customMcpServers>[0];

  it("normalizes a valid stdio entry and defaults args/env", () => {
    expect(
      customMcpServers(
        cfg({
          notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: { NOTES_TOKEN: "t" } },
          bare: { command: "/usr/local/bin/server" },
        }),
      ),
    ).toEqual({
      notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: { NOTES_TOKEN: "t" } },
      bare: { command: "/usr/local/bin/server", args: [], env: {} },
    });
  });

  it("returns {} when the section is absent", () => {
    expect(customMcpServers({} as Parameters<typeof customMcpServers>[0])).toEqual({});
  });

  it("narrows to a bot's own list when one is given, and to nothing for an empty list", () => {
    const all = cfg({ notes: { command: "a" }, linear: { command: "b" }, off: { command: "c", enabled: false } });
    expect(Object.keys(customMcpServers(all))).toEqual(["notes", "linear"]);
    expect(Object.keys(customMcpServers(all, ["linear", "gone"]))).toEqual(["linear"]);
    expect(customMcpServers(all, [])).toEqual({});
    expect(customMcpServers(all, ["off"])).toEqual({});
  });

  it("skips disabled entries silently", () => {
    expect(customMcpServers(cfg({ off: { command: "x", enabled: false } }))).toEqual({});
  });

  it("skips reserved names — a custom entry can never shadow a built-in", () => {
    const out = customMcpServers(
      cfg({
        ogb: { command: "evil" },
        computer: { command: "evil" },
        agents: { command: "evil" },
        fine: { command: "ok" },
      }),
    );
    expect(Object.keys(out)).toEqual(["fine"]);
  });

  it("skips names that could not survive every driver's namespace", () => {
    const out = customMcpServers(
      cfg({
        "Bad.Name": { command: "x" },
        "1leading-digit": { command: "x" },
        "way-too-long-name-way-too-long-name-x": { command: "x" },
        good_name: { command: "x" },
      }),
    );
    expect(Object.keys(out)).toEqual(["good_name"]);
  });

  it("passes a url transport through as streamable HTTP", () => {
    expect(customMcpServers(cfg({ api: { url: "https://x/mcp" } }))).toEqual({ api: { type: "http", url: "https://x/mcp", headers: {} } });
  });

  it("never hands a url server's sign-in app or its secret to an engine", () => {
    expect(customMcpServers(cfg({ api: { url: "https://x/mcp", oauth: { clientId: "app", clientSecret: "shh" } } })))
      .toEqual({ api: { type: "http", url: "https://x/mcp", headers: {} } });
  });

  it("skips malformed entries without dropping the valid ones", () => {
    const out = customMcpServers(
      cfg({
        broken: { args: ["no-command"] },
        alsoBad: "not-an-object",
        keeper: { command: "ok" },
      }),
    );
    expect(Object.keys(out)).toEqual(["keeper"]);
  });
});

describe("changedInstanceIds", () => {
  it("replaces nothing for sections no driver reads", () => {
    expect(reloaded({ onboarding: { hintsSeen: ["tour.composer"] } })).toEqual([]);
    expect(reloaded({ profile: {}, language: "de", tts: {}, features: {} })).toEqual([]);
    expect(reloaded({ box: { token: "boat" }, composio: { apiKey: "c" }, budgets: { monthlyUsd: 5 } })).toEqual([]);
  });
it("names an engine that was added or removed", () => {
    expect(changedInstanceIds({ a: { driver: "fake" } }, { b: { driver: "fake" } })).toEqual(["a", "b"]);
    expect(changedInstanceIds({ a: { driver: "fake", config: { x: 1 } } }, { a: { driver: "fake", config: { x: 1 } } })).toEqual([]);
  });
});

describe("customMcpServers with url entries", () => {
  it("passes remote servers through in the engines' shape, next to commands", () => {
    const cfg = {
      mcpServers: {
        docs: { type: "sse", url: "https://docs.example/sse", headers: { Authorization: "Bearer t" } },
        notes: { command: "npx" },
        broken: { url: "not-an-address" },
      },
    } as Parameters<typeof customMcpServers>[0];
    expect(customMcpServers(cfg)).toEqual({
      docs: { type: "sse", url: "https://docs.example/sse", headers: { Authorization: "Bearer t" } },
      notes: { command: "npx", args: [], env: {} },
    });
  });
});

describe("live settings", () => {
  it("accepts idle minutes from 1 to 60 only", () => {
    expect(() => parseConfigPatch({ live: { idleMinutes: 0 } })).toThrow();
    expect(() => parseConfigPatch({ live: { idleMinutes: 61 } })).toThrow();
    expect(() => parseConfigPatch({ live: { idleMinutes: 2.5 } })).toThrow();
    expect(parseConfigPatch({ live: { idleMinutes: 60, readTypedReplies: false } })).toMatchObject({ live: { idleMinutes: 60, readTypedReplies: false } });
  });
  it("does not reload providers for live changes", () => {
    expect(reloaded({ live: { idleMinutes: 3 } })).toEqual([]);
  });

  describe("saving settings from PATCH /api/live/settings", () => {
    const path = join(DATA_DIR, "config.json");
    let envKey: string | undefined;
    beforeEach(() => {
      envKey = process.env.OMB_OPENAI_LIVE_KEY;
      delete process.env.OMB_OPENAI_LIVE_KEY;
      mkdirSync(DATA_DIR, { recursive: true });
      rmSync(path, { force: true });
    });
    afterEach(() => {
      if (envKey === undefined) delete process.env.OMB_OPENAI_LIVE_KEY;
      else process.env.OMB_OPENAI_LIVE_KEY = envKey;
      rmSync(path, { force: true });
    });

    it("keeps the Live key when only settings change", () => {
      saveConfig({ live: { key: "sk-keep" } });
      saveConfig({ live: { idleMinutes: 9 } });
      expect(loadConfig().live).toMatchObject({ key: "sk-keep", idleMinutes: 9 });
    });

    it("keeps a key from the desktop credential store, which reaches the harness as env", () => {
      // the desktop leaves an empty tombstone in the file and hands the key over as env
      saveConfig({ live: { key: "" } });
      process.env.OMB_OPENAI_LIVE_KEY = "sk-from-keychain";
      saveConfig({ live: { readTypedReplies: false, voice: "cedar" } });
      expect(loadConfig().live).toEqual({ key: "sk-from-keychain", readTypedReplies: false, voice: "cedar" });
      expect(JSON.parse(readFileSync(path, "utf8")).live).toEqual({ key: "", readTypedReplies: false, voice: "cedar" });
    });
  });
});

describe("loadConfig with an unusable config.json", () => {
  const path = join(DATA_DIR, "config.json");
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(path, { force: true });
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadConfig(); // reset the once-per-problem memory with a clean run
    warn.mockClear();
  });
  afterEach(() => {
    warn.mockRestore();
    rmSync(path, { force: true });
  });

  it("stays quiet on a first run with no file", () => {
    expect(loadConfig().instances).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("names the file and the failing field when one schema error drops the whole file", () => {
    // threads without maxConcurrentPerBot fails the stored schema, which drops
    // every other section (here: the Claude instance) along with it.
    writeFileSync(path, JSON.stringify({
      instances: { claude: { driver: "claudeAgent", displayName: "Claude (work)" } },
      threads: { eventLogMaxBytes: 1_000_000 },
    }));
    expect(loadConfig().instances).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain(path);
    expect(message).toContain("maxConcurrentPerBot");
  });

  it("warns about invalid JSON too, and only once while the file stays broken", () => {
    writeFileSync(path, "{ not json");
    loadConfig();
    loadConfig();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("using defaults");
  });

  it("never logs credential fragments from a JSON parser error", () => {
    writeFileSync(path, "sk-fixture");
    loadConfig();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("invalid JSON");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("sk-fixture");
  });

  it("warns again after a repaired or removed file becomes broken", () => {
    for (const recovered of ["{}", null]) {
      writeFileSync(path, "{ not json");
      loadConfig();
      warn.mockClear();
      if (recovered === null) rmSync(path);
      else writeFileSync(path, recovered);
      loadConfig();
      expect(warn).not.toHaveBeenCalled();
      writeFileSync(path, "{ not json");
      loadConfig();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockClear();
    }
  });
});

describe("a value derived from config.json", () => {
  const path = join(DATA_DIR, "config.json");
  const members = (config: AppConfig) => config.signIn?.members ?? [];
  /** Written a minute ago: a running server's file, not one mid-save. */
  const writeSettled = (signIn: AppConfig["signIn"], minutesAgo = 1) => {
    writeFileSync(path, JSON.stringify({ signIn }));
    const when = new Date(Date.now() - minutesAgo * 60_000);
    utimesSync(path, when, when);
  };
  beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); rmSync(path, { force: true }); });
  afterEach(() => { rmSync(path, { force: true }); });

  it("reads config.json once while the file is unchanged", () => {
    writeSettled({ members: ["one@example.test"] });
    const derive = vi.fn(members);
    const read = cacheUntilConfigChanges(derive);
    for (let i = 0; i < 5; i++) expect(read()).toEqual(["one@example.test"]);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("sees an outside edit on the next call, in place or renamed over the file", () => {
    writeSettled({ members: ["one@example.test", "two@example.test"] });
    const read = cacheUntilConfigChanges(members);
    expect(read()).toEqual(["one@example.test", "two@example.test"]);
    // In place, as a hand edit does: the size and the time change.
    writeSettled({ members: ["one@example.test"] }, 2);
    expect(read()).toEqual(["one@example.test"]);
    // Renamed over the file, as the CLI and the fleet agent write it: same size and time, only the file identity differs.
    const before = statSync(path);
    writeFileSync(`${path}.next`, JSON.stringify({ signIn: { members: ["two@example.test"] } }));
    utimesSync(`${path}.next`, before.atime, before.mtime);
    renameSync(`${path}.next`, path);
    expect(statSync(path).size).toBe(before.size);
    expect(read()).toEqual(["two@example.test"]);
  });

  it("sees this process's own save at once", () => {
    writeSettled({ members: ["one@example.test"] });
    const read = cacheUntilConfigChanges(members);
    expect(read()).toEqual(["one@example.test"]);
    saveConfig({ signIn: { members: [] } });
    expect(read()).toEqual([]);
  });

  it("reads a file saved in the last moments every time, so a second save in the same clock tick is not missed", () => {
    const tick = new Date();
    writeFileSync(path, JSON.stringify({ signIn: { members: ["one@example.test"] } }));
    utimesSync(path, tick, tick);
    const read = cacheUntilConfigChanges(members);
    expect(read()).toEqual(["one@example.test"]);
    // Same size, same file, same modification time: nothing in stat changed.
    writeFileSync(path, JSON.stringify({ signIn: { members: ["two@example.test"] } }));
    utimesSync(path, tick, tick);
    expect(read()).toEqual(["two@example.test"]);
  });

  it("never keeps the old value once the file is gone", () => {
    writeSettled({ members: ["one@example.test"] });
    const read = cacheUntilConfigChanges(members);
    expect(read()).toEqual(["one@example.test"]);
    rmSync(path);
    expect(read()).toEqual([]);
  });

  it("reads a file loadConfig() could not use on every call, never keeping its defaults", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(path, "{ not json");
      const when = new Date(Date.now() - 60_000);
      utimesSync(path, when, when);
      const derive = vi.fn(members);
      const read = cacheUntilConfigChanges(derive);
      expect(read()).toEqual([]);
      expect(read()).toEqual([]);
      expect(derive).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("sees a change of permissions or owner on the next call", () => {
    writeSettled({ members: ["one@example.test"] });
    const derive = vi.fn(members);
    const read = cacheUntilConfigChanges(derive);
    read();
    // Linux stamps ctime from a clock that ticks every 1 to 10 ms, so a chmod in the write's own tick keeps its ctime.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    // chmod and chown leave the size, the time and the file the same.
    chmodSync(path, 0o600);
    read();
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "uses the list again once a file the server could not read is readable",
    () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        writeSettled({ members: ["one@example.test"] });
        chmodSync(path, 0o000);
        const read = cacheUntilConfigChanges(members);
        expect(read()).toEqual([]);
        expect(read()).toEqual([]);
        chmodSync(path, 0o600);
        expect(read()).toEqual(["one@example.test"]);
      } finally {
        chmodSync(path, 0o600);
        warn.mockRestore();
      }
    },
  );
});

describe("X research's included relay token", () => {
  it("still loads a config.json saved with the old own treg token, and keeps that token out of the config", () => {
    const path = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({ budgets: { monthlyUsd: 25, warnAtPercent: 70 }, treg: { token: "treg_old" } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = loadConfig();
      expect(loaded.budgets).toEqual({ monthlyUsd: 25, warnAtPercent: 70 });
      expect(JSON.stringify(loaded)).not.toContain("treg_old");
      expect(warn.mock.calls.some(([line]) => String(line).includes("ignoring"))).toBe(false);
    } finally {
      warn.mockRestore();
      rmSync(path, { force: true });
    }
  });

  it("keeps the plan's research token and the person's own treg key as workspace credentials that never reach an engine", () => {
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_CLOUD_X_TOKEN");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_TREG_KEY");
  });
});

describe("DATA_DIR outside the suite's throwaway home", () => {
  function childDataDir(env: NodeJS.ProcessEnv): string {
    const script = "const m = await import(process.env.OMB_CONFIG_URL); process.stdout.write(m.DATA_DIR);";
    const { OMB_DATA_DIR: _dataDir, VITEST: _vitest, NODE_ENV: _nodeEnv, ...inherited } = process.env;
    return execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], {
      env: { ...inherited, OMB_CONFIG_URL: pathToFileURL(join(import.meta.dirname, "config.ts")).href, ...env }, encoding: "utf8",
    });
  }

  it("never resolves to the person's real data folder when a test runs without the setup file", () => {
    const realHome = userInfo().homedir;
    const dataDir = childDataDir({ HOME: realHome, USERPROFILE: realHome, VITEST: "true" });
    try {
      expect(dataDir).not.toBe(join(realHome, ".openmausbot"));
      expect(dataDir.startsWith(tmpdir())).toBe(true);
    } finally {
      // Only ever a throwaway folder: a broken guard would hand back the real home here.
      const throwaway = dirname(dataDir);
      if (throwaway.startsWith(join(realpathSync(tmpdir()), "omb-test-home-")) || throwaway.startsWith(join(tmpdir(), "omb-test-home-"))) {
        rmSync(throwaway, { recursive: true, force: true });
      }
    }
  });

  it("treats an empty OMB_DATA_DIR as unset", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-config-home-"));
    try {
      expect(childDataDir({ HOME: home, USERPROFILE: home, OMB_DATA_DIR: "" })).toBe(join(home, ".openmausbot"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the home folder outside tests", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-config-home-"));
    try {
      expect(childDataDir({ HOME: home, USERPROFILE: home })).toBe(join(home, ".openmausbot"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});


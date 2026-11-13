import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV, type AppConfig } from "./config.ts";
import { acquireDataDirLease } from "./data-dir-lease.ts";
import { type SetupIo } from "./cli-prompts.ts";
import { isSetupComplete, readCliStartup, runSetup, saveCliStartup } from "./cli-setup.ts";

const options = { dataDir: DATA_DIR, port: 8799 };
const configPath = join(DATA_DIR, "config.json");
const models = {
  default: "fixture-default",
  options: [
    { id: "fixture-default", label: "Fixture default" },
    { id: "fixture-selected", label: "Fixture selected" },
  ],
};
type Dependencies = NonNullable<Parameters<typeof runSetup>[2]>;

function dependencies() {
  return {
    inspect: vi.fn<Dependencies["inspect"]>().mockResolvedValue({
      snapshot: { state: "available", authenticated: true }, models,
    }),
    runCli: vi.fn<Dependencies["runCli"]>().mockResolvedValue(undefined),
  };
}

function prompts(script: { choices?: Array<number | Error>; confirms?: boolean[]; secrets?: Array<string | Error>; answers?: string[] } = {}) {
  const choices = [...(script.choices ?? [])];
  const confirms = [...(script.confirms ?? [])];
  const secrets = [...(script.secrets ?? [])];
  const answers = [...(script.answers ?? [])];
  const lines: string[] = [];
  const take = <T>(values: T[], question: string): T => {
    if (!values.length) throw new Error(`Unexpected fixture prompt: ${question}`);
    return values.shift()!;
  };
  const io = {
    log: vi.fn((line: string) => { lines.push(line); }),
    choose: vi.fn<SetupIo["choose"]>(async (question, available) => {
      lines.push(question, ...available);
      const selected = take(choices, question);
      if (selected instanceof Error) throw selected;
      if (selected < 0 || selected >= available.length) throw new Error("Fixture selected an unavailable option");
      return selected;
    }),
    confirm: vi.fn<SetupIo["confirm"]>(async (question) => { lines.push(question); return take(confirms, question); }),
    secret: vi.fn<SetupIo["secret"]>(async (question) => {
      lines.push(question);
      const value = take(secrets, question);
      if (value instanceof Error) throw value;
      return value;
    }),
    ask: vi.fn<SetupIo["ask"]>(async (question) => { lines.push(question); return take(answers, question); }),
  };
  return { io, lines, assertConsumed: () => expect([choices, confirms, secrets, answers]).toEqual([[], [], [], []]) };
}

function persist(config: AppConfig & Record<string, unknown>): string {
  const raw = JSON.stringify(config, null, 2);
  writeFileSync(configPath, raw, { mode: 0o600 });
  return raw;
}

function expectLeaseReleased() {
  const lease = acquireDataDirLease(DATA_DIR);
  expect(lease.release()).toBe(true);
}

beforeEach(() => {
  // testing/setup.ts assigns a throwaway HOME before this module loads.
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  for (const name of [...WORKSPACE_CREDENTIAL_ENV, ...PROVIDER_CREDENTIAL_ENV]) vi.stubEnv(name, undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Wizard fixtures must never make network requests"); }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the provider the wizard can offer", () => {
  it("is none: the engine is the person's own agent CLI, added in Settings", async () => {
    const ui = prompts();
    const deps = dependencies();
    await expect(runSetup(options, ui.io, deps)).rejects.toThrow(/no AI provider to connect/i);
    expect(ui.io.choose).not.toHaveBeenCalled();
    expect(deps.inspect).not.toHaveBeenCalled();
    expectLeaseReleased();
  });
});

describe("CLI startup preferences", () => {
  it("reads and saves preferences without changing existing provider settings", () => {
    expect(readCliStartup(DATA_DIR)).toBeUndefined();
    const existing = {
      profile: { name: "Keep" }, defaultModelSelection: { instanceId: "api-old", model: "previous" },
      instances: { apiOld: { driver: "customAcp", config: { cli: "my-agent acp" } } }, futureSetting: { keep: true },
    };
    persist(existing);
    saveCliStartup(DATA_DIR, { access: "tailscale", phone: "ios" });
    expect(readCliStartup(DATA_DIR)).toEqual({ access: "tailscale", phone: "ios" });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject(existing);
    expectLeaseReleased();
  });

  it("refuses to save while the server owns the data directory", () => {
    const original = persist({ cliStartup: { access: "local" } });
    const lease = acquireDataDirLease(DATA_DIR);
    try {
      expect(() => saveCliStartup(DATA_DIR, { access: "tunnel", phone: "android" })).toThrow(/already using this data directory/);
      expect(readCliStartup(DATA_DIR)).toBe(original);
    } finally { lease.release(); }
  });

  it("refuses corrupt configuration on both read and save", () => {
    const original = "{broken config";
    writeFileSync(configPath, original);
    expect(() => readCliStartup(DATA_DIR)).toThrow("Existing config.json");
    expect(() => saveCliStartup(DATA_DIR, { access: "local" })).toThrow("Existing config.json");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expectLeaseReleased();
  });

  it("refuses a different data directory without reading or writing it", () => {
    expect(() => readCliStartup(join(DATA_DIR, "wrong"))).toThrow("data directory mismatch");
    expect(() => saveCliStartup(join(DATA_DIR, "wrong"), { access: "local" })).toThrow("data directory mismatch");
    expect(existsSync(join(DATA_DIR, "wrong"))).toBe(false);
  });
});

describe("setup state and write boundaries", () => {
  it("requires a saved selection belonging to an enabled configured or built-in instance", async () => {
    expect(await isSetupComplete(DATA_DIR)).toBe(false);
    persist({ defaultModelSelection: { instanceId: "openaiCompat", model: "fixture" } });
    expect(await isSetupComplete(DATA_DIR)).toBe(true);
    persist({ defaultModelSelection: { instanceId: "missing", model: "fixture" } });
    expect(await isSetupComplete(DATA_DIR)).toBe(false);
    persist({ instances: { api: { driver: "customAcp", enabled: false } }, defaultModelSelection: { instanceId: "api", model: "fixture" } });
    expect(await isSetupComplete(DATA_DIR)).toBe(false);
    persist({ instances: { custom: { driver: "customAcp" } }, defaultModelSelection: { instanceId: "custom", model: "fixture" } });
    expect(await isSetupComplete(DATA_DIR)).toBe(true);
  });

  it.each(["toString", "constructor", "__proto__"])("does not count inherited object property %s as a saved instance", async (instanceId) => {
    persist({ defaultModelSelection: { instanceId, model: "fixture" } });
    expect(await isSetupComplete(DATA_DIR)).toBe(false);
  });

  it.each(["{broken JSON", '{"instances":{"api":{"driver":42}}}'])("refuses an unreadable existing configuration: %s", async (raw) => {
    writeFileSync(configPath, raw);
    const ui = prompts();
    const deps = dependencies();
    await expect(runSetup(options, ui.io, deps)).rejects.toThrow("Existing config.json");
    await expect(isSetupComplete(DATA_DIR)).rejects.toThrow("Existing config.json");
    expect(readFileSync(configPath, "utf8")).toBe(raw);
    expect(ui.io.choose).not.toHaveBeenCalled();
    expect(deps.inspect).not.toHaveBeenCalled();
    expectLeaseReleased();
  });

  it("refuses setup while another owner holds the data directory", async () => {
    const original = persist({ profile: { name: "Active app" } });
    const held = acquireDataDirLease(DATA_DIR);
    try {
      const ui = prompts();
      const deps = dependencies();
      await expect(runSetup(options, ui.io, deps)).rejects.toThrow(/already using this data directory/);
      expect(ui.io.choose).not.toHaveBeenCalled();
      expect(deps.inspect).not.toHaveBeenCalled();
      expect(readFileSync(configPath, "utf8")).toBe(original);
    } finally { held.release(); }
    expectLeaseReleased();
  });
});

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { companyInstanceConfigs, companyInstanceId, legacyCompanyInstanceId, LICENSE_EXPIRED_MESSAGE, ManagedDesktopProviders, parseManagedDesktopConnection, type ManagedDesktopConnection } from "./managed-desktop.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { DATA_DIR, instanceConfigs, loadConfig, persistableInstanceConfigs, saveConfig } from "./config.ts";
import { OpenAICompatDriver } from "./drivers/openai-compat.ts";
import { recordEvents } from "./testing/events.ts";
import { redactSecretsInText } from "./redact.ts";
import { excludedWorkspaceAuthPath } from "./workspace-backup-policy.ts";
import { selectDefaultModelSelection } from "./default-model-selection.ts";
import { Store } from "./store.ts";

const managers: ManagedDesktopProviders[] = [], registries: ProviderRegistry[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())); await Promise.all(registries.splice(0).map(registry => registry.disposeAll())); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function connection(): ManagedDesktopConnection {
  return { portalOrigin: "https://admin.example.test", organizationId: "11111111-1111-4111-8111-111111111111", organizationName: "Fixture Agency", email: "employee@example.test", deviceId: "22222222-2222-4222-8222-222222222222", token: `omg_${randomBytes(32).toString("base64url")}`, expiresAt: Date.now() + 60_000,
    providers: [{ id: "openrouter", configured: true, models: ["fixture/writer"] }] };
}
async function setup(options: { now?: () => number; dataDirectory?: string; migrate?: (aliases: { from: string; to: string }[]) => void; onAvailability?: () => void } = {}) {
  const fakes = ["claudeAgent", "codex", "openai-compat"].map(kind => makeFakeDriver({ kind }));
  const registry = new ProviderRegistry(fakes.map(fake => fake.driver), { npmAvailable: () => false }); registries.push(registry);
  await registry.load({ personal: { driver: "claudeAgent" }, local: { driver: "openai-compat" } });
  const before = vi.fn(), after = vi.fn();
  const manager = new ManagedDesktopProviders({ registry, dataDirectory: join(DATA_DIR, `company-fixture-${randomUUID()}`), beforeReplace: before, afterReplace: after, ...options }); managers.push(manager);
  return { registry, manager, fakes, before, after };
}

it("adds Company instances without mutating personal/global configuration or persisting credentials", async () => {
  const { registry, manager } = await setup(), value = connection();
  const personal = registry.get("personal"), local = registry.get("local");
  const cfg = { anthropic: { key: "personal-key", url: "https://personal.example.test" }, openaiCompat: { key: "personal-router", url: "http://127.0.0.1:8080/v1" }, instances: { personal: { driver: "claudeAgent" }, local: { driver: "openai-compat" } } };
  saveConfig(cfg, { replaceInstances: true });
  const persisted = readFileSync(join(DATA_DIR, "config.json"), "utf8");
  await manager.apply(value);
  expect(registry.instances()).toHaveLength(3);
  expect(registry.get("personal")).toBe(personal); expect(registry.get("local")).toBe(local);
  expect(readFileSync(join(DATA_DIR, "config.json"), "utf8")).toBe(persisted);
  expect(JSON.stringify(instanceConfigs(cfg))).not.toContain(value.token);
  expect(Object.keys(persistableInstanceConfigs(loadConfig()))).toEqual(["personal", "local"]);
  for (const provider of value.providers) {
    const id = companyInstanceId(value, provider.id), company = registry.get(id)!;
    expect(company.displayName).toContain("Company · Fixture Agency");
    expect(company.models.options.map(row => row.id)).toEqual(provider.models);
    expect(manager.info(id)).toEqual({ organizationId: value.organizationId, organizationName: value.organizationName });
    expect(company.startAuthentication).toBeUndefined(); expect(company.signOut).toBeUndefined();
    expect(await company.snapshot()).toMatchObject({ authenticated: true, billing: "metered", account: { organization: value.organizationName, email: value.email } });
  }
  expect(JSON.stringify(await registry.describe())).not.toContain(value.token);
});

it("keeps the Company's routing and its secret on its own instance", () => {
  const value = connection(), map = companyInstanceConfigs(value, "/fixture/company-runtime");
  const router = map[companyInstanceId(value, "openrouter")]!;
  expect(router.config).toMatchObject({ url: `${value.portalOrigin}/api/desktop/gateway/openrouter/v1`, provider: "", apiKeyEnv: "OPENMAUSBOT_COMPANY_API_KEY" });
  expect(router.environment).toEqual({ OPENMAUSBOT_COMPANY_API_KEY: value.token });
  expect(router.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(router.environment).not.toHaveProperty("OPENAI_API_KEY");
});

it("refuses a redirected Company storage parent before creating native homes", async () => {
  const dataDirectory = join(DATA_DIR, `company-link-${randomUUID()}`), target = join(DATA_DIR, `personal-target-${randomUUID()}`);
  mkdirSync(dataDirectory, { recursive: true }); mkdirSync(target, { recursive: true });
  symlinkSync(target, join(dataDirectory, "providers"), process.platform === "win32" ? "junction" : "dir");
  const { manager, registry } = await setup({ dataDirectory });
  await expect(manager.apply(connection())).rejects.toThrow("owned workspace directory");
  expect(existsSync(join(target, "company"))).toBe(false);
  expect(registry.instances().map(instance => instance.instanceId)).toEqual(["personal", "local"]);
});

it("never discovers or injects personal local routes into an approved Company model", async () => {
  const value = { ...connection(), providers: [{ id: "openrouter" as const, configured: true, models: ["custom-company-model"] }] };
  const dataDirectory = join(DATA_DIR, `company-compat-${randomUUID()}`);
  const fetcher = vi.fn(async () => Response.json({ data: [{ id: "custom-company-model" }] }));
  vi.stubGlobal("fetch", fetcher);
  const registry = new ProviderRegistry([OpenAICompatDriver], { npmAvailable: () => false }); registries.push(registry);
  const manager = new ManagedDesktopProviders({ registry, dataDirectory }); managers.push(manager);
  await manager.apply(value);
  const company = registry.get(companyInstanceId(value, "openrouter"))!, events = recordEvents(company.adapter);
  await company.adapter.sendTurn({ threadId: "company-routing", text: "Synthetic company turn", model: "custom-company-model", cwd: dataDirectory });
  await events.until(event => event.type === "turn.completed"); events.stop();
  // The turn went to the company's own gateway, never to a personal route.
  const called = fetcher.mock.calls.map(([url]) => String(url));
  expect(called.some((url) => url.startsWith(`${value.portalOrigin}/api/desktop/gateway/openrouter`))).toBe(true);
  expect(called.every((url) => !url.includes("ollama"))).toBe(true);
  await expect(company.adapter.sendTurn({ threadId: "company-injected", text: "Do not route locally", model: "ollama::custom-company-model" })).rejects.toThrow("not enabled");
});

it("does not restart any instance for an identical heartbeat and never substitutes personal billing", async () => {
  const { registry, manager, before, fakes } = await setup(), value = connection();
  await manager.apply(value);
  const id = companyInstanceId(value, "openrouter"), company = registry.get(id)!;
  await manager.apply(structuredClone(value));
  expect(registry.get(id)).toBe(company); expect(before).toHaveBeenCalledTimes(1);
  expect(fakes.flatMap(fake => fake.disposed)).toEqual([]);
  await expect(company.adapter.sendTurn({ threadId: "company", text: "Fixture", model: "personal-model" })).rejects.toThrow("not enabled");
  expect(await company.adapter.sendTurn({ threadId: "company", text: "Fixture", model: "fixture/writer" })).toEqual({ turnId: "fake-turn" });
  const clearing = manager.apply(null);
  await expect(company.adapter.sendTurn({ threadId: "company", text: "Fixture", model: "fixture/writer" })).rejects.toThrow("personal billing");
  await clearing;
  expect(registry.get(id)).toBeNull(); expect(registry.get("personal")).not.toBeNull(); expect(registry.get("local")).not.toBeNull();
  expect(fakes.flatMap(fake => fake.disposed)).not.toContain("personal");
});

it("expires Company access and cancels only its instances", async () => {
  let now = Date.now();
  const { registry, manager } = await setup({ now: () => now }), value = connection();
  await manager.apply(value);
  const company = registry.get(companyInstanceId(value, "openrouter"))!;
  now = value.expiresAt;
  await expect(company.adapter.sendTurn({ threadId: "company", text: "Fixture", model: "fixture/writer" })).rejects.toThrow("ended");
  expect(await company.snapshot()).toMatchObject({ state: "unavailable" });
  await manager.apply(null);
  expect(registry.instances().map(instance => instance.instanceId)).toEqual(["personal", "local"]);
});

it("does not revive a delayed Company creation after the parent revokes it", async () => {
  const { registry, manager, fakes } = await setup();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  // The Company instance is created on the OpenAI-compatible driver.
  const openaiCompat = fakes.find(fake => fake.driver.driverKind === "openai-compat")!;
  const create = openaiCompat.driver.create;
  const entered = vi.fn();
  openaiCompat.driver.create = async input => { entered(); await blocked; return create(input); };
  const applying = manager.apply(connection());
  await vi.waitFor(() => expect(entered).toHaveBeenCalled());
  const clearing = manager.apply(null);
  release(); await applying; await clearing;
  expect(registry.instances().map(instance => instance.instanceId)).toEqual(["personal", "local"]);
});

it("publishes catalog changes only after replacement and retries a failed identical grant", async () => {
  const { registry, manager, after } = await setup(), value = connection();
  const catalogs: string[][] = [];
  after.mockImplementation(() => catalogs.push(registry.instances().map(instance => instance.instanceId)));
  const original = registry.load.bind(registry);
  const load = vi.spyOn(registry, "load").mockImplementationOnce(async (...args) => {
    await original(...args);
    throw new Error("Fixture replacement failure");
  });
  await expect(manager.apply(value)).rejects.toThrow("Fixture replacement failure");
  expect(catalogs).toEqual([["personal", "local"]]);
  await manager.apply(structuredClone(value));
  expect(load).toHaveBeenCalledTimes(2);
  expect(catalogs[1]).toHaveLength(3);
  await manager.apply(structuredClone(value));
  expect(catalogs).toHaveLength(2);
  await manager.apply(null);
  expect(catalogs[2]).toEqual(["personal", "local"]);
});

it("keeps a newer revocation authoritative while a previous registry load fails", async () => {
  const { registry, manager } = await setup(), value = connection();
  const original = registry.load.bind(registry);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = vi.fn();
  vi.spyOn(registry, "load").mockImplementationOnce(async (...args) => {
    await original(...args); entered(); await blocked;
    throw new Error("Fixture late failure");
  });
  const applying = manager.apply(value);
  const rejected = expect(applying).rejects.toThrow("Fixture late failure");
  await vi.waitFor(() => expect(entered).toHaveBeenCalled());
  const oldCompany = registry.get(companyInstanceId(value, "openrouter"))!;
  const clearing = manager.apply(null);
  release(); await rejected; await clearing;
  expect(registry.instances().map(instance => instance.instanceId)).toEqual(["personal", "local"]);
  await expect(oldCompany.adapter.sendTurn({ threadId: "stale", text: "No revival", model: "fixture/writer" })).rejects.toThrow("personal billing");
  await manager.apply(null);
});

it("rejects invalid origins, expired tokens, provider collisions and local model injection IDs without echoing secrets", () => {
  const value = connection();
  for (const patch of [
    { portalOrigin: "http://public.example.test" }, { portalOrigin: "https://user:secret@example.test" },
    { portalOrigin: "https://admin.example.test/other" }, { expiresAt: Date.now() - 1 }, { token: "not-a-device-token" },
    { token: `omd_${"A".repeat(43)}` },
    { providers: [value.providers[0], value.providers[0]] },
    { providers: [{ id: "anthropic", configured: true, models: ["ollama::personal-local"] }] },
  ]) expect(() => parseManagedDesktopConnection({ ...value, ...patch })).toThrow();
  expect(parseManagedDesktopConnection({ ...value, portalOrigin: "http://127.0.0.1:1234" })?.portalOrigin).toBe("http://127.0.0.1:1234");
  expect(redactSecretsInText(`A provider echoed ${value.token} here.`)).not.toContain(value.token);
  expect(redactSecretsInText(`A provider echoed omd_${"A".repeat(42)}- here.`)).not.toContain("omd_");
  expect(redactSecretsInText(`A provider echoed omg_${"A".repeat(42)}- here.`)).not.toContain("omg_");
  expect(companyInstanceId(value, "openrouter")).not.toBe(companyInstanceId({ ...value, email: "colleague@example.test" }, "openai"));
});

it("applies a renewal or a lapsed licence in place, without restarting or ending Company conversations", async () => {
  let now = Date.now();
  const onAvailability = vi.fn();
  const { registry, manager, before, fakes } = await setup({ now: () => now, onAvailability }), value = connection();
  await manager.apply(value);
  const id = companyInstanceId(value, "openrouter"), company = registry.get(id)!;
  const renewed = { ...value, expiresAt: value.expiresAt + 30 * 86400_000 };
  await manager.apply(renewed);
  expect(registry.get(id)).toBe(company); expect(before).toHaveBeenCalledTimes(1);
  expect(fakes.flatMap(fake => fake.disposed)).toEqual([]);
  now = value.expiresAt + 1000;
  expect(await company.adapter.sendTurn({ threadId: "company", text: "Fixture", model: "fixture/writer" })).toEqual({ turnId: "fake-turn" });
  await manager.apply({ ...renewed, suspended: "license-expired" });
  expect(registry.get(id)).toBe(company); expect(before).toHaveBeenCalledTimes(1);
  expect(await company.snapshot()).toEqual({ state: "unavailable", reason: LICENSE_EXPIRED_MESSAGE });
  await expect(company.adapter.sendTurn({ threadId: "company", text: "Fixture", model: "fixture/writer" })).rejects.toThrow("license has expired");
  await manager.apply(renewed);
  expect(await company.snapshot()).toMatchObject({ authenticated: true });
  expect(onAvailability).toHaveBeenCalledTimes(3);
  expect(fakes.flatMap(fake => fake.disposed)).toEqual([]);
});

it("migrates an expired or cleared enrollment by its identity alone, so a later re-enrolment finds its bots", async () => {
  const dataDirectory = join(DATA_DIR, `company-identity-${randomUUID()}`), expired = connection();
  const legacy = legacyCompanyInstanceId(expired, "openrouter"), stable = companyInstanceId(expired, "openrouter");
  const legacyHome = join(dataDirectory, "providers", "company", legacy, "claude");
  mkdirSync(legacyHome, { recursive: true }); writeFileSync(join(legacyHome, "session.json"), "native-resume");
  const migrate = vi.fn();
  const { manager, registry } = await setup({ dataDirectory, migrate });
  await manager.migrateIdentity({ portalOrigin: expired.portalOrigin, organizationId: expired.organizationId, email: "Employee@Example.test", deviceId: expired.deviceId });
  expect(migrate).toHaveBeenCalledWith(expect.arrayContaining([{ from: legacy, to: stable }]));
  expect(readFileSync(join(dataDirectory, "providers", "company", stable, "claude", "session.json"), "utf8")).toBe("native-resume");
  const reenrolled = { ...expired, deviceId: "55555555-5555-4555-8555-555555555555" };
  await manager.apply(reenrolled);
  expect(registry.get(stable)).not.toBeNull();
  await expect(manager.migrateIdentity({ portalOrigin: "https://admin.example.test", organizationId: expired.organizationId, email: expired.email, deviceId: expired.deviceId, token: "omd_x" })).rejects.toThrow();
  await expect(manager.migrateIdentity({ portalOrigin: "http://admin.example.test", organizationId: expired.organizationId, email: expired.email, deviceId: expired.deviceId })).rejects.toThrow("HTTPS");
});

it("keeps Company models available when moving old references fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { manager, registry } = await setup({ migrate: () => { throw new Error("bots.json is read-only"); } }), value = connection();
  await manager.apply(value);
  expect(registry.get(companyInstanceId(value, "openrouter"))).not.toBeNull();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not move saved Company model references"));
});

it("sends new bots to a Company model that can run while enrolled, and disconnecting leaves personal selections untouched", async () => {
  const store = new Store(() => ({ instanceId: "personal", model: "fake-default" }));
  const { registry, manager } = await setup({ migrate: aliases => { store.renameInstances(new Map(aliases.map(({ from, to }) => [from, to]))); } });
  const value = connection(), companyClaude = companyInstanceId(value, "openrouter");
  const company = (instanceId: string) => manager.owns(instanceId);
  // The personal Claude CLI is installed but signed out, and the local model server is not running.
  const described = async (signedIn = false) => (await registry.describe()).map(instance =>
    instance.instanceId === "personal" && !signedIn ? { ...instance, snapshot: { ...instance.snapshot, authenticated: false } }
      : instance.instanceId === "local" ? { ...instance, snapshot: { state: "unavailable" as const, reason: "fixture server stopped" } } : instance);
  const before = selectDefaultModelSelection(await described(), undefined, { company });
  expect(before.instanceId).toBe("personal");
  await manager.apply(value);
  expect(selectDefaultModelSelection(await described(), undefined, { company })).toEqual({ instanceId: companyClaude, model: "fixture/writer" });
  expect(selectDefaultModelSelection(await described(true), undefined, { company }).instanceId).toBe("personal");
  const personalBot = store.createBot({ modelSelection: { instanceId: "personal", model: "fake-default" } }, { seedMessages: false });
  const companyBot = store.createBot({ modelSelection: { instanceId: companyClaude, model: "fixture/writer" } }, { seedMessages: false });
  await manager.migrateIdentity({ portalOrigin: value.portalOrigin, organizationId: value.organizationId, email: value.email, deviceId: value.deviceId });
  await manager.apply(null);
  expect(registry.get(companyClaude)).toBeNull();
  expect(store.bot(personalBot.id)!.modelSelection).toEqual({ instanceId: "personal", model: "fake-default" });
  expect(store.bot(companyBot.id)!.modelSelection).toEqual({ instanceId: companyClaude, model: "fixture/writer" });
  expect(selectDefaultModelSelection(await described(), undefined, { company })).toEqual(before);
});

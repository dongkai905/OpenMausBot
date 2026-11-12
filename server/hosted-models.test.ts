import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hostedModelPolicy } from "./hosted-models.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { OpenAICompatDriver } from "./drivers/openai-compat.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const directories: string[] = [], registries: ProviderRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map(registry => registry.disposeAll()));
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) await removeTempDir(directory);
});
const directory = () => { const value = mkdtempSync(join(tmpdir(), "omb-hosted-models-")); directories.push(value); return value; };
const token = `omb_workspace_${"a".repeat(43)}`;
const env = () => ({ OMB_ADMIN_URL: "https://admin.example.test", OMB_PUBLIC_URL: "https://fixture.example.test", OMB_ADMIN_WORKSPACE: "fixture", OMB_ADMIN_MEMBERSHIP: "portal",
  OMB_HOSTED_MODEL_TOKEN: token, OMB_HOSTED_MODELS: JSON.stringify({ anthropic: ["claude-fixture"], openai: ["gpt-fixture"], openrouter: ["provider/fixture"] }) });

it("requires an explicit complete hosted policy and leaves normal desktops alone", () => {
  expect(hostedModelPolicy(directory(), {})).toBeNull();
  expect(hostedModelPolicy(directory(), { OMB_ADMIN_URL: "https://admin.example.test" })).toBeNull();
  for (const invalid of [ { ...env(), OMB_ADMIN_MEMBERSHIP: "local" }, { ...env(), OMB_HOSTED_MODEL_TOKEN: "secret" },
    { ...env(), OMB_ADMIN_URL: "http://admin.example.test" }, { ...env(), OMB_DESKTOP_PARENT: "1" },
    { ...env(), OMB_HOSTED_MODELS: "{}" } ]) expect(() => hostedModelPolicy(directory(), invalid)).toThrow();
});

it("preserves allowed choices, normalizes legacy routes, and replaces only unassigned choices", () => {
  const policy = hostedModelPolicy(directory(), env())!;
  expect(policy.select({ instanceId: "opencode", model: "provider/fixture" })).toEqual({ instanceId: "opencode", model: "provider/fixture" });
  expect(policy.select({ instanceId: "opencode", model: "omb-managed-openrouter/provider/fixture" })).toEqual({ instanceId: "opencode", model: "provider/fixture" });
  expect(policy.select({ instanceId: "opencode", model: "removed-model" })).toEqual({ instanceId: "opencode", model: "provider/fixture" });
  // An engine the policy no longer offers falls back to the one it does.
  expect(policy.select({ instanceId: "other", model: "personal" })).toEqual({ instanceId: "opencode", model: "provider/fixture" });
  expect(policy.allows({ instanceId: "opencode", model: "personal" })).toBe(false);
  expect(policy.allows({ instanceId: "other", model: "provider/fixture" })).toBe(false);
  const empty = hostedModelPolicy(directory(), { ...env(), OMB_HOSTED_MODELS: JSON.stringify({ anthropic: [], openai: [], openrouter: [] }) })!;
  expect(empty.select({ instanceId: "opencode", model: "personal" })).toEqual({ instanceId: "", model: "" });
  expect(empty.configs()).toEqual({});
  expect(empty.error()).toContain("No company models");
});

it.each([{ variant: "high" }, { effort: "high" as const }])("preserves an assigned raw OpenRouter model without unsupported OpenCode metadata: %j", metadata => {
  const policy = hostedModelPolicy(directory(), env())!;
  const previous = { instanceId: "opencode", model: "provider/fixture", ...metadata };
  const selection = policy.select(previous);
  expect(selection).toEqual({ instanceId: "opencode", model: "provider/fixture" });
  expect(policy.allows(selection)).toBe(true);
  expect(policy.select(selection)).toEqual(selection);
});

it("locks native and OpenRouter instances to assigned catalogs and fixed gateway routes", async () => {
  const root = directory(), policy = hostedModelPolicy(root, { ...env(),
    OMB_HOSTED_CLAUDE_CLI: join(import.meta.dirname, "testing/fake-claude-cli.ts"),
    OMB_HOSTED_CODEX_CLI: join(import.meta.dirname, "testing/fake-codex-app-server.ts"),
  })!;
  const configs = policy.configs();
  expect(Object.keys(configs)).toEqual(["opencode"]);
  expect(configs.opencode.environment).toEqual({ OPENMAUSBOT_COMPANY_API_KEY: token });
  expect(configs.opencode.config).toMatchObject({ url: "https://admin.example.test/api/gateway/fixture/openrouter/v1", apiKeyEnv: "OPENMAUSBOT_COMPANY_API_KEY", model: "provider/fixture", managedModels: ["provider/fixture"] });
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  // The one engine the registry still has is the OpenAI-compatible one, so the
  // catalog lock is checked on it; the other two are config-only from here.
  const registry = new ProviderRegistry([OpenAICompatDriver], { npmAvailable: () => false }); registries.push(registry);
  await registry.load({ opencode: configs.opencode }, instance => policy.decorate(instance));
  for (const [id, model] of [["opencode", "provider/fixture"]]) {
    const instance = registry.get(id)!;
    expect(instance.models.options.map(row => row.id)).toEqual([model]);
    expect(instance.startAuthentication).toBeUndefined();
    await expect(instance.adapter.sendTurn({ threadId: "forbidden", text: "Synthetic", model: "unassigned" })).rejects.toThrow("not assigned");
    await instance.refreshModels?.();
  }
  expect(fetcher).not.toHaveBeenCalled();
});


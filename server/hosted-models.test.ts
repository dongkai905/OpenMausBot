import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hostedModelPolicy } from "./hosted-models.ts";
import type { ProviderInstance } from "./contracts.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) await removeTempDir(directory);
});
const directory = () => { const value = mkdtempSync(join(tmpdir(), "omb-hosted-models-")); directories.push(value); return value; };
const token = `omb_workspace_${"a".repeat(43)}`;
const env = () => ({ OMB_ADMIN_URL: "https://admin.example.test", OMB_PUBLIC_URL: "https://fixture.example.test", OMB_ADMIN_WORKSPACE: "fixture", OMB_ADMIN_MEMBERSHIP: "portal",
  OMB_HOSTED_MODEL_TOKEN: token, OMB_HOSTED_MODELS: JSON.stringify({ anthropic: ["claude-fixture"], openai: ["gpt-fixture"], openrouter: ["provider/fixture"] }) });


/** The engine the policy decorates: its model list and its route are the policy's to lock. */
function hostedEngine(instanceId: string) {
  const sent: string[] = [];
  const instance = {
    instanceId, driverKind: "hosted", displayName: "Company", enabled: true,
    models: { default: "", options: [] },
    snapshot: async () => ({ state: "available" as const }),
    adapter: {
      provider: "hosted",
      capabilities: {},
      sendTurn: async (input: { model?: string }) => { sent.push(input.model ?? ""); return { turnId: "fixture" }; },
      interruptTurn: async () => {},
      respondToRequest: async () => "unavailable" as const,
      hasSession: () => false,
      stopAll: async () => {},
      onEvent: () => () => {},
    },
    dispose: async () => {},
  } as unknown as ProviderInstance;
  return { instance, sent };
}

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

it("locks the hosted engine to its assigned catalog and refuses an unassigned model", async () => {
  const policy = hostedModelPolicy(directory(), env())!;
  const configs = policy.configs();
  expect(Object.keys(configs)).toEqual(["opencode"]);
  expect(configs.opencode.environment).toEqual({ OPENMAUSBOT_COMPANY_API_KEY: token });
  expect(configs.opencode.config).toMatchObject({ url: "https://admin.example.test/api/gateway/fixture/openrouter/v1", apiKeyEnv: "OPENMAUSBOT_COMPANY_API_KEY", model: "provider/fixture", managedModels: ["provider/fixture"] });
  const engine = hostedEngine("opencode");
  const decorated = policy.decorate(engine.instance);
  expect(decorated.models.options.map(row => row.id)).toEqual(["provider/fixture"]);
  expect(decorated.startAuthentication).toBeUndefined();
  await expect(decorated.adapter.sendTurn({ threadId: "forbidden", text: "Synthetic", model: "unassigned" })).rejects.toThrow("not assigned");
  await decorated.refreshModels?.();
  expect(engine.sent).toEqual([]);
});

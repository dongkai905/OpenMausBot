import { describe, expect, it } from "vitest";
import { instanceIcon, serverIconPreset } from "./provider-icon.ts";

describe("a server's mark comes from its host", () => {
  it.each([
    ["https://api.openai.com/v1", "openai"],
    ["https://eu.api.openai.com/v1", "openai"],
    ["https://my-team.openai.azure.com/openai/deployments/gpt-5", "azure"],
    ["https://my-team.services.ai.azure.com/models", "azure"],
    ["https://my-team.cognitiveservices.azure.com/openai/v1", "azure"],
    ["https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1", "aws"],
    ["https://generativelanguage.googleapis.com/v1beta/openai", "google"],
    ["https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/endpoints/openapi", "google"],
    ["https://openrouter.ai/api/v1", "openrouter"],
    ["https://api.anthropic.com/v1", "anthropic"],
  ])("%s shows %s", (url, preset) => {
    expect(serverIconPreset(url)).toBe(preset);
  });

  it("ignores the port, the scheme between http and https, letter case and a trailing dot", () => {
    expect(serverIconPreset("https://api.openai.com:443/v1")).toBe("openai");
    expect(serverIconPreset("https://api.openai.com:8443/v1")).toBe("openai");
    expect(serverIconPreset("http://api.openai.com/v1")).toBe("openai");
    expect(serverIconPreset("HTTPS://API.OPENAI.COM/v1")).toBe("openai");
    expect(serverIconPreset("https://api.openai.com./v1")).toBe("openai");
    expect(serverIconPreset("HTTPS://OPENROUTER.AI.:8443/api/v1")).toBe("openrouter");
  });

  it.each([
    "https://api.openai.com.evil.test/v1",
    "https://evil.test/api.openai.com/v1",
    "https://api.openai.com@evil.test/v1",
    "https://evil.test/v1?host=api.openai.com",
    "https://evil.test/#api.openai.com",
    "https://notopenrouter.ai/api/v1",
    "https://openrouter.ai.evil.test/api/v1",
    "https://my-team.openai.azure.com.evil.test/openai",
    "https://bedrock-runtime.us-east-1.amazonaws.com.evil.test/openai/v1",
    "https://bedrock-runtime.my-bucket.s3.amazonaws.com/openai/v1",
    "https://dashscope.aliyuncs.com.evil.test/compatible-mode/v1",
    "https://evil-dashscope.aliyuncs.com/compatible-mode/v1",
    "https://workspace-123.cn-beijing.maas.aliyuncs.com.evil.test/compatible-mode/v1",
    "https://workspace-123.cn-beijing.maas.aliyuncs.com@evil.test/v1",
    "https://evil.test/workspace-123.cn-beijing.maas.aliyuncs.com/v1",
    "https://evil.test/v1?host=workspace-123.cn-beijing.maas.aliyuncs.com",
    "https://extra.workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "https://cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "https://workspace-123.cn-beijing.other.aliyuncs.com/compatible-mode/v1",
    "https://api.x.ai.evil.test/v1",
  ])("never matches the look-alike %s", (url) => {
    expect(serverIconPreset(url)).toBeUndefined();
  });

  it.each([
    "http://127.0.0.1:11434/v1",
    "http://localhost:11434/v1",
    "http://localhost:1234/v1",
    "http://[::1]:8080/v1",
    "http://192.168.1.20:11434/v1",
    "https://api.groq.com/openai/v1",
    "https://api.together.xyz/v1",
    "https://api.fireworks.ai/inference/v1",
  ])("keeps the driver's mark for %s, which has no mark of its own", (url) => {
    expect(serverIconPreset(url)).toBeUndefined();
  });

  it("needs an http or https address", () => {
    expect(serverIconPreset("ftp://api.openai.com/v1")).toBeUndefined();
    expect(serverIconPreset("api.openai.com/v1")).toBeUndefined();
    expect(serverIconPreset("")).toBeUndefined();
  });
});

describe("an instance's mark", () => {
  const server = (url: unknown, extra: object = {}) => ({ driver: "openai-compat", config: { url, key: "sk-fixture" }, ...extra });

  it("is the mark of whoever runs an OpenAI-compatible server", () => {
    expect(instanceIcon(server("https://api.openai.com/v1"))).toEqual({ icon: { kind: "preset", preset: "openai" } });
    expect(instanceIcon(server("https://openrouter.ai/api/v1"))).toEqual({ icon: { kind: "preset", preset: "openrouter" } });
    expect(instanceIcon(server("https://api.anthropic.com/v1"))).toEqual({ icon: { kind: "preset", preset: "anthropic" } });
  });

  it("keeps a stored icon, preset or custom, over the server's", () => {
    const preset = { kind: "preset", preset: "openrouter" } as const;
    const custom = { kind: "custom", dataUrl: "data:image/png;base64,iVBORw0KGgo=" } as const;
    expect(instanceIcon(server("https://api.openai.com/v1", { icon: preset }))).toEqual({ icon: preset });
    expect(instanceIcon(server("https://api.openai.com/v1", { icon: custom }))).toEqual({ icon: custom });
    expect(instanceIcon(server("https://openrouter.ai/api/v1", { icon: custom }))).toEqual({ icon: custom });
    expect(instanceIcon({ driver: "claudeAgent", icon: preset })).toEqual({ icon: preset });
  });

  it("leaves the driver's own mark for an unknown or missing address and for other drivers", () => {
    expect(instanceIcon(server("https://llm.example.test/v1"))).toEqual({});
    expect(instanceIcon(server("http://127.0.0.1:1234/v1"))).toEqual({});
    expect(instanceIcon(server(42))).toEqual({});
    expect(instanceIcon({ driver: "openai-compat" })).toEqual({});
    expect(instanceIcon({ driver: "openai-compat", config: null })).toEqual({});
    expect(instanceIcon({ driver: "groq", config: { url: "https://api.openai.com/v1" } })).toEqual({});
    expect(instanceIcon(undefined)).toEqual({});
  });
});

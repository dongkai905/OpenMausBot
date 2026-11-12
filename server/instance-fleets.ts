// The engine instances a fresh install starts with, and the ones an existing product fleet gains.
// instanceConfigs (config.ts) copies every entry before it changes one.
//
// 步 6 / Task-135（路线 B 物理剥夺）：厂商专属引擎与厂商 API 车队已物理删除。
// 这里只剩通用 OpenAI 兼容端点；openai-compat 运行时本身属于下一刀的清理对象。
import type { InstanceConfigMap } from "./contracts.ts";

export const OPENAI_API_INSTANCE = "openai";
export const OPENROUTER_API_INSTANCE = "openrouter";

export const API_KEY_FLEET: InstanceConfigMap = {
  [OPENAI_API_INSTANCE]: {
    driver: "openai-compat", displayName: "OpenAI", access: "api", icon: { kind: "preset", preset: "openai" },
    config: { url: "https://api.openai.com/v1", apiKeyEnv: "OMB_OPENAI_API_KEY", catalog: "openai" },
  },
  [OPENROUTER_API_INSTANCE]: {
    driver: "openai-compat", displayName: "OpenRouter", access: "api", icon: { kind: "preset", preset: "openrouter" },
    config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "OMB_OPENROUTER_API_KEY" },
  },
};

export const DEFAULT_FLEET: InstanceConfigMap = {
  openaiCompat: { driver: "openai-compat" },
  ...API_KEY_FLEET,
};

/** Added to a saved fleet that holds a product engine, when it lacks them. */
export const PRODUCT_FLEET_ADDITIONS = {
  openaiCompat: { driver: "openai-compat" },
  ...API_KEY_FLEET,
} as const;

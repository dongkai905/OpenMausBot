// Pinned base URLs: a catalog refresh can never change where a newly pasted key for a recommended provider is sent.

export type AnthropicAuth = "bearer" | "x-api-key";

export interface AnthropicEndpoint {
  /** Claude Code's ANTHROPIC_BASE_URL; Claude Code adds /v1/messages. */
  baseUrl: string;
  /** A fixed auth style. Absent: the check decides, preferring Bearer. */
  auth?: AnthropicAuth;
  doc?: string;
}


export interface ProviderPreset {
  id: string;
  catalogId?: string;
  label: string;
  recommended?: number;
  /** OpenAI-compatible base URL. Wins over models.dev's `api`. */
  api: string;
  /** For when models.dev's `npm` is for a different endpoint (MiniMax: its Anthropic one). */
  npm?: string;
  env?: string;
  doc?: string;
  anthropic?: AnthropicEndpoint;
  /** Absent: Codex only as an experiment, and only if the check passes. */
  /** Path added to `api` for a GET that proves the key (a 2xx means it works). */
  keyCheck?: string;
  /** GET {api}/models answers without a key, so it proves nothing about one. */
  publicModels?: true;
  chat?: "after-check";
  /** Last checked by hand (YYYY-MM-DD). */
  checkedAt: string;
}

const CHECKED = "2026-09-30";

export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [];

const BY_ID = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));

export function providerPreset(id: string): ProviderPreset | undefined {
  return BY_ID.get(id);
}

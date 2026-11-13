import type { NewBotDefaults, BotDefaultsProfile } from "../../shared/new-bot-defaults";
import { api, type Bot, type ModelSelection } from "@/state/store";
import type { BotUpdatePatch } from "@/state/bot-patch-queue";
import type { ChosenPreset } from "./bot-presets";
import { t } from "@/lib/i18n";
import { randomUuid } from "./random-uuid";

export const EMPTY_BOT_DEFAULTS: NewBotDefaults = { profile: {}, memory: {}, skills: [] };

export class BotCreationDraft {
  readonly id = `draft-${randomUuid()}`;
  template: NewBotDefaults;
  consent: Pick<BotUpdatePatch, "acknowledgeLocalAuto"> & { acknowledgePeerScope?: boolean } = {};
  preset?: ChosenPreset;
  role?: string;
  avatarFile?: File;
  private avatarObjectUrl?: string;

  constructor(defaults: NewBotDefaults, readonly changed: () => void, private network: typeof api = api) {
    this.template = structuredClone(defaults);
  }

  get bot(): Bot {
    const { computer, cwd, toolScope, ...profile } = this.template.profile;
    return {
      id: this.id, threadId: this.id, name: "", title: "", description: "", soul: "",
      color: "green", notifications: true, unread: false, messages: [],
      modelSelection: { instanceId: "", model: "" }, ...profile,
      computer: computer ?? undefined, cwd: cwd ?? undefined,
      toolScope: toolScope ?? undefined,
    };
  }

  patch(value: BotUpdatePatch & Partial<BotDefaultsProfile> & { acknowledgePeerScope?: boolean }) {
    const { acknowledgeLocalAuto, acknowledgePeerScope, applyToAllThreads: _all, keepThreadModels: _keep,
      autoApprove, ...profile } = value;
    if (acknowledgeLocalAuto !== undefined) this.consent.acknowledgeLocalAuto = acknowledgeLocalAuto;
    if (acknowledgePeerScope !== undefined) this.consent.acknowledgePeerScope = acknowledgePeerScope;
    if (autoApprove !== undefined && profile.approvalMode === undefined) profile.approvalMode = autoApprove ? "auto" : "ask";
    this.template.profile = { ...this.template.profile, ...profile };
    this.changed();
  }

  setModel(modelSelection: ModelSelection) { this.patch({ modelSelection }); }

  choosePreset(preset: ChosenPreset | undefined) {
    this.preset = preset;
    this.changed();
  }

  chooseRole(role: string | undefined) {
    this.role = role;
    this.changed();
  }

  export(): NewBotDefaults { return structuredClone(this.template); }

  uploadAvatar = async (file: File): Promise<string> => {
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) throw new Error(t("newBot.avatar.invalidType"));
    if (file.size > 10 * 1024 * 1024) throw new Error(t("newBot.avatar.tooLarge"));
    if (this.avatarObjectUrl) URL.revokeObjectURL(this.avatarObjectUrl);
    this.avatarFile = file;
    this.avatarObjectUrl = URL.createObjectURL(file);
    return this.avatarObjectUrl;
  };

  dispose() { if (this.avatarObjectUrl) URL.revokeObjectURL(this.avatarObjectUrl); }

  request: typeof api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const base = `/api/bots/${this.id}`;
    let result: unknown;
    if (path === base && method === "PATCH") {
      this.patch(body); result = { bot: this.bot };
    } else if (path === `${base}/soul` && method === "GET") {
      result = { soul: this.bot.soul, revision: "draft", bytes: new TextEncoder().encode(this.bot.soul).length, limit: 24000, file: "", drift: false };
    } else if (path === `${base}/skills` && method === "GET") {
      result = { skills: this.template.skills, staged: [] };
    } else if (path === `${base}/skills` && method === "POST") {
      const preview = await this.network<{ skills: NewBotDefaults["skills"] }>("/api/bot-defaults/skills/preview", { method: "POST", body: JSON.stringify(body) });
      const names = new Set(this.template.skills.map(skill => skill.name));
      if (preview.skills.some(skill => names.has(skill.name))) throw new Error(t("newBot.skillExists"));
      this.template.skills.push(...preview.skills); this.changed(); result = { installed: preview.skills };
    } else if (path.startsWith(`${base}/skills/`)) {
      const name = decodeURIComponent(path.slice(`${base}/skills/`.length));
      const skill = this.template.skills.find(skill => skill.name === name);
      if (!skill) throw new Error("No such draft skill");
      if (method === "GET") result = { text: skill.text };
      else if (method === "PATCH" && typeof body.enabled === "boolean") {
        skill.enabled = body.enabled; this.changed(); result = { ok: true };
      } else if (method === "DELETE") {
        this.template.skills = this.template.skills.filter(item => item !== skill); this.changed(); result = { ok: true };
      } else throw new Error("Unsupported draft skill operation");
    } else if (path === `${base}/avatar/generate` && method === "POST") {
      const { name, title, description } = this.bot;
      const { dataUrl } = await this.network<{ dataUrl: string }>("/api/bot-defaults/avatar", {
        method: "POST", body: JSON.stringify({ profile: { name, title, description }, prompt: body.prompt }),
      });
      const blob = await (await fetch(dataUrl)).blob();
      const avatarUrl = await this.uploadAvatar(new File([blob], "avatar.png", { type: blob.type }));
      result = { avatarUrl, bot: { ...this.bot, avatarUrl, avatarCrop: "circle" } };
    } else throw new Error("This operation requires a created bot");
    return result as T;
  };
}

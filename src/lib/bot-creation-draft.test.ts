import { describe, expect, it, vi } from "vitest";
import { BotCreationDraft, EMPTY_BOT_DEFAULTS } from "./bot-creation-draft";
import { api } from "@/state/store";

describe("isolated creation draft", () => {
  it("clears a selection without exposing a malformed null bot status", async () => {
    const draft = new BotCreationDraft({ ...EMPTY_BOT_DEFAULTS, profile: { toolScope: { allow: [] } } }, vi.fn());
    expect(draft.bot).toHaveProperty("toolScope", { allow: [] });
    await draft.request(`/api/bots/${draft.id}`, { method: "PATCH", body: JSON.stringify({ toolScope: null }) });
    expect(draft.bot.toolScope).toBeUndefined();
    expect(draft.export().profile.toolScope).toBeNull();
  });
  it("keeps profile edits local until commitment", async () => {
    const network = vi.fn();
    const draft = new BotCreationDraft(EMPTY_BOT_DEFAULTS, vi.fn(), network as typeof api);
    draft.patch({ name: "Ada", approvalMode: "full", applyToAllThreads: true });
    expect(draft.consent).toEqual({});
    const template = draft.export();
    expect(network).not.toHaveBeenCalled();
    expect(template.profile).toEqual({ name: "Ada", approvalMode: "full" });
    draft.dispose();
    expect(network).not.toHaveBeenCalled();
  });

  it("makes an independent copy of the defaults for every draft", () => {
    const defaults = { ...EMPTY_BOT_DEFAULTS, profile: { name: "Default" } };
    const first = new BotCreationDraft(defaults, vi.fn());
    const second = new BotCreationDraft(defaults, vi.fn());
    first.patch({ name: "Changed" });
    expect(defaults.profile.name).toBe("Default");
    expect(second.bot.name).toBe("Default");
    expect(first.id).not.toBe(second.id);
  });

  it("refuses unsupported and cross-bot operations rather than reaching the live API", async () => {
    const network = vi.fn();
    const draft = new BotCreationDraft(EMPTY_BOT_DEFAULTS, vi.fn(), network as typeof api);
    for (const path of ["/api/bots/real-bot", `/api/bots/${draft.id}/messages`, "/api/routines/real-id"]) {
      await expect(draft.request(path, { method: "POST" })).rejects.toThrow();
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("imports a preview without installing it, and enables only the reviewed draft copy", async () => {
    const skill = { name: "fixture", description: "Fixture", source: "example/fixture", warnings: [], text: "synthetic", enabled: false };
    const network = vi.fn().mockResolvedValue({ skills: [skill] });
    const draft = new BotCreationDraft(EMPTY_BOT_DEFAULTS, vi.fn(), network as typeof api);
    await draft.request(`/api/bots/${draft.id}/skills`, { method: "POST", body: JSON.stringify({ source: skill.source }) });
    expect(network).toHaveBeenCalledWith("/api/bot-defaults/skills/preview", expect.anything());
    expect(draft.template.skills[0].enabled).toBe(false);
    await draft.request(`/api/bots/${draft.id}/skills/fixture`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    expect(network).toHaveBeenCalledTimes(1);
    expect(draft.export().skills[0].enabled).toBe(true);
  });
});

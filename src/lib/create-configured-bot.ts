import { api, desktopApprovalBridge, persistBotUpdate, persistTaskApproval, type Bot } from "@/state/store";
import type { BotCreationDraft } from "./bot-creation-draft";
import { imageAttachmentFromFile } from "./composer-attachments";
import type { BotVisibility } from "../../shared/wire";
import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar";
import { t } from "@/lib/i18n";

export async function preparedBotTemplate(draft: BotCreationDraft) {
  const template = draft.export();
  if (template.profile.avatarUrl?.startsWith("blob:")) {
    if (!draft.avatarFile) throw new Error(t("newBot.avatar.chooseAgain"));
    const uploaded = await imageAttachmentFromFile(draft.avatarFile);
    const avatarUrl = uploaded && botAvatarUrlFromStoredPath(uploaded.path);
    if (!avatarUrl) throw new Error(t("newBot.avatar.storeFailed"));
    template.profile.avatarUrl = avatarUrl;
  }
  return template;
}

/** File setup and native consent finish before a Chief handover can affect other work. */
export async function createConfiguredBot(
  draft: BotCreationDraft,
  request: typeof api = api,
  update: typeof persistBotUpdate = persistBotUpdate,
  approvals = desktopApprovalBridge(),
  visibility?: BotVisibility,
  reportsTo?: string,
): Promise<{ bot: Bot; warnings: string[]; paused?: true }> {
  const template = await preparedBotTemplate(draft);
  const { chiefOfStaff, managedSections, toolScope, modelSelection, ...profile } = template.profile;
  if (!profile.name?.trim()) throw new Error(t("newBot.nameRequired"));
  const preset = draft.preset;
  const chosenAi = modelSelection?.instanceId && modelSelection.model ? { modelSelection, requireAvailableModel: true } : {};
  const response = await request<{ bot: Bot; paused?: true }>("/api/bots", {
    method: "POST", body: JSON.stringify({ name: profile.name, title: profile.title,
      description: profile.description, ...chosenAi, section: profile.section,
      useDefaults: false, ...(visibility !== undefined ? { visibility } : {}), ...(reportsTo ? { reportsTo } : {}),
      ...(Object.hasOwn(template.profile, "toolScope") ? { settings: { toolScope } } : {}),
      ...(preset ? { preset: preset.id } : {}) }),
  });
  let bot = response.bot;
  const warnings: string[] = [];
  try {
    const patched = await update(bot.id, { ...profile, ...draft.consent }, new AbortController().signal,
      request, approvals, bot);
    bot = { ...bot, ...patched };
    if (profile.approvalMode === "full" || profile.approvalMode === "custom") {
      if (patched.approvalMode !== profile.approvalMode) {
        throw new Error(t("newBot.approvalNotGranted"));
      }
      const granted = await persistTaskApproval(bot.id, bot.threadId, {
        approvalMode: profile.approvalMode,
        acknowledgeLocalAuto: draft.consent.acknowledgeLocalAuto === true,
      }, approvals, request);
      if (granted.approvalMode !== profile.approvalMode) {
        throw new Error(t("newBot.threadApprovalNotGranted"));
      }
    }
    for (const skill of template.skills) {
      if (preset?.skills.includes(skill.name)) continue;
      await request(`/api/bots/${bot.id}/skill-template`, { method: "POST", body: JSON.stringify(skill) });
    }
  } catch (error) {
    const cleanup: string[] = [];
    try { await request(`/api/bots/${bot.id}`, { method: "DELETE" }); }
    catch { cleanup.push(`bot ${bot.name} (${bot.id})`); }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(cleanup.length ? `${message}. Cleanup failed for ${cleanup.join(", ")}; remove them before retrying.` : message);
  }
  // Creation is complete: never undo a Chief handover, or invite a duplicate retry.
  if (chiefOfStaff) {
    try {
      const result = await request<{ bot: Bot }>(`/api/bots/${bot.id}`, {
        method: "PATCH", body: JSON.stringify({ chiefOfStaff, managedSections, acknowledgePeerScope: true }),
      });
      bot = { ...bot, ...result.bot };
    } catch (error) {
      warnings.push(t("newBot.warning.chiefOfStaff", { error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { bot, warnings, ...(response.paused ? { paused: true as const } : {}) };
}
